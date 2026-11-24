import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createSandboxApp } from '../src/app.mjs';
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
      if (match) {
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

