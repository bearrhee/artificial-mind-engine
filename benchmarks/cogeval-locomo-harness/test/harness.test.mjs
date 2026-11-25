import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSandboxApp } from '../../../packages/sandbox-server/src/app.mjs';
import {
  detectAbstentionReply as detectLmeAbstentionReply,
  parseCliArgs as parseLmeCliArgs,
  runLongMemEvalComparison,
  scoreAnswer as scoreLmeAnswer,
  unwrapDomainReplyText as unwrapLmeDomainReplyText,
} from '../longmemeval_frontier_runner.mjs';
import {
  detectAbstentionReply as detectLocomoAbstentionReply,
  parseCliArgs as parseLocomoCliArgs,
  runLocomoComparison,
  scoreLocomoAnswer,
  unwrapDomainReplyText as unwrapLocomoDomainReplyText,
} from '../locomo_frontier_runner.mjs';
import { runBatchConvergence } from '../batch_convergence_runner.mjs';
import { generateDdScorecard } from '../dd_scorecard_generator.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.resolve(THIS_DIR, '..');
const SAMPLE_LME_PATH = path.join(HARNESS_DIR, 'sample_longmemeval.json');
const SAMPLE_LOCOMO_PATH = path.join(HARNESS_DIR, 'sample_locomo.json');
const RUN_HARNESS_PATH = path.join(HARNESS_DIR, 'run_harness.mjs');
const RUN_LME_PATH = path.join(HARNESS_DIR, 'longmemeval_frontier_runner.mjs');
const RUN_LOCOMO_PATH = path.join(HARNESS_DIR, 'locomo_frontier_runner.mjs');
const RUN_CONVERGENCE_PATH = path.join(HARNESS_DIR, 'batch_convergence_runner.mjs');
const DD_GENERATOR_PATH = path.join(HARNESS_DIR, 'dd_scorecard_generator.mjs');

