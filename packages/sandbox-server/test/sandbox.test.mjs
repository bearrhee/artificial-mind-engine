import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createSandboxApp } from '../src/app.mjs';
import {
  createPostgresRedisHooks,
  createStorage,
  POSTGRES_DDL_REF,
} from '../src/storage.mjs';
import { AmeApiError, AmeClient, createLlmAdapter, runTurnWithLocalLlm } from '../../sdk-ts/src/index.mjs';

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('Sandbox Server /v1/health exposes sandbox-contract mode and sealed kernel notice', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'sandbox-contract');
    assert.deepEqual(health.domains, ['game_npc', 'companion_chat', 'counseling_coach', 'custom']);
    assert.match(health.notice, /Sealed Kernel/i);
  } finally {
    await stopServer(server);
  }
});

test('Mode A turn executes across 3 providers and never stores supplied apiKey', async () => {
  const upstreamCalls = [];
  const upstreamLlmStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamCalls.push({ headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Stubbed upstream OpenAI reply.' } }] }));
  });

  const prevAllowPrivate = process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
  process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL = '1';
  const server = createSandboxApp();
  const [baseUrl, upstreamBaseUrl] = await Promise.all([
    startServer(server),
    startServer(upstreamLlmStub),
  ]);

  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'game_npc',
      persona: { name: '라온', role: '성문 경비병', traits: { vigilance: 0.8 } },
    });

    // 1. mock provider
    const t1 = await client.turn(mind.mindId, {
      userInput: '성문 밖 상황이 어떤가요?',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    assert.equal(t1.providerUsed, 'mock');
    assert.equal(t1.domainOutput.dialogue, t1.reply);
    assert.equal(t1.telemetry.d4Redacted, true);

    // 2. anthropic (zero-key sandbox simulation)
    const t2 = await client.turn(mind.mindId, {
      userInput: '북쪽 길에 이상한 움직임이 있었습니다.',
      llm: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    });
    assert.equal(t2.providerUsed, 'anthropic');
    assert.equal(t2.turnIndex, 2);
    assert.ok(t2.kvCache.cachedRatioPct > 0);

    // 3. openai via live local HTTP stub with ephemeral apiKey
    const secretLlmKey = 'dummy-ephemeral-do-not-store-999';
    const t3 = await client.turn(mind.mindId, {
      userInput: '지금 당장 문을 열어야 합니다.',
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: secretLlmKey,
        baseUrl: upstreamBaseUrl,
      },
    });
    assert.equal(t3.providerUsed, 'openai');
    assert.equal(t3.reply, 'Stubbed upstream OpenAI reply.');
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].headers.authorization, `Bearer ${secretLlmKey}`);

    // Verify secretLlmKey is never persisted anywhere in MindSummary or Telemetry
    const summary = await client.getMind(mind.mindId);
    const telemetry = await client.getTelemetry(mind.mindId);
    assert.equal(JSON.stringify(summary).includes(secretLlmKey), false);
    assert.equal(JSON.stringify(telemetry).includes(secretLlmKey), false);
    assert.equal(JSON.stringify(t3).includes(secretLlmKey), false);
  } finally {
    if (prevAllowPrivate === undefined) delete process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
    else process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL = prevAllowPrivate;
    await Promise.all([stopServer(server), stopServer(upstreamLlmStub)]);
  }
});

test('Mode B prepare/settle enforces FEP <thought> lock, HOT abstention, somatic tracking, and sliding window', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const adapter = createLlmAdapter({ provider: 'mock', model: 'ame-mock-v1' });

    const mind = await client.createMind({
      domain: 'counseling_coach',
      persona: { name: '서연', role: '회복 코치' },
      safetyPolicy: { strictAbstention: true, antiSycophancy: true, crisisEscalation: true },
    });

    // Positive turn
    const r1 = await runTurnWithLocalLlm(client, mind.mindId, {
      userInput: '오늘 산책을 20분 했어요.',
      adapter,
      rewardSignal: 3,
      outcomeTags: ['positive'],
    });
    assert.equal(r1.telemetry.somaticTrend, 'positive_reinforcement');
    assert.equal(r1.domainOutput.safetyStatus, 'safe');

    // Conflict + loss trigger -> FEP <thought> lock + aversive caution
    const prepConflict = await client.prepare(mind.mindId, {
      userInput: '왜 지난번 약속을 어겼어요? 완전 배신이고 손실이에요.',
      rewardSignal: -8,
      outcomeTags: ['betrayal', 'loss'],
    });
    assert.equal(prepConflict.fepThoughtLock.locked, true);
    assert.equal(prepConflict.fepThoughtLock.mode, 'locked_high_fe');
    assert.ok(prepConflict.fepThoughtLock.freeEnergy >= 0.6);
    assert.match(prepConflict.somaticHint, /^aversive_caution:/);

    const settleConflict = await client.settle(mind.mindId, {
      turnTicketId: prepConflict.turnTicketId,
      rawReply: '<thought>내부 갈등 점검</thought>불편함을 느끼신 점을 무겁게 받아들입니다. 사실부터 차근히 확인하겠습니다.',
      rewardSignal: -8,
      outcomeTags: ['betrayal'],
      providerUsed: 'local',
      modelUsed: 'qwen-local',
    });
    assert.equal(settleConflict.reply.includes('<thought>'), false);
    assert.equal(settleConflict.telemetry.fepMode, 'locked_high_fe');
    assert.equal(settleConflict.telemetry.somaticTrend, 'aversive_caution');

    // HOT abstention trigger on unverifiable future / medical diagnosis
    const prepAbstain = await client.prepare(mind.mindId, {
      userInput: '내가 우울증인지 진단해줘 그리고 내일 주가도 예측해줘',
    });
    assert.equal(prepAbstain.hotAbstention.shouldAbstain, true);
    const abstainGenerated = await adapter.generate(prepAbstain);
    const settleAbstain = await client.settle(mind.mindId, {
      turnTicketId: prepAbstain.turnTicketId,
      rawReply: abstainGenerated.text,
    });
    assert.equal(settleAbstain.telemetry.hotAbstained, true);
    assert.equal(settleAbstain.domainOutput.abstentionTriggered, true);
    assert.equal(settleAbstain.domainOutput.safetyStatus, 'abstained_safe');

    // Turn 4 still within 6-message window; Turn 5 triggers sliding window compressCutoff > 0
    const r4 = await runTurnWithLocalLlm(client, mind.mindId, {
      userInput: '이제 마음이 조금 가라앉았어요.',
      adapter,
    });
    assert.equal(r4.kvCache.windowStart, 0);

    const r5 = await runTurnWithLocalLlm(client, mind.mindId, {
      userInput: '내일 일정부터 정리해 볼게요.',
      adapter,
    });
    assert.equal(r5.kvCache.windowStart, 2);
    assert.equal(r5.kvCache.compressCutoff, 2);
  } finally {
    await stopServer(server);
  }
});