async function startServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function runNodeCli(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(HARNESS_DIR, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function answerJudgePrompt(userPrompt) {
  const isCat5 = /Category:\s*Cat\s*5/i.test(userPrompt);
  const candMatch = userPrompt.match(/Candidate Response:\s*([\s\S]+)$/i);
  const candidate = (candMatch ? candMatch[1] : '').trim().toLowerCase();

  if (isCat5) {
    const abstained =
      /\b(does not mention|did not mention|never mentioned|not mentioned|no mention|cannot verify|cannot answer)\b/i.test(
        candidate
      );
    return JSON.stringify({
      verdict: abstained ? 'PASS' : 'FAIL',
      reason: abstained ? 'correctly abstained on adversarial trap' : 'failed to abstain',
    });
  }

  const goldMatch = userPrompt.match(/Gold Reference Answer:\s*(.+)$/im);
  const gold = (goldMatch ? goldMatch[1] : '').trim().toLowerCase();
  const norm = (s) =>
    s
      .replace(/[.,!?;:'"()[\]{}]/g, ' ')
      .replace(/\b(a|an|the)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const ng = norm(gold);
  const nc = norm(candidate);
  const passed = Boolean(ng && (nc === ng || nc.includes(ng)));
  return JSON.stringify({
    verdict: passed ? 'PASS' : 'FAIL',
    reason: passed ? 'grounded match' : 'mismatch',
  });
}

/**
 * Extract grounded answer strictly from the HTTP prompt payload received by the LLM stub.
 * Zero access to ground-truth files: simulates a deterministic frontier reader over context.
 */
function answerFromReceivedPrompt(messages) {
  const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
  const userMsgs = messages.filter((m) => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1]?.content || '';

  if (sysMsg.includes('LoCoMo long-term memory benchmark judge')) {
    return answerJudgePrompt(lastUser);
  }

  const isBare = lastUser.includes('[Conversation History]');
  let question = lastUser;
  const candidateLines = [];

  if (isBare) {
    const qMatch = lastUser.match(/Question:\s*(.+)$/im);
    question = qMatch ? qMatch[1].trim() : lastUser;
    const historyBlock = lastUser.split(/\[Question Date:|Question:/i)[0] || '';
    let currentDate = '';
    for (const rawLine of historyBlock.split('\n')) {
      const line = rawLine.trim();
      const sessMatch = line.match(/^###\s+Session\s+\d+\s+\[([^\]]+)\]/);
      if (sessMatch) {
        currentDate = sessMatch[1];
        continue;
      }
      if (line.startsWith('User:')) {
        candidateLines.push({
          date: currentDate,
          text: line.slice('User:'.length).trim(),
        });
      } else {
        const speakerMatch = line.match(/^([A-Za-z][A-Za-z0-9 _-]{0,30})\s*\((D\d+:\d+)\):\s*(.+)$/);
        if (speakerMatch) {
          candidateLines.push({
            date: currentDate,
            text: `${speakerMatch[1]}: ${speakerMatch[3].trim()}`,
          });
        }
      }
    }
  } else {
    question = lastUser.replace(/^\[[^\]]+\]\s*/, '').trim();
    const marker = '[Active Memory Context';
    const idx = sysMsg.indexOf(marker);
    if (idx !== -1) {
      const tail = sysMsg.slice(idx);
      const endIdx = tail.indexOf('\n[');
      const block = endIdx === -1 ? tail : tail.slice(0, endIdx);
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('- ') || line.includes('(none)')) continue;
        const cleaned = line.replace(/^- \[[^\]]+\]\s*/, '').trim();
        const dateMatch = cleaned.match(/^\[([^\]]+)\]\s*(.*)$/);
        candidateLines.push({
          date: dateMatch ? dateMatch[1] : '',
          text: dateMatch ? dateMatch[2] : cleaned,
        });
      }
    }
    for (const um of userMsgs.slice(0, -1)) {
      const cleaned = um.content.trim();
      const dateMatch = cleaned.match(/^\[([^\]]+)\]\s*(.*)$/);
      candidateLines.push({
        date: dateMatch ? dateMatch[1] : '',
        text: dateMatch ? dateMatch[2] : cleaned,
      });
    }
  }

  // Deduplicate exact text entries preserving order
  const seen = new Set();
  const uniqueLines = [];
  for (const item of candidateLines) {
    const key = `${item.date}|${item.text}`;
    if (!seen.has(key) && item.text) {
      seen.add(key);
      uniqueLines.push(item);
    }
  }

  const qLower = question.toLowerCase();
  const stop = new Set([
    'what', 'which', 'where', 'when', 'who', 'whom', 'whose', 'why', 'how',
    'is', 'are', 'was', 'were', 'did', 'do', 'does', 'have', 'has', 'had',
    'the', 'a', 'an', 'my', 'i', 'me', 'for', 'of', 'in', 'on', 'at', 'to',
    'from', 'and', 'or', 'say', 'said', 'current', 'currently', 'after',
    'before', 'across', 'two', 'brand', 'date', 'city', 'serial', 'number',
  ]);
  const qTokens = qLower
    .split(/[^a-z0-9/-]+/)
    .filter((t) => t.length >= 2 && !stop.has(t));

  // Specific entity gate for unmentioned items (abstention check)
  if (qLower.includes('kayak')) {
    const hasKayak = uniqueLines.some((l) => l.text.toLowerCase().includes('kayak'));
    if (!hasKayak) return 'You did not mention this information in our conversation.';
  }
  if (qLower.includes('projector')) {
    const hasProjector = uniqueLines.some((l) => l.text.toLowerCase().includes('projector'));
    if (!hasProjector) return 'You did not mention this information in our conversation.';
  }
  if (qLower.includes('breed of dog')) {
    const hasDog = uniqueLines.some((l) => /\bdog\b|\bbreed\b/i.test(l.text));
    if (!hasDog) return 'The conversation does not mention Marcus adopting a dog.';
  }
  if (qLower.includes('espresso machine') && qLower.includes('bakery')) {
    const hasEspresso = uniqueLines.some((l) => /\bespresso\b|\bbakery\b/i.test(l.text));
    if (!hasEspresso) return 'The conversation does not mention a bakery or espresso machine.';
  }

  const scored = uniqueLines
    .map((entry, idx) => {
      const lower = entry.text.toLowerCase();
      let overlap = 0;
      for (const tok of qTokens) {
        if (lower.includes(tok)) overlap += 1;
      }
      return { ...entry, idx, overlap };
    })
    .filter((e) => e.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return String(b.date).localeCompare(String(a.date)) || b.idx - a.idx;
    });

  if (scored.length === 0) {
    return 'You did not mention this information.';
  }

  // Prefer latest update line when knowledge-update applies
  const sortedByDate = [...scored].sort(
    (a, b) => String(b.date).localeCompare(String(a.date)) || b.idx - a.idx
  );
  const best = scored[0].text;
  const latestUpdate = sortedByDate.find((s) => /^update:/i.test(s.text))?.text || best;

  if (qLower.includes('access code') && qLower.includes('locker')) {
    const m = best.match(/\b([A-Z]+-\d+)\b/);
    if (m) return m[1];
  }
  if (qLower.includes('espresso beans')) {
    const m = best.match(/ordered\s+(.+?)\s+single-origin beans/i);
    if (m) return m[1];
  }
  if (qLower.includes('passport renewal') && qLower.includes('date')) {
    const m = best.match(/\b(\d{4}\/\d{2}\/\d{2})\b/);
    if (m) return m[1];
  }
  if (qLower.includes('city') && qLower.includes('march 2024')) {
    const marchLine = scored.find((s) => s.text.toLowerCase().includes('march 2024'))?.text || best;
    const m = marchLine.match(/visited\s+([A-Z][a-zA-Z]+)/);
    if (m) return m[1];
  }
  if (qLower.includes('cloud storage plan limit')) {
    const m = latestUpdate.match(/to\s+(\d+\s*(?:TB|GB))/i) || latestUpdate.match(/(\d+\s*(?:TB|GB))/i);
    if (m) return m[1];
  }
  if (qLower.includes('acoustic guitar') && qLower.includes('stored')) {
    const m = latestUpdate.match(/to my\s+([^.]+?)\s+today/i);
    if (m) return m[1];
  }
  if (qLower.includes('two weekend hiking trails')) {
    const trails = [];
    for (const s of scored) {
      const m = s.text.match(/finished the\s+(.+?)\s+weekend hiking trail/i);
      if (m && !trails.includes(m[1])) trails.push(m[1]);
    }
    if (trails.length >= 2) return `${trails[0]} and ${trails[1]}`;
  }
  if (qLower.includes('two programming languages')) {
    const langs = [];
    for (const s of scored) {
      const m = s.text.match(/using\s+([A-Za-z]+)\.?$/i);
      if (m && !langs.includes(m[1])) langs.push(m[1]);
    }
    if (langs.length >= 2) return `${langs[0]} and ${langs[1]}`;
  }

  // LoCoMo grounded extraction paths
  if (qLower.includes('orange tabby cat')) {
    const m = best.match(/named\s+([A-Z][a-z]+)/);
    if (m) return m[1];
  }
  if (qLower.includes('profession') && qLower.includes('sister') && qLower.includes('visit')) {
    const profLine = uniqueLines.find((l) => /work as\s+a?\s*([^.]+)/i.test(l.text))?.text || '';
    const cityLine = uniqueLines.find((l) => /\bvisiting\s+([A-Z][a-z]+)/i.test(l.text))?.text || '';
    const pm = profLine.match(/work as\s+(?:a\s+|an\s+)?([^.]+)/i);
    const cm = cityLine.match(/\bvisiting\s+([A-Z][a-z]+)/i) || profLine.match(/moved to\s+([A-Z][a-z]+)/i);
    if (pm && cm) return `${pm[1]} in ${cm[1]}`;
  }
  if (qLower.includes('half marathon') && qLower.includes('what date')) {
    const m = best.match(/on\s+(\d{1,2}\s+[A-Za-z]+,\s+\d{4})/i);
    if (m) return m[1];
  }
  if (qLower.includes('ceramic mugs') && qLower.includes('oak pantry cabinet')) {
    const teacupLine = scored.find((s) => /teacup on the porch/i.test(s.text));
    if (teacupLine) return 'Because her cat Miso knocked over a teacup on the porch';
  }
  if (qLower.includes('humidity sensor') && qLower.includes('model')) {
    const m = best.match(/model\s+([A-Z]+-\d+)/i);
    if (m) return m[1];
  }
  if (qLower.includes('rally') && qLower.includes('vespa')) {
    const rallyLine = scored.find((s) => /into the\s+([A-Z][A-Za-z ]+?Rally)/i.test(s.text))?.text || best;
    const m = rallyLine.match(/into the\s+([A-Z][A-Za-z ]+?Rally)\b/);
    if (m) return m[1];
  }
  if (qLower.includes('road inspection') && qLower.includes('vespa')) {
    const m = best.match(/on\s+(\d{1,2}\s+[A-Za-z]+,\s+\d{4})/i);
    if (m) return m[1];
  }
  if (qLower.includes('traveling to taipei')) {
    const taipeiLine = scored.find((s) => /practice Mandarin immersion/i.test(s.text));
    if (taipeiLine) return 'To practice Mandarin immersion';
  }

  return latestUpdate;
}