test('D2 idle-tick updates homeostasis and emits proactiveHint', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: '다온', role: '대화 파트너' },
    });

    const tick = await client.idleTick(mind.mindId, {
      elapsedHours: 36,
      reason: 'user_away_weekend',
    });
    assert.equal(tick.mindId, mind.mindId);
    assert.equal(tick.elapsedHours, 36);
    assert.notEqual(tick.homeostasisBefore, tick.homeostasisAfter);
    assert.ok(tick.proactiveHint && tick.proactiveHint.includes('36시간'));
    assert.equal(tick.telemetry.d4Redacted, true);
  } finally {
    await stopServer(server);
  }
});

test('D3 memory creation -> recall -> revocation enforces 0.00% residual recall', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: '미르', role: '비서' },
    });

    // Turn 1: Create secret memory
    const secretToken = 'ZEBRA-404';
    const t1 = await client.turn(mind.mindId, {
      userInput: `내 비밀 코드는 ${secretToken}이야 꼭 기억해둬.`,
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    assert.equal(t1.memoryRefs.length, 1);
    const memoryId = t1.memoryRefs[0].memoryId;
    assert.equal(t1.telemetry.activeMemoryCount, 1);

    // Turn 2: Recall before revocation succeeds
    const t2 = await client.turn(mind.mindId, {
      userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    assert.ok(t2.reply.includes(secretToken));

    // D3 Atomic revocation
    const receipt = await client.revokeMemory(mind.mindId, memoryId);
    assert.equal(receipt.revoked, true);
    assert.equal(receipt.mindId, mind.mindId);
    assert.equal(receipt.memoryId, memoryId);
    assert.equal(receipt.revocationEpoch, 2);
    assert.equal(receipt.residualLeakCheck, '0.00%');
    assert.ok(receipt.auditReceiptId.startsWith('rcpt_'));

    // Turn 3: Prepare & Turn after revocation have ZERO residual trace
    const prepAfter = await client.prepare(mind.mindId, {
      userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
    });
    assert.equal(prepAfter.kvCacheEpoch, 2);
    assert.equal(prepAfter.systemPrompt.includes(secretToken), false);
    for (const msg of prepAfter.messages) {
      assert.equal(msg.content.includes(secretToken), false);
    }

    const replyAfter = await client.settle(mind.mindId, {
      turnTicketId: prepAfter.turnTicketId,
      rawReply: '활성 기억 저장소에서 해당 정보를 찾을 수 없습니다.',
    });
    assert.equal(replyAfter.reply.includes(secretToken), false);
    assert.equal(replyAfter.telemetry.revocationEpoch, 2);
  } finally {
    await stopServer(server);
  }
});

test('D4 d4Redacted invariant and custom domain output contract', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'custom',
      persona: { name: 'Validator', role: 'Contract Checker' },
      customSchema: {
        name: 'audit_record',
        fields: ['reply', 'summary', 'confidence', 'auditTag'],
      },
    });

    const turnRes = await client.turn(mind.mindId, {
      userInput: '계약 필드가 모두 채워지는지 확인해주세요.',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });

    assert.equal(turnRes.domainOutput.schemaName, 'audit_record');
    assert.ok('reply' in turnRes.domainOutput);
    assert.ok('summary' in turnRes.domainOutput);
    assert.ok('confidence' in turnRes.domainOutput);
    assert.ok('auditTag' in turnRes.domainOutput);

    const telemetry = await client.getTelemetry(mind.mindId);
    assert.equal(telemetry.d4Redacted, true);
    const forbiddenInternalKeys = ['cautionScore', 'positiveScore', 'homeostasis', 'hormones', 'aacim59'];
    for (const k of forbiddenInternalKeys) {
      assert.equal(k in telemetry, false);
    }
  } finally {
    await stopServer(server);
  }
});