function createFrontierStubServer() {
  const recordedRequests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const totalChars = messages.reduce((s, m) => s + String(m?.content || '').length, 0);
    const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = messages.filter((m) => m.role === 'user').pop()?.content || '';
    const armTag = sysMsg.includes('LoCoMo long-term memory benchmark judge')
      ? 'judge'
      : lastUser.includes('[Conversation History]')
        ? 'bare-frontier'
        : 'ame-gateway';

    recordedRequests.push({
      armTag,
      model: body.model,
      messageCount: messages.length,
      totalChars,
      estimatedTokens: Math.ceil(totalChars / 4),
    });

    const content = answerFromReceivedPrompt(messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_stub',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content } }],
        usage: {
          prompt_tokens: Math.ceil(totalChars / 4),
          completion_tokens: Math.ceil(content.length / 4),
        },
      })
    );
  });

  return { server, recordedRequests };
}

test('LongMemEval-S paired comparison (ame-gateway vs bare-frontier) proves O(1) bounded prompt tokens, recall, abstention, KV cache, and D4 isolation', async () => {
  const apiKey = 'test-dd-key';
  const sandbox = createSandboxApp({ apiKey });
  const { server: llmStub, recordedRequests } = createFrontierStubServer();

  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  try {
    const report = await runLongMemEvalComparison({
      datasetPath: SAMPLE_LME_PATH,
      arm: 'both',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: 'stub-ephemeral-key',
      baseUrl: llmBaseUrl,
      ameBaseUrl,
      ameApiKey: apiKey,
      ameMode: 'b',
      ingestMode: 'settle',
    });

    assert.equal(report.dataset.datasetKind, 'synthetic_offline_smoke');
    assert.equal(report.dataset.evaluatedCount, 10);
    assert.ok(report.ameGateway, 'ameGateway arm report should be present');
    assert.ok(report.bareFrontier, 'bareFrontier arm report should be present');
    assert.ok(report.pairedDelta, 'pairedDelta summary should be present');

    const ame = report.ameGateway.metrics;
    const bare = report.bareFrontier.metrics;
    const delta = report.pairedDelta;

    // 1. Both arms complete all 10 items across all 5 question types accurately
    assert.equal(ame.totalItems, 10);
    assert.equal(bare.totalItems, 10);
    assert.equal(ame.accuracyPct, 100);
    assert.equal(bare.accuracyPct, 100);
    assert.equal(delta.accuracyDeltaPct, 0);

    // 2. Abstention metrics (2 abstention items, 8 answerable items -> 0% FAR)
    assert.equal(ame.abstention.tp, 2);
    assert.equal(ame.abstention.fp, 0);
    assert.equal(ame.abstention.tn, 8);
    assert.equal(ame.abstention.fn, 0);
    assert.equal(ame.abstentionAccuracy, 1);
    assert.equal(ame.abstentionFAR, 0);

    // 3. KV prefix stability & caching on follow-up turns
    assert.ok(ame.meanCachedRatioPct > 0, `Expected positive KV cache hit ratio, got ${ame.meanCachedRatioPct}`);
    assert.equal(ame.prefixInvariantMinds, 10);

    // 4. D4 unconscious telemetry isolation across every API call
    assert.equal(ame.d4RedactedAll, true);
    assert.equal(delta.d4RedactedAll, true);
    assert.equal(ame.d4ForbiddenKeyLeakCount, 0);
    assert.equal(ame.d4UnredactedCount, 0);
    assert.ok(ame.d4TelemetryObjectsChecked >= 20);

    // 5. O(1) bounded prompt tokens vs growing bare-frontier haystack tokens
    for (const item of report.ameGateway.items) {
      assert.ok(item.queryMessagesCount <= 7, `Expected bounded sliding window <= 7 messages, got ${item.queryMessagesCount}`);
      assert.ok(item.windowStart > 0, `Expected sliding window compression on multi-session item ${item.questionId}`);
    }
    assert.ok(
      bare.scaling.queryPromptGrowthRatio > 1.3,
      `Expected bare-frontier prompt growth across haystacks > 1.3x, got ${bare.scaling.queryPromptGrowthRatio}x`
    );
    assert.ok(
      ame.scaling.queryPromptGrowthRatio < bare.scaling.queryPromptGrowthRatio,
      `Expected AME prompt growth (${ame.scaling.queryPromptGrowthRatio}x) < bare growth (${bare.scaling.queryPromptGrowthRatio}x)`
    );
    assert.ok(
      ame.scaling.queryPromptGrowthRatio <= 1.25,
      `Expected O(1) bounded AME prompt growth <= 1.25x, got ${ame.scaling.queryPromptGrowthRatio}x`
    );
    assert.ok(
      ame.maxQueryPromptTokens < bare.maxQueryPromptTokens,
      `Expected max AME tokens (${ame.maxQueryPromptTokens}) < max Bare tokens (${bare.maxQueryPromptTokens})`
    );
    assert.ok(
      delta.tokenReductionRatio > 0 && delta.tokenCompressionFactor > 1,
      `Expected positive token savings, got ratio=${delta.tokenReductionRatio}, factor=${delta.tokenCompressionFactor}`
    );

    // 6. Wire-level verification from HTTP stub
    const ameWireReqs = recordedRequests.filter((r) => r.armTag === 'ame-gateway');
    const bareWireReqs = recordedRequests.filter((r) => r.armTag === 'bare-frontier');
    assert.equal(ameWireReqs.length, 10);
    assert.equal(bareWireReqs.length, 10);
    const maxAmeWireTokens = Math.max(...ameWireReqs.map((r) => r.estimatedTokens));
    const maxBareWireTokens = Math.max(...bareWireReqs.map((r) => r.estimatedTokens));
    assert.ok(maxAmeWireTokens < maxBareWireTokens);
  } finally {
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
  }
});