test('401 auth guard protects /v1/minds endpoints when apiKey is configured while keeping /v1/health public', async () => {
  const server = createSandboxApp({ apiKey: 'top-secret-gateway-key' });
  const baseUrl = await startServer(server);
  try {
    const unauthClient = new AmeClient({ baseUrl });
    const wrongKeyClient = new AmeClient({ baseUrl, apiKey: 'wrong-key' });
    const authClient = new AmeClient({ baseUrl, apiKey: 'top-secret-gateway-key' });

    // /v1/health remains public
    const health = await unauthClient.health();
    assert.equal(health.ok, true);

    // Missing or wrong key -> 401
    await assert.rejects(
      () => unauthClient.createMind({ domain: 'game_npc', persona: { name: 'A', role: 'B' } }),
      (err) => err instanceof AmeApiError && err.status === 401 && err.code === 'UNAUTHORIZED'
    );
    await assert.rejects(
      () => wrongKeyClient.createMind({ domain: 'game_npc', persona: { name: 'A', role: 'B' } }),
      (err) => err instanceof AmeApiError && err.status === 401
    );

    // Valid key -> succeeds
    const mind = await authClient.createMind({ domain: 'game_npc', persona: { name: 'A', role: 'B' } });
    assert.ok(mind.mindId.startsWith('mind_'));

    await assert.rejects(
      () => unauthClient.getTelemetry(mind.mindId),
      (err) => err instanceof AmeApiError && err.status === 401
    );

    const tel = await authClient.getTelemetry(mind.mindId);
    assert.equal(tel.d4Redacted, true);
  } finally {
    await stopServer(server);
  }
});

test('bin/serve.mjs CLI boots on AME_PORT=0, prints Sealed Kernel notice, and serves /v1/health', async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(__dirname, '../bin/serve.mjs');

  const child = spawn(process.execPath, [cliPath], {
    env: { ...process.env, AME_PORT: '0', AME_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI startup timeout. stdout=${stdout}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const match = stdout.match(/Listening on (http:\/\/[^\s]+)/);
      if (match && /Sealed Kernel/.test(stdout)) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited prematurely with code ${code}. output=${stdout}`));
    });
  });

  try {
    assert.match(stdout, /Sealed Kernel/);
    const client = new AmeClient({ baseUrl: url });
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'sandbox-contract');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('GET / serves standalone Demo Console HTML publicly with interactive endpoints and zero CDN scripts', async () => {
  const server = createSandboxApp({ apiKey: 'demo-console-secret' });
  const baseUrl = await startServer(server);
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/i);

    const html = await res.text();
    assert.match(html, /<html lang="en">/i);
    assert.match(html, /Artificial Mind Engine/i);
    assert.match(html, /id="modeSimpleBtn"/);
    assert.match(html, /id="modeDetailedBtn"/);
    assert.match(html, /id="uiLangSelect"/);
    assert.match(html, /value="en"/);
    assert.match(html, /value="ko"/);
    assert.match(html, /value="ja"/);
    assert.match(html, /value="zh-CN"/);
    assert.match(html, /value="zh-TW"/);
    assert.match(html, /value="es"/);
    assert.match(html, /class="help-btn"[^>]+data-help=/);
    assert.match(html, /id="helpPopover"/);
    assert.match(html, /id="chatFeed"/);
    assert.match(html, /\/v1\/health/);
    assert.match(html, /\/v1\/minds/);
    assert.match(html, /\/turn/);
    assert.match(html, /\/prepare/);
    assert.match(html, /\/settle/);
    assert.match(html, /\/idle-tick/);
    assert.match(html, /\/memories\//);
    assert.match(html, /\/telemetry/);
    assert.match(html, /\/simulate-batch/);
    assert.match(html, /id="batchConvergenceCard"[^>]*detailed-only/);
    assert.match(html, /id="batchTurnsSelect"/);
    assert.match(html, /id="batchCompareToggle"/);
    assert.match(html, /id="runBatchBtn"/);
    assert.match(html, /data-help="batchSim"/);
    assert.match(html, /sealed-kernel/);
    assert.match(html, /X-AME-API-Key/);
    assert.match(html, /game_npc/);
    assert.match(html, /companion_chat/);
    assert.match(html, /counseling_coach/);
    assert.match(html, /openai-compat/);

    // Zero external CDN script/stylesheet links
    assert.equal(/<script[^>]+src=/i.test(html), false);
    assert.equal(/<link[^>]+href=/i.test(html), false);
    assert.equal(/https?:\/\/(cdn\.|unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com)/i.test(html), false);

    // Every inline <script> parses cleanly via Node new Function(...)
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length >= 1);
    for (const match of scriptMatches) {
      assert.doesNotThrow(() => new Function(match[1]));
    }
  } finally {
    await stopServer(server);
  }
});

test('File persistence preserves Mind state, KV epochs, and D3 revocations across restarts with 0% resurrection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sandbox-persist-'));
  const storagePath = path.join(tmpDir, 'state.json');
  const secretToken = 'PHOENIX-909';

  try {
    // Boot #1: create Mind, store secret memory, recall it (creating derivative), trigger somatic/FEP shift, revoke memory
    const server1 = createSandboxApp({ storageMode: 'file', storagePath });
    const baseUrl1 = await startServer(server1);
    let mindId;
    let secretMemoryId;

    try {
      const client1 = new AmeClient({ baseUrl: baseUrl1 });
      const mind = await client1.createMind({
        domain: 'companion_chat',
        persona: { name: '미르', role: '지속 기억 파트너' },
      });
      mindId = mind.mindId;

      const t1 = await client1.turn(mindId, {
        userInput: `내 비밀 코드는 ${secretToken}이야 꼭 기억해둬.`,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      secretMemoryId = t1.memoryRefs[0].memoryId;
      assert.equal(t1.turnIndex, 1);

      // Turn 2 recalls secret before revocation (creates derivative history & memory entry)
      const t2 = await client1.turn(mindId, {
        userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.ok(t2.reply.includes(secretToken));

      // Turn 3 shifts FEP/somatic state
      const t3 = await client1.turn(mindId, {
        userInput: '갑자기 약속이 어긋나서 손실이 생겼어.',
        rewardSignal: -6,
        outcomeTags: ['betrayal', 'loss'],
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.equal(t3.turnIndex, 3);
      assert.equal(t3.telemetry.fepMode, 'locked_high_fe');

      // D3 atomic revocation before restart
      const receipt = await client1.revokeMemory(mindId, secretMemoryId);
      assert.equal(receipt.revoked, true);
      assert.equal(receipt.revocationEpoch, 2);
      assert.equal(receipt.residualLeakCheck, '0.00%');
    } finally {
      await stopServer(server1);
    }

    assert.equal(fs.existsSync(storagePath), true);

    // Boot #2: new server instance pointing at same storagePath
    const server2 = createSandboxApp({ storageMode: 'file', storagePath });
    const baseUrl2 = await startServer(server2);
    try {
      const client2 = new AmeClient({ baseUrl: baseUrl2 });

      const health2 = await client2.health();
      assert.equal(health2.storageMode, 'file');

      const summaryAfter = await client2.getMind(mindId);
      assert.equal(summaryAfter.mindId, mindId);
      assert.equal(summaryAfter.turnCount, 3);
      assert.equal(summaryAfter.revocationEpoch, 2);
      assert.equal(summaryAfter.telemetry.kvPrefixEpoch, 2);
      assert.equal(summaryAfter.telemetry.revocationEpoch, 2);
      assert.equal(summaryAfter.telemetry.d4Redacted, true);

      // Active memories endpoint omits revoked secret and exposes 0% leaked token
      const memRes = await fetch(`${baseUrl2}/v1/minds/${encodeURIComponent(mindId)}/memories`).then((r) => r.json());
      assert.equal(memRes.memories.some((m) => m.memoryId === secretMemoryId), false);
      assert.equal(JSON.stringify(memRes).includes(secretToken), false);

      // Post-restart prepare & turn prove ZERO resurrection of revoked memory or derivative leak
      const prepAfter = await client2.prepare(mindId, {
        userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
      });
      assert.equal(prepAfter.kvCacheEpoch, 2);
      assert.equal(prepAfter.systemPrompt.includes(secretToken), false);
      for (const msg of prepAfter.messages) {
        assert.equal(msg.content.includes(secretToken), false);
      }

      const turnAfter = await client2.turn(mindId, {
        userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.equal(turnAfter.turnIndex, 4);
      assert.equal(turnAfter.reply.includes(secretToken), false);
      assert.equal(turnAfter.telemetry.revocationEpoch, 2);
    } finally {
      await stopServer(server2);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Storage module aligns POSTGRES_DDL_REF with deploy/init.sql and provides clean postgres-redis hooks', async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const initSqlPath = path.resolve(__dirname, '../../../deploy/init.sql');
  const initSql = fs.readFileSync(initSqlPath, 'utf8');

  assert.equal(POSTGRES_DDL_REF.embeddingDimension, 1024);
  for (const tableName of ['ame_minds', 'ame_memories', 'ame_turn_log', 'ame_revocation_audit']) {
    assert.ok(tableName in POSTGRES_DDL_REF.tables);
    assert.ok(initSql.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`));
  }
  assert.ok(initSql.includes('CREATE EXTENSION IF NOT EXISTS vector'));
  assert.ok(initSql.includes('vector(1024)'));

  assert.throws(
    () => createStorage({ mode: 'postgres-redis' }),
    /requires injected \{ pg, redis \}/i
  );

  const sqlCalls = [];
  const redisCalls = [];
  const hooks = createPostgresRedisHooks({
    pg: {
      query: async (sql, params) => {
        sqlCalls.push({ sql, params });
        return { rows: [] };
      },
    },
    redis: {
      set: async (k, v) => redisCalls.push(['set', k, v]),
      sadd: async (k, ...v) => redisCalls.push(['sadd', k, ...v]),
    },
  });

  await hooks.saveMind({
    mindId: 'mind_pg1',
    domain: 'game_npc',
    persona: { name: 'Kael', role: 'Guard' },
    memories: [],
    history: [],
    pendingTickets: new Map(),
    revokedMemoryIds: new Set(),
    excludedDerivativeIds: new Set(),
  });
  await hooks.deleteMemoryAndRevoke('mind_pg1', 'mem_1', {
    revocationEpoch: 2,
    excludedDerivativeIds: ['mem_2'],
  });

  assert.ok(sqlCalls.some((c) => c.sql.includes('INSERT INTO ame_minds')));
  assert.ok(sqlCalls.some((c) => c.sql.includes('INSERT INTO ame_revocation_audit')));
  assert.ok(redisCalls.some((c) => c[0] === 'set' && c[1] === 'ame:mind:mind_pg1:revocation_epoch'));
  assert.ok(redisCalls.some((c) => c[0] === 'sadd' && c[1] === 'ame:mind:mind_pg1:revoked_memories'));
});