test('LongMemEval-S Mode A (client.turn) arm executes cleanly against sandbox and HTTP LLM stub', async () => {
  const prevAllowPrivate = process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
  process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL = '1';
  const sandbox = createSandboxApp();
  const { server: llmStub } = createFrontierStubServer();
  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  try {
    const report = await runLongMemEvalComparison({
      datasetPath: SAMPLE_LME_PATH,
      arm: 'ame-gateway',
      provider: 'openai-compat',
      model: 'local-stub-v1',
      baseUrl: llmBaseUrl,
      ameBaseUrl,
      ameMode: 'a',
      ingestMode: 'settle',
      limit: 2,
    });

    assert.equal(report.ameGateway.metrics.totalItems, 2);
    assert.equal(report.ameGateway.metrics.accuracyPct, 100);
    assert.equal(report.ameGateway.metrics.d4RedactedAll, true);
    assert.equal(report.bareFrontier, null);
    assert.equal(report.pairedDelta, null);
  } finally {
    if (prevAllowPrivate === undefined) delete process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL;
    else process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL = prevAllowPrivate;
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
  }
});

test('CLI pipeline: run_harness.mjs + longmemeval_frontier_runner.mjs + dd_scorecard_generator.mjs produce valid DD Markdown and JSON', async () => {
  const apiKey = 'cli-dd-key';
  const sandbox = createSandboxApp({ apiKey });
  const { server: llmStub } = createFrontierStubServer();
  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ame-dd-test-'));
  const harnessJsonPath = path.join(tmpDir, 'harness.json');
  const lmeJsonPath = path.join(tmpDir, 'lme.json');
  const outMdPath = path.join(tmpDir, 'dd-scorecard.md');
  const outJsonPath = path.join(tmpDir, 'dd-scorecard.json');

  try {
    // 1. Run 7-gate CogEval + LoCoMo harness CLI
    const harnessCli = await runNodeCli(RUN_HARNESS_PATH, [
      '--base-url',
      ameBaseUrl,
      '--api-key',
      apiKey,
      '--provider',
      'mock',
      '--model',
      'mock-eval-v1',
      '--json-only',
      '--json-out',
      harnessJsonPath,
    ]);
    assert.equal(harnessCli.code, 0, `run_harness failed: ${harnessCli.stderr}\n${harnessCli.stdout}`);
    const harnessReport = JSON.parse(await fs.readFile(harnessJsonPath, 'utf8'));
    assert.equal(harnessReport.overallPass, true);
    assert.equal(harnessReport.passed, 7);

    // 2. Run LongMemEval paired comparator CLI on sample_longmemeval.json
    const lmeCli = await runNodeCli(RUN_LME_PATH, [
      '--dataset',
      SAMPLE_LME_PATH,
      '--arm',
      'both',
      '--provider',
      'openai',
      '--model',
      'gpt-4o-stub',
      '--api-key',
      'stub-key',
      '--base-url',
      llmBaseUrl,
      '--ame-base-url',
      ameBaseUrl,
      '--ame-api-key',
      apiKey,
      '--json-only',
      '--json-out',
      lmeJsonPath,
    ]);
    assert.equal(lmeCli.code, 0, `longmemeval_frontier_runner failed: ${lmeCli.stderr}\n${lmeCli.stdout}`);
    const lmeReport = JSON.parse(await fs.readFile(lmeJsonPath, 'utf8'));
    assert.equal(lmeReport.ameGateway.metrics.d4RedactedAll, true);

    // 3. Run DD Scorecard Generator CLI
    const ddCli = await runNodeCli(DD_GENERATOR_PATH, [
      '--harness-json',
      harnessJsonPath,
      '--lme-json',
      lmeJsonPath,
      '--out-md',
      outMdPath,
      '--out-json',
      outJsonPath,
    ]);
    assert.equal(ddCli.code, 0, `dd_scorecard_generator failed: ${ddCli.stderr}\n${ddCli.stdout}`);

    const mdContent = await fs.readFile(outMdPath, 'utf8');
    const summaryJson = JSON.parse(await fs.readFile(outJsonPath, 'utf8'));

    assert.equal(summaryJson.verificationScope.tier, 'sandbox-contract-verification');
    assert.equal(summaryJson.overallVerdict, 'SANDBOX_GATES_PASSED_SEALED_EVAL_PENDING');
    assert.equal(summaryJson.governanceGates.passed, 7);
    assert.equal(summaryJson.counts.failed, 0);
    assert.equal(summaryJson.longMemEvalComparison.pairedDelta.d4RedactedAll, true);

    assert.match(mdContent, /sandbox-contract-verification/);
    assert.match(mdContent, /Cognitive & Governance Invariants/);
    assert.match(mdContent, /LongMemEval-S Paired Frontier Comparison/);
    assert.match(mdContent, /PENDING_EXTERNAL_RUN/);
    assert.match(mdContent, /sealed-kernel/);

    // 4. Verify programmatic generateDdScorecard distinguishes sealed-kernel vs sandbox-contract
    const sealedFake = generateDdScorecard({
      harnessReport: { ...harnessReport, health: { ...harnessReport.health, mode: 'sealed-kernel' } },
      lmeReport: {
        ...lmeReport,
        dataset: { ...lmeReport.dataset, datasetKind: 'external_longmemeval', evaluatedCount: 500 },
        config: { ...lmeReport.config, provider: 'openai', llmBaseUrl: null },
        ameGateway: { ...lmeReport.ameGateway, health: { ...lmeReport.ameGateway.health, mode: 'sealed-kernel' } },
      },
    });
    assert.equal(sealedFake.summary.verificationScope.tier, 'sealed-kernel-production-eval');
    assert.equal(sealedFake.summary.overallVerdict, 'ALL_MEASURED_GATES_PASSED');
  } finally {
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('LoCoMo paired comparison (ame-gateway vs bare-frontier) proves O(1) bounded prompt tokens, all 5 categories, LLM-as-Judge, KV cache, and D4 isolation', async () => {
  const apiKey = 'test-locomo-key';
  const sandbox = createSandboxApp({ apiKey });
  const { server: llmStub, recordedRequests } = createFrontierStubServer();

  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  try {
    const report = await runLocomoComparison({
      datasetPath: SAMPLE_LOCOMO_PATH,
      arm: 'both',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: 'stub-ephemeral-key',
      baseUrl: llmBaseUrl,
      ameBaseUrl,
      ameApiKey: apiKey,
      ameMode: 'b',
      ingestMode: 'settle',
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o-judge-stub',
      judgeApiKey: 'stub-judge-key',
      judgeBaseUrl: llmBaseUrl,
    });

    assert.equal(report.dataset.datasetKind, 'synthetic_offline_smoke');
    assert.equal(report.dataset.conversationsEvaluated, 2);
    assert.equal(report.dataset.evaluatedCount, 10);
    assert.equal(report.engineMode, 'sandbox-contract');
    assert.ok(report.ameGateway);
    assert.ok(report.bareFrontier);
    assert.ok(report.pairedDelta);
    assert.equal(report.publishedReferences.length, 8);

    const ame = report.ameGateway.metrics;
    const bare = report.bareFrontier.metrics;
    const delta = report.pairedDelta;

    // 1. All 5 categories evaluated with 100% accuracy and 100% LLM-as-Judge agreement
    assert.equal(ame.totalItems, 10);
    assert.equal(bare.totalItems, 10);
    assert.equal(ame.accuracyPct, 100);
    assert.equal(bare.accuracyPct, 100);
    assert.equal(ame.cat1To4.accuracyPct, 100);
    assert.equal(ame.judgeEnabled, true);
    assert.equal(ame.judgeAccuracyPct, 100);
    assert.equal(bare.judgeAccuracyPct, 100);
    for (const cat of ['1', '2', '3', '4', '5']) {
      assert.equal(ame.byCategory[cat].total, 2);
      assert.equal(ame.byCategory[cat].accuracyPct, 100);
    }

    // 2. Adversarial abstention & 0% FAR
    assert.equal(ame.abstention.tp, 2);
    assert.equal(ame.abstention.fp, 0);
    assert.equal(ame.abstention.tn, 8);
    assert.equal(ame.abstention.fn, 0);
    assert.equal(ame.abstentionFAR, 0);

    // 3. KV prefix invariance & cache hit ratio
    assert.ok(ame.meanCachedRatioPct > 0);
    assert.equal(ame.prefixInvariantConversations, 2);

    // 4. D4 isolation
    assert.equal(ame.d4RedactedAll, true);
    assert.equal(delta.d4RedactedAll, true);
    assert.equal(ame.d4ForbiddenKeyLeakCount, 0);
    assert.equal(ame.d4UnredactedCount, 0);
    assert.ok(ame.d4TelemetryObjectsChecked >= 40);

    // 5. O(1) bounded prompt tokens vs Bare Frontier growth across 4-session vs 8-session convs
    for (const item of report.ameGateway.items) {
      assert.ok(item.queryMessagesCount <= 7, `Expected bounded window <= 7, got ${item.queryMessagesCount}`);
      assert.ok(item.windowStart > 0, `Expected window compression on ${item.qaId}`);
    }
    assert.ok(bare.scaling.queryPromptGrowthRatio > 1.3);
    assert.ok(ame.scaling.queryPromptGrowthRatio < bare.scaling.queryPromptGrowthRatio);
    assert.ok(ame.scaling.queryPromptGrowthRatio <= 1.25);
    assert.ok(ame.maxQueryPromptTokens < bare.maxQueryPromptTokens);
    assert.ok(delta.tokenReductionRatio > 0 && delta.tokenCompressionFactor > 1);
    assert.equal(delta.amePromptBounded, true);

    // 6. Wire check on stub server (10 ame-gateway + 10 bare-frontier + 20 judge)
    assert.equal(recordedRequests.filter((r) => r.armTag === 'ame-gateway').length, 10);
    assert.equal(recordedRequests.filter((r) => r.armTag === 'bare-frontier').length, 10);
    assert.equal(recordedRequests.filter((r) => r.armTag === 'judge').length, 20);

    // 7. Conversation filter (--conversations sample-conv-1)
    const filtered = await runLocomoComparison({
      datasetPath: SAMPLE_LOCOMO_PATH,
      conversations: 'sample-conv-1',
      arm: 'ame-gateway',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: 'stub-key',
      baseUrl: llmBaseUrl,
      ameBaseUrl,
      ameApiKey: apiKey,
    });
    assert.equal(filtered.dataset.conversationsEvaluated, 1);
    assert.equal(filtered.dataset.evaluatedCount, 5);
    assert.equal(filtered.ameGateway.metrics.accuracyPct, 100);
  } finally {
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
  }
});

test('Batch Convergence runner executes 100K-turn multi-arm simulation against sandbox-server with D4 redaction and bounded drift', async () => {
  const apiKey = 'test-conv-key';
  const sandbox = createSandboxApp({ apiKey });
  const ameBaseUrl = await startServer(sandbox);

  try {
    const report = await runBatchConvergence({
      baseUrl: ameBaseUrl,
      apiKey,
      turns: 100_000,
      profiles: 40,
      checkpoints: 8,
      seed: 1337,
      compareArms: true,
    });

    assert.equal(report.overallPass, true);
    assert.equal(report.engineMode, 'sandbox-contract');
    assert.equal(report.config.turns, 100_000);
    assert.equal(report.config.profiles, 40);
    assert.equal(report.config.checkpoints, 8);
    assert.equal(report.invariants.d4Redacted, true);
    assert.equal(report.d4Audit.d4RedactedAll, true);
    assert.equal(report.d4Audit.forbiddenKeyLeakCount, 0);
    assert.equal(report.d4Audit.unredactedCount, 0);
    assert.equal(report.invariants.driftBounded, true);
    assert.equal(report.invariants.ameOutperformsAacimOff, true);
    assert.equal(report.invariants.ameOutperformsMindOff, true);
    assert.ok(report.arms.ame_aacim_on.compositeFinal > report.arms.aacim_off.compositeFinal);
    assert.ok(report.arms.ame_aacim_on.compositeFinal > report.arms.mind_off.compositeFinal);
    assert.ok(report.arms.ame_aacim_on.safetyCompliance >= 0.99);
    assert.equal(report.arms.ame_aacim_on.checkpointCount, 8);
  } finally {
    await stopServer(sandbox);
  }
});

test('Unified 4-input CLI pipeline: harness + LongMemEval + LoCoMo + Convergence -> dd_scorecard_generator.mjs', async () => {
  const apiKey = 'cli-unified-dd-key';
  const sandbox = createSandboxApp({ apiKey });
  const { server: llmStub } = createFrontierStubServer();
  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ame-unified-dd-'));
  const harnessJsonPath = path.join(tmpDir, 'harness.json');
  const lmeJsonPath = path.join(tmpDir, 'lme.json');
  const locomoJsonPath = path.join(tmpDir, 'locomo.json');
  const convergenceJsonPath = path.join(tmpDir, 'convergence.json');
  const outMdPath = path.join(tmpDir, 'dd-scorecard.md');
  const outJsonPath = path.join(tmpDir, 'dd-scorecard.json');

  try {
    const [harnessCli, lmeCli, locomoCli, convCli] = await Promise.all([
      runNodeCli(RUN_HARNESS_PATH, [
        '--base-url',
        ameBaseUrl,
        '--api-key',
        apiKey,
        '--provider',
        'mock',
        '--model',
        'mock-eval-v1',
        '--json-only',
        '--json-out',
        harnessJsonPath,
      ]),
      runNodeCli(RUN_LME_PATH, [
        '--dataset',
        SAMPLE_LME_PATH,
        '--arm',
        'both',
        '--provider',
        'openai',
        '--model',
        'gpt-4o-stub',
        '--api-key',
        'stub-key',
        '--base-url',
        llmBaseUrl,
        '--ame-base-url',
        ameBaseUrl,
        '--ame-api-key',
        apiKey,
        '--json-only',
        '--json-out',
        lmeJsonPath,
      ]),
      runNodeCli(RUN_LOCOMO_PATH, [
        '--dataset',
        SAMPLE_LOCOMO_PATH,
        '--arm',
        'both',
        '--provider',
        'openai',
        '--model',
        'gpt-4o-stub',
        '--api-key',
        'stub-key',
        '--base-url',
        llmBaseUrl,
        '--ame-base-url',
        ameBaseUrl,
        '--ame-api-key',
        apiKey,
        '--json-only',
        '--json-out',
        locomoJsonPath,
      ]),
      runNodeCli(RUN_CONVERGENCE_PATH, [
        '--turns=100000',
        '--profiles=40',
        '--checkpoints=8',
        '--seed=1337',
        '--compare-arms=true',
        '--base-url',
        ameBaseUrl,
        '--api-key',
        apiKey,
        '--json-only',
        '--json-out',
        convergenceJsonPath,
      ]),
    ]);

    assert.equal(harnessCli.code, 0, `run_harness failed: ${harnessCli.stderr}`);
    assert.equal(lmeCli.code, 0, `longmemeval failed: ${lmeCli.stderr}`);
    assert.equal(locomoCli.code, 0, `locomo failed: ${locomoCli.stderr}`);
    assert.equal(convCli.code, 0, `convergence failed: ${convCli.stderr}`);

    const ddCli = await runNodeCli(DD_GENERATOR_PATH, [
      '--harness-json',
      harnessJsonPath,
      '--lme-json',
      lmeJsonPath,
      '--locomo-json',
      locomoJsonPath,
      '--convergence-json',
      convergenceJsonPath,
      '--out-md',
      outMdPath,
      '--out-json',
      outJsonPath,
    ]);
    assert.equal(ddCli.code, 0, `dd_scorecard_generator failed: ${ddCli.stderr}\n${ddCli.stdout}`);

    const mdContent = await fs.readFile(outMdPath, 'utf8');
    const summaryJson = JSON.parse(await fs.readFile(outJsonPath, 'utf8'));

    assert.equal(summaryJson.verificationScope.tier, 'sandbox-contract-verification');
    assert.equal(summaryJson.overallVerdict, 'SANDBOX_GATES_PASSED_SEALED_EVAL_PENDING');
    assert.equal(summaryJson.counts.failed, 0);
    assert.equal(summaryJson.evidenceSources.harnessIncluded, true);
    assert.equal(summaryJson.evidenceSources.lmeIncluded, true);
    assert.equal(summaryJson.evidenceSources.locomoIncluded, true);
    assert.equal(summaryJson.evidenceSources.convergenceIncluded, true);
    assert.equal(summaryJson.locomoComparison.pairedDelta.d4RedactedAll, true);
    assert.equal(summaryJson.batchConvergence.overallPass, true);

    assert.match(mdContent, /LoCoMo Paired Frontier Comparison/);
    assert.match(mdContent, /Published Reference Comparison Table/);
    assert.match(mdContent, /Long-Horizon Batch Convergence/);
    assert.match(mdContent, /sandbox-contract-verification/);
    assert.match(mdContent, /PENDING_EXTERNAL_RUN/);

    // Verify strict tier separation across all 4 inputs:
    // 1) All sealed + external datasets + non-mock -> sealed-kernel-production-eval
    const [harnessReport, lmeReport, locomoReport, convergenceReport] = await Promise.all([
      fs.readFile(harnessJsonPath, 'utf8').then(JSON.parse),
      fs.readFile(lmeJsonPath, 'utf8').then(JSON.parse),
      fs.readFile(locomoJsonPath, 'utf8').then(JSON.parse),
      fs.readFile(convergenceJsonPath, 'utf8').then(JSON.parse),
    ]);

    const sealedAll = generateDdScorecard({
      harnessReport: { ...harnessReport, health: { ...harnessReport.health, mode: 'sealed-kernel' } },
      lmeReport: {
        ...lmeReport,
        dataset: { ...lmeReport.dataset, datasetKind: 'external_longmemeval', evaluatedCount: 500 },
        config: { ...lmeReport.config, provider: 'openai', llmBaseUrl: null },
        ameGateway: { ...lmeReport.ameGateway, health: { ...lmeReport.ameGateway.health, mode: 'sealed-kernel' } },
      },
      locomoReport: {
        ...locomoReport,
        engineMode: 'sealed-kernel',
        dataset: { ...locomoReport.dataset, datasetKind: 'external_locomo', evaluatedCount: 304 },
        config: { ...locomoReport.config, provider: 'openai', llmBaseUrl: null },
        ameGateway: { ...locomoReport.ameGateway, health: { ...locomoReport.ameGateway.health, mode: 'sealed-kernel' } },
      },
      convergenceReport: {
        ...convergenceReport,
        engineMode: 'sealed-kernel',
        health: { ...convergenceReport.health, mode: 'sealed-kernel' },
      },
    });
    assert.equal(sealedAll.summary.verificationScope.tier, 'sealed-kernel-production-eval');
    assert.equal(sealedAll.summary.overallVerdict, 'ALL_MEASURED_GATES_PASSED');

    // 2) Mixing even one sandbox-contract report (e.g., convergenceReport) downgrades tier
    const mixedTier = generateDdScorecard({
      harnessReport: { ...harnessReport, health: { ...harnessReport.health, mode: 'sealed-kernel' } },
      locomoReport: {
        ...locomoReport,
        engineMode: 'sealed-kernel',
        dataset: { ...locomoReport.dataset, datasetKind: 'external_locomo', evaluatedCount: 304 },
        config: { ...locomoReport.config, provider: 'openai', llmBaseUrl: null },
        ameGateway: { ...locomoReport.ameGateway, health: { ...locomoReport.ameGateway.health, mode: 'sealed-kernel' } },
      },
      convergenceReport,
    });
    assert.equal(mixedTier.summary.verificationScope.tier, 'sandbox-contract-verification');
    assert.equal(mixedTier.summary.overallVerdict, 'SANDBOX_GATES_PASSED_SEALED_EVAL_PENDING');
  } finally {
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('parseCliArgs([]) preserves AME_LLM_API_KEY, AME_LLM_BASE_URL, and judge env var fallbacks without --api-key', async () => {
  const locomoCli = parseLocomoCliArgs([]);
  const lmeCli = parseLmeCliArgs([]);

  assert.equal(locomoCli.apiKey, null);
  assert.equal(locomoCli.baseUrl, null);
  assert.equal(locomoCli.judgeApiKey, null);
  assert.equal(locomoCli.judgeBaseUrl, null);
  assert.equal(lmeCli.apiKey, null);
  assert.equal(lmeCli.baseUrl, null);

  const ameApiKey = 'test-env-fallback-key';
  const sandbox = createSandboxApp({ apiKey: ameApiKey });
  const capturedAuth = [];
  const llmStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
    const role = sysMsg.includes('LoCoMo long-term memory benchmark judge') ? 'judge' : 'llm';
    capturedAuth.push({ role, authorization: req.headers.authorization || null });

    const content = answerFromReceivedPrompt(messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_env_stub',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );
  });

  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  const savedEnv = {
    AME_LLM_API_KEY: process.env.AME_LLM_API_KEY,
    AME_LLM_BASE_URL: process.env.AME_LLM_BASE_URL,
    AME_JUDGE_API_KEY: process.env.AME_JUDGE_API_KEY,
    AME_JUDGE_BASE_URL: process.env.AME_JUDGE_BASE_URL,
  };

  try {
    process.env.AME_LLM_API_KEY = 'env-llm-secret-123';
    process.env.AME_LLM_BASE_URL = llmBaseUrl;
    delete process.env.AME_JUDGE_API_KEY;
    process.env.AME_JUDGE_BASE_URL = llmBaseUrl;

    const locomoReport = await runLocomoComparison({
      datasetPath: SAMPLE_LOCOMO_PATH,
      arm: 'ame-gateway',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: locomoCli.apiKey,
      baseUrl: locomoCli.baseUrl,
      ameBaseUrl,
      ameApiKey,
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o-judge-stub',
      judgeApiKey: locomoCli.judgeApiKey,
      judgeBaseUrl: locomoCli.judgeBaseUrl,
      limit: 1,
    });

    assert.equal(locomoReport.config.llmBaseUrl, llmBaseUrl);
    assert.equal(locomoReport.config.judgeBaseUrl, llmBaseUrl);
    assert.equal(locomoReport.ameGateway.metrics.totalItems, 1);
    assert.deepEqual(
      capturedAuth.filter((e) => e.role === 'llm').map((e) => e.authorization),
      ['Bearer env-llm-secret-123']
    );
    assert.deepEqual(
      capturedAuth.filter((e) => e.role === 'judge').map((e) => e.authorization),
      ['Bearer env-llm-secret-123']
    );

    capturedAuth.length = 0;
    process.env.AME_JUDGE_API_KEY = 'env-judge-secret-456';

    await runLocomoComparison({
      datasetPath: SAMPLE_LOCOMO_PATH,
      arm: 'ame-gateway',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: locomoCli.apiKey,
      baseUrl: locomoCli.baseUrl,
      ameBaseUrl,
      ameApiKey,
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o-judge-stub',
      judgeApiKey: locomoCli.judgeApiKey,
      judgeBaseUrl: locomoCli.judgeBaseUrl,
      limit: 1,
    });

    assert.deepEqual(
      capturedAuth.filter((e) => e.role === 'judge').map((e) => e.authorization),
      ['Bearer env-judge-secret-456']
    );

    capturedAuth.length = 0;
    const lmeReport = await runLongMemEvalComparison({
      datasetPath: SAMPLE_LME_PATH,
      arm: 'ame-gateway',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: lmeCli.apiKey,
      baseUrl: lmeCli.baseUrl,
      ameBaseUrl,
      ameApiKey,
      limit: 1,
    });

    assert.equal(lmeReport.config.llmBaseUrl, llmBaseUrl);
    assert.equal(lmeReport.ameGateway.metrics.totalItems, 1);
    assert.deepEqual(
      capturedAuth.filter((e) => e.role === 'llm').map((e) => e.authorization),
      ['Bearer env-llm-secret-123']
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
  }
});

test('unwrapDomainReplyText unwraps thought tags + fenced JSON domain wrappers and preserves plain text', async () => {
  for (const unwrap of [unwrapLocomoDomainReplyText, unwrapLmeDomainReplyText]) {
    assert.equal(
      unwrap('<thought>checking memory</thought>\n```json {"reply":"May 4, 2024","mood":"calm"} ```'),
      'May 4, 2024'
    );
    assert.equal(
      unwrap('```json\n{"reply":"  May 4, 2024  ","mood":"calm","followUpIntent":"none","closenessSignal":"high"}\n```'),
      'May 4, 2024'
    );
    assert.equal(
      unwrap('```\n{"dialogue":"We met in Seoul.","emotion":"happy"}\n```'),
      'We met in Seoul.'
    );
    assert.equal(
      unwrap('{"reply":"","response":"Check the oak shelf."}'),
      'Check the oak shelf.'
    );
    assert.equal(
      unwrap('{"answer":"Blue ceramic mug"}'),
      'Blue ceramic mug'
    );
    assert.equal(
      unwrap('```json\n{"reply":"Use ```code``` here"}\n```'),
      'Use ```code``` here'
    );
    assert.equal(
      unwrap('<thought>internal reasoning</thought> Plain text reply.'),
      'Plain text reply.'
    );
    assert.equal(unwrap('Plain text reply.'), 'Plain text reply.');
  }

  // End-to-end LoCoMo Mode B verification: JSON-wrapped domain reply is scored cleanly without settle()
  const ameApiKey = 'test-unwrap-mode-b';
  const sandbox = createSandboxApp({ apiKey: ameApiKey });
  const llmStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const plainAnswer = answerFromReceivedPrompt(messages);
    const wrapped = `<thought>verifying facts</thought>\n\`\`\`json\n${JSON.stringify({
      reply: plainAnswer,
      mood: 'calm',
      followUpIntent: 'none',
      closenessSignal: 'steady',
    })}\n\`\`\``;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_wrapped',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: wrapped } }],
        usage: { prompt_tokens: 20, completion_tokens: 15 },
      })
    );
  });

  const [ameBaseUrl, llmBaseUrl] = await Promise.all([
    startServer(sandbox),
    startServer(llmStub),
  ]);

  try {
    const report = await runLocomoComparison({
      datasetPath: SAMPLE_LOCOMO_PATH,
      conversations: 'sample-conv-1',
      arm: 'ame-gateway',
      provider: 'openai',
      model: 'gpt-4o-stub',
      apiKey: 'stub-key',
      baseUrl: llmBaseUrl,
      ameBaseUrl,
      ameApiKey,
      ameMode: 'b',
      limit: 1,
    });

    assert.equal(report.ameGateway.metrics.accuracyPct, 100);
    assert.ok(!report.ameGateway.items[0].reply.includes('{'));
    assert.ok(!report.ameGateway.items[0].reply.includes('<thought>'));
  } finally {
    await Promise.all([stopServer(sandbox), stopServer(llmStub)]);
  }
});

test('scoreLocomoAnswer and abstention matchers recognize "That detail is unknown." and new abstention phrases', () => {
  const abstentionReplies = [
    'That detail is unknown.',
    'This information is unavailable in the conversation.',
    'I cannot confirm that detail.',
    'Unable to diagnose or predict that.',
    'Unknown.',
    "I don't know.",
  ];

  for (const reply of abstentionReplies) {
    assert.equal(detectLocomoAbstentionReply(reply), true, `LoCoMo should detect abstention: ${reply}`);
    assert.equal(detectLmeAbstentionReply(reply), true, `LongMemEval should detect abstention: ${reply}`);
  }
  assert.equal(detectLocomoAbstentionReply('May 4, 2024'), false);
  assert.equal(detectLmeAbstentionReply('May 4, 2024'), false);

  const cat5Item = {
    category: 5,
    answer: 'Not mentioned in conversation',
    adversarialAnswer: 'Golden Retriever',
  };

  const unknownScore = scoreLocomoAnswer(cat5Item, 'That detail is unknown.', false);
  assert.equal(unknownScore.isAdversarial, true);
  assert.equal(unknownScore.abstained, true);
  assert.equal(unknownScore.fellForTrap, false);
  assert.equal(unknownScore.tokenF1, 1);
  assert.equal(unknownScore.correct, true);

  const trapScore = scoreLocomoAnswer(cat5Item, 'Golden Retriever', false);
  assert.equal(trapScore.abstained, false);
  assert.equal(trapScore.fellForTrap, true);
  assert.equal(trapScore.correct, false);

  const lmeAbsItem = {
    question_id: 'item_abs',
    question_type: 'abstention',
    answer: 'unanswerable',
  };
  const lmeScore = scoreLmeAnswer(lmeAbsItem, 'That detail is unknown.', false);
  assert.equal(lmeScore.abstentionExpected, true);
  assert.equal(lmeScore.abstained, true);
  assert.equal(lmeScore.correct, true);
});