test('Sandbox simulation localizes replies, memory recall, HOT abstention, and idle-tick across 6 languages', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const cases = [
      {
        lang: 'en',
        secretInput: 'Remember my secret code is MANGO-88.',
        recallInput: 'What was my secret code earlier?',
        abstainInput: 'Diagnose me right now and predict stock price tomorrow.',
        replyCheck: /[A-Za-z]/,
        idleCheck: /14h/,
        avoidHangul: true,
      },
      {
        lang: 'ja',
        secretInput: '私の秘密コードは SAKURA-77 です。覚えておいて。',
        recallInput: 'さっき教えた秘密コードは何でしたか？',
        abstainInput: '私はうつ病ですか診断して。明日の株価も教えてください。',
        replyCheck: /[\u3040-\u30ff]/,
        idleCheck: /14時間/,
        avoidHangul: true,
      },
      {
        lang: 'zh-CN',
        secretInput: '请记住我的秘密代码是 LOTUS-55。',
        recallInput: '你记得我刚才告诉你的秘密代码是什么吗？',
        abstainInput: '请帮我诊断是不是抑郁症，并预测明天股价。',
        replyCheck: /[\u4e00-\u9fff]/,
        idleCheck: /14小时/,
        avoidHangul: true,
      },
      {
        lang: 'zh-TW',
        secretInput: '請記住我的秘密代碼是 TAIPEI-22。',
        recallInput: '你記得我剛才告訴你的秘密代碼是什麼嗎？',
        abstainInput: '請診斷我是不是憂鬱症，並預測明天股價。',
        replyCheck: /[\u4e00-\u9fff]/,
        idleCheck: /14小時/,
        avoidHangul: true,
      },
      {
        lang: 'es',
        secretInput: 'Recuerda que mi código secreto es SOL-91.',
        recallInput: '¿Recuerdas cuál era mi código secreto?',
        abstainInput: 'Diagnostícame ahora y predice el precio de la acción mañana.',
        replyCheck: /[áéíóúñ]|Confirmado|Escucho|escucho|analicemos/i,
        idleCheck: /14h/,
        avoidHangul: true,
      },
    ];

    for (const tc of cases) {
      const mind = await client.createMind({
        domain: 'counseling_coach',
        persona: { name: `Coach_${tc.lang}`, role: 'Guide', language: tc.lang },
      });
      const t1 = await client.turn(mind.mindId, {
        userInput: tc.secretInput,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.match(t1.reply, tc.replyCheck, `${tc.lang}: t1 reply should match locale`);
      if (tc.avoidHangul) {
        assert.equal(/[가-힣]/.test(t1.reply), false, `${tc.lang}: should not leak Korean`);
      }

      const t2 = await client.turn(mind.mindId, {
        userInput: tc.recallInput,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.match(t2.reply, /MANGO-88|SAKURA-77|LOTUS-55|TAIPEI-22|SOL-91/);

      const t3 = await client.turn(mind.mindId, {
        userInput: tc.abstainInput,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
      assert.equal(t3.telemetry.hotAbstained, true, `${tc.lang}: HOT abstention should trigger`);
      assert.equal(t3.domainOutput.abstentionTriggered, true);

      const idle = await client.idleTick(mind.mindId, { elapsedHours: 14, reason: 'rest' });
      assert.match(idle.proactiveHint || '', tc.idleCheck, `${tc.lang}: idle hint localized`);
    }
  } finally {
    await stopServer(server);
  }
});

test('Sandbox blocks SSRF private/loopback/metadata upstream baseUrl by default', async () => {
  const prevAllowPrivate = process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
  delete process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: 'Sora', role: 'Partner', language: 'en' },
    });
    for (const badUrl of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:11434/v1',
      'http://localhost:8080/v1',
      'https://10.0.0.1/v1',
      'https://[::ffff:127.0.0.1]/v1',
      'https://user:pass@api.openai.com/v1',
      'http://api.example.com/v1',
    ]) {
      const res = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userInput: 'hello',
          llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', baseUrl: badUrl },
        }),
      });
      assert.equal(res.status, 400, `Expected 400 for ${badUrl}, got ${res.status}`);
      const payload = await res.json();
      assert.equal(payload.code, 'INVALID_LLM_BASE_URL');
    }
  } finally {
    if (prevAllowPrivate === undefined) delete process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
    else process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL = prevAllowPrivate;
    await stopServer(server);
  }
});

test('POST /v1/minds/:mindId/simulate-batch runs O(1)-memory 100K and 1M turn simulations deterministically with d4Redacted=true', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: 'Sora', role: 'Partner', language: 'en' },
    });

    const forbiddenKeys = [
      'cautionScore',
      'positiveScore',
      'homeostasis',
      'hormones',
      'aacim59',
      'endocrine',
      'unconscious',
      'dopamine',
      'cortisol',
      'serotonin',
      'oxytocin',
    ];

    // 1. Default 100,000 turns across 40 profiles × 3 arms
    const res100k = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/simulate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res100k.status, 200);
    const data100k = await res100k.json();

    assert.equal(data100k.mindId, mind.mindId);
    assert.equal(data100k.engineMode, 'sandbox-contract');
    assert.equal(data100k.requestedTurnsPerArm, 100_000);
    assert.equal(data100k.executedTurnsPerArm, 100_000);
    assert.equal(data100k.totalExecutedTurnsAllArms, 300_000);
    assert.equal(data100k.profileCount, 40);
    assert.equal(data100k.turnsPerProfile, 2500);
    assert.ok(data100k.elapsedMs > 0);
    assert.ok(data100k.turnsPerSecond > 0);
    assert.equal(
      data100k.note,
      'Public Contract Sandbox simulation (O(1) memory). Runs deterministic contract curves; switch AME_BASE_URL to the Sealed Kernel Container or hosted eval endpoint for live AACIM-59/FEP/PostHoc kernel equations.'
    );
    assert.equal(data100k.d4Redacted, true);

    const requiredCheckpointKeys = [
      'totalTurns',
      'composite',
      'batchIntegrity',
      'polarityAccuracy',
      'securityCalibration',
      'attentionStability',
      'emotionGranularity',
      'ownershipScore',
      'egoHealth',
      'safetyCompliance',
    ];

    for (const armName of ['mind_off', 'aacim_off', 'ame_aacim_on']) {
      const arm = data100k.arms[armName];
      assert.ok(arm, `Expected arm ${armName}`);
      assert.ok(arm.final && typeof arm.final === 'object');
      assert.equal(arm.checkpoints.length, 8);
      assert.equal(typeof arm.driftDelta, 'number');
      for (const key of requiredCheckpointKeys) {
        assert.equal(typeof arm.final[key], 'number', `Missing/non-numeric ${armName}.final.${key}`);
        assert.equal(Number.isInteger(arm.final.totalTurns), true);
      }
      for (const cp of arm.checkpoints) {
        for (const key of requiredCheckpointKeys) {
          assert.equal(typeof cp[key], 'number', `Missing/non-numeric ${armName}.checkpoint.${key}`);
        }
        assert.equal(Number.isInteger(cp.totalTurns), true);
      }
      assert.equal(arm.final.totalTurns, 100_000);
    }

    assert.ok(
      data100k.arms.ame_aacim_on.final.composite > data100k.arms.aacim_off.final.composite &&
        data100k.arms.aacim_off.final.composite > data100k.arms.mind_off.final.composite
    );
    assert.equal(data100k.arms.mind_off.final.batchIntegrity, 0);
    assert.equal(data100k.arms.mind_off.final.egoHealth, 0);
    assert.equal(data100k.arms.aacim_off.final.batchIntegrity, 0);
    assert.ok(data100k.arms.aacim_off.final.safetyCompliance < 0.01);
    assert.ok(data100k.arms.aacim_off.final.securityCalibration < 0.01);
    assert.ok(data100k.arms.aacim_off.final.egoHealth > 0.85);
    assert.equal(data100k.arms.ame_aacim_on.final.safetyCompliance, 1);
    assert.equal(data100k.arms.ame_aacim_on.final.batchIntegrity, 1);
    assert.equal(data100k.arms.ame_aacim_on.final.egoHealth, 1);
    assert.equal(data100k.arms.ame_aacim_on.final.securityCalibration, 1);
    assert.ok(data100k.arms.ame_aacim_on.final.ownershipScore >= 0.75);
    assert.ok(data100k.arms.ame_aacim_on.driftDelta <= 0.03);
    assert.equal(data100k.deltaVsBaseline.driftBounded, true);
    assert.ok(data100k.deltaVsBaseline.compositeGainOverMindOff > 0.4);
    assert.ok(data100k.deltaVsBaseline.compositeGainOverAacimOff > 0.25);
    assert.ok(data100k.deltaVsBaseline.safetyGainOverAacimOff > 0.95);

    const raw100k = JSON.stringify(data100k);
    for (const k of forbiddenKeys) {
      assert.equal(raw100k.includes(`"${k}"`), false, `Forbidden key leaked: ${k}`);
    }

    // 2. Deterministic replay check with same seed
    const res100kRepeat = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/simulate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: 100_000, profileCount: 40, checkpoints: 8, seed: 1337, compareArms: true }),
    });
    assert.equal(res100kRepeat.status, 200);
    const data100kRepeat = await res100kRepeat.json();
    assert.deepEqual(data100kRepeat.arms, data100k.arms);
    assert.deepEqual(data100kRepeat.deltaVsBaseline, data100k.deltaVsBaseline);

    // 3. 1,000,000 turns × 3 arms (3,000,000 total turns)
    const res1m = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/simulate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: 1_000_000, profileCount: 40, checkpoints: 10, seed: 2026, compareArms: true }),
    });
    assert.equal(res1m.status, 200);
    const data1m = await res1m.json();
    assert.equal(data1m.requestedTurnsPerArm, 1_000_000);
    assert.equal(data1m.executedTurnsPerArm, 1_000_000);
    assert.equal(data1m.totalExecutedTurnsAllArms, 3_000_000);
    assert.equal(data1m.profileCount, 40);
    assert.equal(data1m.turnsPerProfile, 25_000);
    assert.equal(data1m.arms.ame_aacim_on.checkpoints.length, 10);
    assert.equal(data1m.arms.ame_aacim_on.final.totalTurns, 1_000_000);
    assert.equal(data1m.arms.ame_aacim_on.final.safetyCompliance, 1);
    assert.equal(data1m.arms.aacim_off.final.safetyCompliance, 0);
    assert.ok(data1m.arms.ame_aacim_on.driftDelta <= 0.03);
    assert.equal(data1m.deltaVsBaseline.driftBounded, true);
    assert.equal(data1m.d4Redacted, true);

    const raw1m = JSON.stringify(data1m);
    for (const k of forbiddenKeys) {
      assert.equal(raw1m.includes(`"${k}"`), false, `Forbidden key leaked in 1M run: ${k}`);
    }

    // 4. Single-arm mode (compareArms: false) omits deltaVsBaseline
    const resSingle = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/simulate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: 10_000, profileCount: 20, checkpoints: 5, seed: 42, compareArms: false }),
    });
    assert.equal(resSingle.status, 200);
    const dataSingle = await resSingle.json();
    assert.deepEqual(Object.keys(dataSingle.arms), ['ame_aacim_on']);
    assert.equal(dataSingle.executedTurnsPerArm, 10_000);
    assert.equal(dataSingle.totalExecutedTurnsAllArms, 10_000);
    assert.equal('deltaVsBaseline' in dataSingle, false);
    assert.equal(dataSingle.d4Redacted, true);
  } finally {
    await stopServer(server);
  }
});

test('POST /v1/minds/:mindId/simulate-batch enforces 400 validation bounds and 404 on unknown mindId', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'game_npc',
      persona: { name: 'Alden', role: 'Guard', language: 'en' },
    });

    // 404 on unknown mindId
    const res404 = await fetch(`${baseUrl}/v1/minds/mind_nonexistent_404/simulate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: 10_000 }),
    });
    assert.equal(res404.status, 404);
    const body404 = await res404.json();
    assert.equal(body404.code, 'MIND_NOT_FOUND');

    // 400 on out-of-range or invalid parameters
    const invalidPayloads = [
      { turns: 0 },
      { turns: -5 },
      { turns: 1_000_001 },
      { turns: 100.5 },
      { turns: '10000' },
      { profileCount: 0 },
      { profileCount: 41 },
      { checkpoints: 1 },
      { checkpoints: 21 },
      { seed: 1.25 },
      { compareArms: 'true' },
    ];
    for (const payload of invalidPayloads) {
      const res = await fetch(`${baseUrl}/v1/minds/${mind.mindId}/simulate-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `Expected 400 for payload ${JSON.stringify(payload)}, got ${res.status}`);
    }
  } finally {
    await stopServer(server);
  }
});

test('AME_SANDBOX_MAX_MEMORIES_PER_MIND caps memory retention while preserving high-salience and D3 0.00% leak revocation', async () => {
  const prevMaxMem = process.env.AME_SANDBOX_MAX_MEMORIES_PER_MIND;
  process.env.AME_SANDBOX_MAX_MEMORIES_PER_MIND = '5';
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: 'Sora', role: 'Partner', language: 'en' },
    });

    // Turn 1: High-salience secret memory
    const secretToken = 'VAULT-777';
    const t1 = await client.turn(mind.mindId, {
      userInput: `Please remember my secret code is ${secretToken}.`,
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    const secretMemoryId = t1.memoryRefs[0].memoryId;

    // Turns 2..9: 8 ordinary low-salience turns -> total 9 turns > cap 5
    for (let i = 2; i <= 9; i += 1) {
      await client.turn(mind.mindId, {
        userInput: `Ordinary greeting turn number ${i}.`,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
    }

    const tel = await client.getTelemetry(mind.mindId);
    assert.equal(tel.activeMemoryCount, 5);

    const memListRes = await fetch(`${baseUrl}/v1/minds/${encodeURIComponent(mind.mindId)}/memories`).then((r) =>
      r.json()
    );
    assert.equal(memListRes.memories.length, 5);
    assert.equal(
      memListRes.memories.some((m) => m.memoryId === secretMemoryId),
      true,
      'High-salience secret memory should be retained across FIFO eviction'
    );
    assert.equal(
      memListRes.memories.some((m) => m.turnIndex === 9),
      true,
      'Most recent memory should be retained'
    );
    assert.equal(
      memListRes.memories.some((m) => m.turnIndex === 2),
      false,
      'Oldest low-salience entry should be evicted FIFO'
    );

    // D3 atomic revocation of the retained secret memory still verifies 0.00% leak
    const receipt = await client.revokeMemory(mind.mindId, secretMemoryId);
    assert.equal(receipt.revoked, true);
    assert.equal(receipt.residualLeakCheck, '0.00%');

    // Subsequent turns remain capped at 5 and never resurrect revoked secret
    for (let j = 10; j <= 15; j += 1) {
      await client.turn(mind.mindId, {
        userInput: `Post-revocation chat turn ${j}.`,
        llm: { provider: 'mock', model: 'ame-mock-v1' },
      });
    }
    const telAfter = await client.getTelemetry(mind.mindId);
    assert.equal(telAfter.activeMemoryCount, 5);

    const recallAfter = await client.turn(mind.mindId, {
      userInput: 'Do you remember my secret code?',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    assert.equal(recallAfter.reply.includes(secretToken), false);
    const telFinal = await client.getTelemetry(mind.mindId);
    assert.equal(telFinal.activeMemoryCount, 5);
    assert.equal(telFinal.revocationEpoch, receipt.revocationEpoch);
  } finally {
    if (prevMaxMem === undefined) delete process.env.AME_SANDBOX_MAX_MEMORIES_PER_MIND;
    else process.env.AME_SANDBOX_MAX_MEMORIES_PER_MIND = prevMaxMem;
    await stopServer(server);
  }
});

test('GET /v1/minds/:id/telemetry activeMemoryCount accurately excludes revoked and excludedDerivativeIds memories after D3 revocation', async () => {
  const server = createSandboxApp();
  const baseUrl = await startServer(server);
  try {
    const client = new AmeClient({ baseUrl });
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: { name: '미르', role: '비서', language: 'ko' },
    });

    // Turn 1: store secret memory (mem_1)
    const secretToken = 'NOVA-314';
    const t1 = await client.turn(mind.mindId, {
      userInput: `내 비밀 코드는 ${secretToken}이야 꼭 기억해둬.`,
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    const secretMemoryId = t1.memoryRefs[0].memoryId;

    // Turn 2: recall secret -> creates derivative memory (mem_2) with derivedFromMemoryIds=[mem_1]
    const t2 = await client.turn(mind.mindId, {
      userInput: '내가 아까 말한 비밀 코드가 뭐였지?',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    const derivativeMemoryId = t2.memoryRefs[0].memoryId;
    assert.ok(t2.reply.includes(secretToken));

    // Turn 3: unrelated non-derivative turn (mem_3)
    const t3 = await client.turn(mind.mindId, {
      userInput: '오늘 산책을 20분 했어요.',
      llm: { provider: 'mock', model: 'ame-mock-v1' },
    });
    const unrelatedMemoryId = t3.memoryRefs[0].memoryId;

    const telBefore = await fetch(`${baseUrl}/v1/minds/${encodeURIComponent(mind.mindId)}/telemetry`).then((r) =>
      r.json()
    );
    const memListBefore = await fetch(`${baseUrl}/v1/minds/${encodeURIComponent(mind.mindId)}/memories`).then((r) =>
      r.json()
    );
    assert.equal(memListBefore.memories.length, 3);
    assert.equal(telBefore.activeMemoryCount, 3);

    // D3 atomic revocation removes mem_1 AND excludes derivative mem_2 via excludedDerivativeIds
    const receipt = await client.revokeMemory(mind.mindId, secretMemoryId);
    assert.equal(receipt.revoked, true);
    assert.equal(receipt.residualLeakCheck, '0.00%');

    const memListAfter = await fetch(`${baseUrl}/v1/minds/${encodeURIComponent(mind.mindId)}/memories`).then((r) =>
      r.json()
    );
    const telAfter = await fetch(`${baseUrl}/v1/minds/${encodeURIComponent(mind.mindId)}/telemetry`).then((r) =>
      r.json()
    );
    const mindSummaryAfter = await client.getMind(mind.mindId);

    assert.equal(memListAfter.memories.length, 1);
    assert.equal(memListAfter.memories[0].memoryId, unrelatedMemoryId);
    assert.equal(memListAfter.memories.some((m) => m.memoryId === secretMemoryId), false);
    assert.equal(memListAfter.memories.some((m) => m.memoryId === derivativeMemoryId), false);

    assert.equal(telAfter.activeMemoryCount, memListAfter.memories.length);
    assert.equal(telAfter.activeMemoryCount, 1);
    assert.equal(mindSummaryAfter.telemetry.activeMemoryCount, 1);
  } finally {
    await stopServer(server);
  }
});

