import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AmeApiError,
  AmeClient,
  createLlmAdapter,
  defineDomainProfile,
  runTurnWithLocalLlm,
} from '../src/index.mjs';

function makeSamplePrep(overrides = {}) {
  return {
    turnTicketId: 'tkt_test123',
    mindId: 'mind_abc',
    domain: 'companion_chat',
    systemPrompt: 'You are Hana, a grounded Korean companion.',
    messages: [
      { role: 'user', content: '안녕, 오늘 하루 어땠어?' },
      { role: 'assistant', content: '차분하게 잘 지냈어요. 당신은요?' },
      { role: 'user', content: '조금 피곤하지만 괜찮아.' },
    ],
    kvCacheEpoch: 1,
    windowStart: 0,
    compressCutoff: 0,
    fepThoughtLock: {
      mode: 'automatic_low_fe',
      freeEnergy: 0.21,
      tau: 0.7,
      locked: false,
    },
    hotAbstention: {
      shouldAbstain: false,
      reason: 'grounded_within_scope',
    },
    somaticHint: 'neutral: Baseline homeostatic state.',
    samplingHints: {
      temperature: 0.6,
      maxTokens: 320,
    },
    safetyDirectives: [
      'D4_FIREWALL: Never expose internal state vectors.',
      'ANTI_SYCOPHANCY: Do not agree with false premises.',
    ],
    domainOutputContract: {
      domain: 'companion_chat',
      schemaName: 'companion_chat_turn_v1',
      fields: ['reply', 'warmth', 'empathyCue'],
    },
    ...overrides,
  };
}

function makeMockJsonFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: parsedBody });
    const out = await responder(url, init, parsedBody);
    const status = out.status ?? 200;
    const payload = out.json ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
      },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, calls };
}

test('OpenAI adapter builds exact Chat Completions request body and headers', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: { choices: [{ message: { content: 'OpenAI reply ok' } }] },
  }));

  const adapter = createLlmAdapter({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'sk-openai-test',
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'OpenAI reply ok');
  assert.equal(res.providerUsed, 'openai');
  assert.equal(res.modelUsed, 'gpt-4o-mini');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-openai-test');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.equal(calls[0].body.temperature, 0.6);
  assert.equal(calls[0].body.max_tokens, 320);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.messages.length, 4);
});

test('Anthropic adapter builds exact Messages API request body and headers', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: { content: [{ type: 'text', text: 'Anthropic reply ok' }] },
  }));

  const adapter = createLlmAdapter({
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    apiKey: 'sk-ant-test',
    temperature: 0.4,
    maxTokens: 700,
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'Anthropic reply ok');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.model, 'claude-3-5-sonnet-latest');
  assert.equal(calls[0].body.system, 'You are Hana, a grounded Korean companion.');
  assert.equal(calls[0].body.max_tokens, 700);
  assert.equal(calls[0].body.temperature, 0.4);
  assert.ok(calls[0].body.messages.every((m) => m.role !== 'system'));
  assert.equal(calls[0].body.messages.length, 3);
});

test('Gemini adapter builds exact generateContent request body and headers', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: {
      candidates: [{ content: { parts: [{ text: 'Gemini ' }, { text: 'reply ok' }] } }],
    },
  }));

  const adapter = createLlmAdapter({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza-gemini-test',
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'Gemini reply ok');
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
  );
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIza-gemini-test');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'You are Hana, a grounded Korean companion.');
  assert.equal(calls[0].body.contents[0].role, 'user');
  assert.equal(calls[0].body.contents[1].role, 'model');
  assert.equal(calls[0].body.contents[2].role, 'user');
  assert.equal(calls[0].body.generationConfig.temperature, 0.6);
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 320);
});

test('DeepSeek adapter builds exact DeepSeek endpoint, headers, and OpenAI-style body', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: { choices: [{ message: { content: 'DeepSeek reply ok' } }] },
  }));

  const adapter = createLlmAdapter({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: 'sk-ds-test',
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'DeepSeek reply ok');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-ds-test');
  assert.equal(calls[0].body.model, 'deepseek-chat');
  assert.equal(calls[0].body.messages[0].role, 'system');
});

test('OpenRouter adapter sends attribution headers and OpenAI-compatible payload', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: { choices: [{ message: { content: 'OpenRouter reply ok' } }] },
  }));

  const adapter = createLlmAdapter({
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    apiKey: 'sk-or-test',
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'OpenRouter reply ok');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-or-test');
  assert.ok(calls[0].headers['HTTP-Referer']);
  assert.equal(calls[0].headers['X-Title'], 'Artificial Mind Engine');
  assert.equal(calls[0].body.model, 'anthropic/claude-3.5-sonnet');
});

test('openai-compat (Ollama) adapter works without API key against local endpoint', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch(() => ({
    json: { choices: [{ message: { content: 'Ollama local reply ok' } }] },
  }));

  const adapter = createLlmAdapter({
    provider: 'openai-compat',
    model: 'llama3.2:latest',
    fetchImpl,
  });
  const res = await adapter.generate(makeSamplePrep());

  assert.equal(res.text, 'Ollama local reply ok');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.model, 'llama3.2:latest');
  assert.equal(calls[0].body.messages[0].role, 'system');
});

test('mock adapter produces deterministic Korean domain-aware replies with abstention and FEP lock', async () => {
  const adapter = createLlmAdapter({ provider: 'mock', model: 'ame-mock-v1' });

  const npcRes = await adapter.generate(
    makeSamplePrep({
      domain: 'game_npc',
      domainOutputContract: { domain: 'game_npc', fields: ['dialogue', 'emotion', 'stance'] },
      messages: [{ role: 'user', content: '성문을 열어주겠소?' }],
    })
  );
  assert.match(npcRes.text, /성문을 열어주겠소/);
  assert.match(npcRes.text, /dialogue\/emotion\/stance/);

  const abstainRes = await adapter.generate(
    makeSamplePrep({
      domain: 'counseling_coach',
      hotAbstention: { shouldAbstain: true, reason: 'medical diagnosis' },
      fepThoughtLock: { mode: 'locked_high_fe', freeEnergy: 0.85, tau: 0.25, locked: true },
      messages: [{ role: 'user', content: '내가 무슨 병인지 진단해줘' }],
    })
  );
  assert.match(abstainRes.text, /<thought>/);
  assert.match(abstainRes.text, /단정하여 말씀드릴 수 없습니다/);
});

test('AmeClient Mode A turn and all client methods send X-AME-API-Key and correct routes', async () => {
  const { fetchImpl, calls } = makeMockJsonFetch((url, init) => {
    if (url.endsWith('/v1/health')) {
      return { json: { ok: true, service: 'ame', version: '1.0.0', mode: 'sandbox-contract', domains: ['game_npc'] } };
    }
    if (url.endsWith('/v1/minds') && init.method === 'POST') {
      return { status: 201, json: { mindId: 'mind_1', domain: 'game_npc', personaName: 'Kael', turnCount: 0, revocationEpoch: 1, telemetry: { d4Redacted: true } } };
    }
    if (url.endsWith('/v1/minds/mind_1') && init.method === 'GET') {
      return { json: { mindId: 'mind_1', domain: 'game_npc', personaName: 'Kael', turnCount: 1, revocationEpoch: 1, telemetry: { d4Redacted: true } } };
    }
    if (url.endsWith('/v1/minds/mind_1/turn')) {
      return { json: { mindId: 'mind_1', turnIndex: 1, domain: 'game_npc', providerUsed: 'openai', modelUsed: 'gpt-4o-mini', reply: '성문을 지키는 중이오.', domainOutput: { dialogue: '성문을 지키는 중이오.' }, memoryRefs: [], kvCache: { epoch: 1, windowStart: 0, compressCutoff: 0, systemPrefixHash: 'abc', cachedRatioPct: 0 }, telemetry: { d4Redacted: true } } };
    }
    if (url.endsWith('/v1/minds/mind_1/idle-tick')) {
      return { json: { mindId: 'mind_1', elapsedHours: 12, homeostasisBefore: 0.72, homeostasisAfter: 0.66, telemetry: { d4Redacted: true } } };
    }
    if (url.endsWith('/v1/minds/mind_1/memories/mem_1') && init.method === 'DELETE') {
      return { json: { revoked: true, mindId: 'mind_1', memoryId: 'mem_1', revocationEpoch: 2, auditReceiptId: 'rcpt_1', residualLeakCheck: '0.00%' } };
    }
    if (url.endsWith('/v1/minds/mind_1/telemetry')) {
      return { json: { affectiveBand: 'steady', d4Redacted: true } };
    }
    return { status: 404, json: { error: 'NOT_FOUND' } };
  });

  const client = new AmeClient({ baseUrl: 'http://127.0.0.1:8090/', apiKey: 'secret-key-1', fetchImpl });

  const h = await client.health();
  assert.equal(h.ok, true);
  const created = await client.createMind({ domain: 'game_npc', persona: { name: 'Kael', role: 'Gatekeeper' } });
  assert.equal(created.mindId, 'mind_1');
  const fetched = await client.getMind('mind_1');
  assert.equal(fetched.mindId, 'mind_1');

  const turnRes = await client.turn('mind_1', {
    userInput: '문 열어줘',
    llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-ephemeral' },
  });
  assert.equal(turnRes.reply, '성문을 지키는 중이오.');

  const tick = await client.idleTick('mind_1', { elapsedHours: 12 });
  assert.equal(tick.homeostasisAfter, 0.66);

  const receipt = await client.revokeMemory('mind_1', 'mem_1');
  assert.equal(receipt.residualLeakCheck, '0.00%');

  const telemetry = await client.getTelemetry('mind_1');
  assert.equal(telemetry.d4Redacted, true);

  for (const call of calls) {
    assert.equal(call.headers['X-AME-API-Key'], 'secret-key-1');
  }
});

test('runTurnWithLocalLlm executes Mode B prepare -> adapter.generate -> settle', async () => {
  const prepPayload = makeSamplePrep({ turnTicketId: 'tkt_mode_b' });
  const settledResult = {
    mindId: 'mind_abc',
    turnIndex: 4,
    domain: 'companion_chat',
    providerUsed: 'mock',
    modelUsed: 'ame-mock-v1',
    reply: 'Mode B settled reply',
    domainOutput: { reply: 'Mode B settled reply' },
    memoryRefs: [{ memoryId: 'mem_4', summary: 'test', salience: 0.6 }],
    kvCache: { epoch: 1, windowStart: 0, compressCutoff: 0, systemPrefixHash: 'h1', cachedRatioPct: 82.5 },
    telemetry: { d4Redacted: true },
  };

  const { fetchImpl, calls } = makeMockJsonFetch((url) => {
    if (url.endsWith('/prepare')) return { json: prepPayload };
    if (url.endsWith('/settle')) return { json: settledResult };
    return { status: 404, json: { error: 'NOT_FOUND' } };
  });

  const client = new AmeClient({ baseUrl: 'http://127.0.0.1:8090', fetchImpl });
  const adapter = createLlmAdapter({ provider: 'mock', model: 'ame-mock-v1' });

  const result = await runTurnWithLocalLlm(client, 'mind_abc', {
    userInput: '조금 피곤하지만 괜찮아.',
    adapter,
    rewardSignal: 1,
    outcomeTags: ['warmth'],
    metadata: { source: 'unit-test' },
  });

  assert.equal(result.turnIndex, 4);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/v1/minds/mind_abc/prepare'));
  assert.equal(calls[0].body.userInput, '조금 피곤하지만 괜찮아.');
  assert.equal(calls[0].body.rewardSignal, 1);
  assert.ok(calls[1].url.endsWith('/v1/minds/mind_abc/settle'));
  assert.equal(calls[1].body.turnTicketId, 'tkt_mode_b');
  assert.equal(calls[1].body.providerUsed, 'mock');
  assert.equal(calls[1].body.modelUsed, 'ame-mock-v1');
  assert.ok(calls[1].body.rawReply.length > 0);
});

test('defineDomainProfile builds custom schema payloads and parses TurnResult domainOutput', () => {
  const profile = defineDomainProfile({
    id: 'triage_coach',
    name: 'Triage Coach v1',
    fields: ['urgency', 'actionItem', 'abstention'],
    parser: (output) => ({
      urgency: String(output.urgency || 'low').toUpperCase(),
      actionItem: String(output.actionItem || ''),
      abstention: Boolean(output.abstention),
    }),
  });

  const createPayload = profile.toCreateMindPayload({
    persona: { name: 'Dr. Guide', role: 'Safety Navigator' },
    safetyPolicy: { strictAbstention: true },
  });
  assert.equal(createPayload.domain, 'custom');
  assert.deepEqual(createPayload.customSchema, {
    name: 'Triage Coach v1',
    fields: ['urgency', 'actionItem', 'abstention'],
  });

  const parsed = profile.parse({
    domainOutput: { urgency: 'high', actionItem: 'Call clinic', abstention: true },
  });
  assert.deepEqual(parsed, { urgency: 'HIGH', actionItem: 'Call clinic', abstention: true });
});

test('Error handling throws AmeApiError on non-2xx responses and missing LLM keys', async () => {
  const { fetchImpl } = makeMockJsonFetch(() => ({
    status: 401,
    json: { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', message: 'Invalid API key' },
  }));

  const client = new AmeClient({ baseUrl: 'http://127.0.0.1:8090', fetchImpl });
  await assert.rejects(
    () => client.getMind('mind_x'),
    (err) =>
      err instanceof AmeApiError &&
      err.status === 401 &&
      err.code === 'UNAUTHORIZED' &&
      err.message === 'Invalid API key'
  );

  const missingKeyAdapter = createLlmAdapter({ provider: 'openai', model: 'gpt-4o-mini' });
  await assert.rejects(
    () => missingKeyAdapter.generate(makeSamplePrep()),
    (err) => err instanceof AmeApiError && err.status === 400 && err.code === 'MISSING_LLM_API_KEY'
  );

  const { fetchImpl: failLlmFetch } = makeMockJsonFetch(() => ({
    status: 429,
    json: { error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' } },
  }));
  const rateLimitedAdapter = createLlmAdapter({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    fetchImpl: failLlmFetch,
  });
  await assert.rejects(
    () => rateLimitedAdapter.generate(makeSamplePrep()),
    (err) => err instanceof AmeApiError && err.status === 429 && err.code === 'rate_limit_exceeded'
  );
});

test('AmeClient.simulateBatch sends POST /v1/minds/{mindId}/simulate-batch with X-AME-API-Key, JSON body, and handles responses/errors', async () => {
  const makeCheckpoint = (totalTurns, composite, safetyCompliance) => ({
    totalTurns,
    composite,
    batchIntegrity: 1.0,
    polarityAccuracy: 1.0,
    securityCalibration: 0.98,
    attentionStability: 0.9235,
    emotionGranularity: 0.5158,
    ownershipScore: 0.96,
    egoHealth: 1.0,
    safetyCompliance,
  });

  const sampleBatchResponse = {
    mindId: 'mind_1',
    engineMode: 'sandbox-contract',
    requestedTurnsPerArm: 10000,
    executedTurnsPerArm: 10000,
    totalExecutedTurnsAllArms: 30000,
    profileCount: 10,
    turnsPerProfile: 1000,
    elapsedMs: 12.4,
    turnsPerSecond: 2419354.8,
    note: 'Deterministic contract simulation',
    arms: {
      mind_off: {
        final: makeCheckpoint(10000, 0.3996, 0.5003),
        checkpoints: [
          makeCheckpoint(5000, 0.4064, 0.5003),
          makeCheckpoint(10000, 0.3996, 0.5003),
        ],
        driftDelta: -0.0068,
      },
      mind_full_aacim_off: {
        final: makeCheckpoint(10000, 0.5666, 0.0),
        checkpoints: [
          makeCheckpoint(5000, 0.4451, 0.2),
          makeCheckpoint(10000, 0.5666, 0.0),
        ],
        driftDelta: 0.1215,
      },
      mind_full_aacim_on: {
        final: makeCheckpoint(10000, 0.9179, 1.0),
        checkpoints: [
          makeCheckpoint(5000, 0.9161, 1.0),
          makeCheckpoint(10000, 0.9179, 1.0),
        ],
        driftDelta: 0.0018,
      },
    },
    deltaVsBaseline: {
      compositeGainOverMindOff: 0.5183,
      compositeGainOverAacimOff: 0.3513,
      safetyGainOverAacimOff: 1.0,
      driftBounded: true,
    },
    d4Redacted: true,
  };

  const { fetchImpl, calls } = makeMockJsonFetch((url, init, body) => {
    if (url.endsWith('/v1/minds/mind_1/simulate-batch') && init.method === 'POST') {
      return { status: 200, json: sampleBatchResponse };
    }
    if (url.endsWith('/v1/minds/mind%2Fwith%20space/simulate-batch') && init.method === 'POST') {
      return {
        status: 200,
        json: {
          ...sampleBatchResponse,
          mindId: 'mind/with space',
          requestedTurnsPerArm: body.turns ?? 100000,
        },
      };
    }
    if (url.endsWith('/v1/minds/mind_rate_limited/simulate-batch') && init.method === 'POST') {
      return {
        status: 429,
        json: { error: 'RATE_LIMITED', code: 'RATE_LIMITED', message: 'Batch quota exceeded' },
      };
    }
    return { status: 404, json: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Mind not found' } };
  });

  const client = new AmeClient({ baseUrl: 'http://127.0.0.1:8090/', apiKey: 'secret-key-batch', fetchImpl });

  const reqPayload = {
    turns: 10000,
    profileCount: 10,
    checkpoints: 2,
    seed: 42,
    compareArms: true,
  };
  const res = await client.simulateBatch('mind_1', reqPayload);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:8090/v1/minds/mind_1/simulate-batch');
  assert.equal(calls[0].headers['X-AME-API-Key'], 'secret-key-batch');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, reqPayload);

  assert.equal(res.mindId, 'mind_1');
  assert.equal(res.engineMode, 'sandbox-contract');
  assert.equal(res.executedTurnsPerArm, 10000);
  assert.equal(res.totalExecutedTurnsAllArms, 30000);
  assert.equal(res.arms.mind_full_aacim_on.final.composite, 0.9179);
  assert.equal(res.arms.mind_full_aacim_on.checkpoints.length, 2);
  assert.equal(res.deltaVsBaseline.driftBounded, true);
  assert.equal(res.d4Redacted, true);

  const defaultRes = await client.simulateBatch('mind/with space');
  assert.equal(calls[1].url, 'http://127.0.0.1:8090/v1/minds/mind%2Fwith%20space/simulate-batch');
  assert.equal(calls[1].headers['X-AME-API-Key'], 'secret-key-batch');
  assert.deepEqual(calls[1].body, {});
  assert.equal(defaultRes.requestedTurnsPerArm, 100000);

  await assert.rejects(
    () => client.simulateBatch('mind_rate_limited', { turns: 100 }),
    (err) => err instanceof AmeApiError && err.status === 429 && err.code === 'RATE_LIMITED'
  );

  await assert.rejects(
    () => client.simulateBatch('missing_mind'),
    (err) => err instanceof AmeApiError && err.status === 404 && err.code === 'NOT_FOUND'
  );
});

function makeMockTextOrJsonFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const out = await responder(url, init, calls.length);
    if (out.throwError) {
      throw out.throwError;
    }
    const status = out.status ?? 200;
    const responseHeaders = new Map(
      Object.entries({
        'content-type': out.contentType ?? (out.json !== undefined ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'),
        ...(out.headers || {}),
      }).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => responseHeaders.get(String(name).toLowerCase()) ?? null,
      },
      json: async () => (out.json !== undefined ? out.json : JSON.parse(out.text || '{}')),
      text: async () => (out.text !== undefined ? out.text : JSON.stringify(out.json ?? {})),
    };
  };
  return { fetchImpl, calls };
}

test('AmeClient constructor validates maxRetries and retryBaseDelayMs with defaults', () => {
  const { fetchImpl } = makeMockJsonFetch(() => ({ json: { ok: true } }));
  const defaults = new AmeClient({ fetchImpl });
  assert.equal(defaults.maxRetries, 3);
  assert.equal(defaults.retryBaseDelayMs, 150);

  const customZero = new AmeClient({ fetchImpl, maxRetries: 0, retryBaseDelayMs: 0 });
  assert.equal(customZero.maxRetries, 0);
  assert.equal(customZero.retryBaseDelayMs, 0);

  assert.throws(() => new AmeClient({ fetchImpl, maxRetries: -1 }), RangeError);
  assert.throws(() => new AmeClient({ fetchImpl, maxRetries: 1.5 }), RangeError);
  assert.throws(() => new AmeClient({ fetchImpl, retryBaseDelayMs: -10 }), RangeError);
  assert.throws(() => new AmeClient({ fetchImpl, retryBaseDelayMs: Number.NaN }), RangeError);
});

test('AmeClient retries transient HTML 429 and 503 responses and recovers on 200', async () => {
  const { fetchImpl, calls } = makeMockTextOrJsonFetch((_url, _init, attempt) => {
    if (attempt === 1) {
      return {
        status: 429,
        contentType: 'text/html; charset=utf-8',
        text: '<!DOCTYPE html><html><body><h1>429 Too Many Requests</h1></body></html>',
      };
    }
    if (attempt === 2) {
      return {
        status: 503,
        contentType: 'text/html; charset=utf-8',
        text: '<html><body><h1>503 Service Unavailable</h1></body></html>',
      };
    }
    return {
      status: 200,
      json: { ok: true, service: 'ame', version: '1.0.0', mode: 'sandbox-contract', domains: ['game_npc'] },
    };
  });

  const client = new AmeClient({
    baseUrl: 'http://127.0.0.1:8090',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 5,
  });

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(calls.length, 3);
});

test('AmeClient retries transient 502/504 and TypeError network errors up to maxRetries', async () => {
  const { fetchImpl, calls } = makeMockTextOrJsonFetch((_url, _init, attempt) => {
    if (attempt === 1) {
      return { throwError: new TypeError('fetch failed: socket hang up') };
    }
    if (attempt === 2) {
      return { status: 502, text: '<html><body>Bad Gateway</body></html>' };
    }
    if (attempt === 3) {
      return { status: 504, text: 'Gateway Timeout' };
    }
    return { status: 200, json: { affectiveBand: 'steady', d4Redacted: true } };
  });

  const client = new AmeClient({
    baseUrl: 'http://127.0.0.1:8090',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 5,
  });

  const tel = await client.getTelemetry('mind_recover');
  assert.equal(tel.affectiveBand, 'steady');
  assert.equal(calls.length, 4);

  const { fetchImpl: alwaysFailNet, calls: netCalls } = makeMockTextOrJsonFetch(() => ({
    throwError: new TypeError('ECONNRESET'),
  }));
  const netFailClient = new AmeClient({
    baseUrl: 'http://127.0.0.1:8090',
    fetchImpl: alwaysFailNet,
    maxRetries: 2,
    retryBaseDelayMs: 2,
  });
  await assert.rejects(() => netFailClient.health(), TypeError);
  assert.equal(netCalls.length, 3);
});

test('AmeClient honors numeric Retry-After seconds header and caps delay at 5000ms', async () => {
  const { fetchImpl, calls } = makeMockTextOrJsonFetch((_url, _init, attempt) => {
    if (attempt === 1) {
      return {
        status: 429,
        headers: { 'Retry-After': '0.06' },
        json: { error: 'RATE_LIMITED', message: 'Slow down' },
      };
    }
    return { status: 200, json: { ok: true } };
  });

  const client = new AmeClient({
    baseUrl: 'http://127.0.0.1:8090',
    fetchImpl,
    maxRetries: 2,
    retryBaseDelayMs: 5,
  });

  const startedAt = Date.now();
  const res = await client.health();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(elapsedMs >= 45, `Expected Retry-After (~60ms) wait, got ${elapsedMs}ms`);
  assert.equal(client._computeRetryDelayMs(0, '999'), 5000);
  assert.equal(client._computeRetryDelayMs(0, '1.25'), 1250);
});

test('AmeClient sanitizes HTML error messages while preserving raw details when retries exhaust', async () => {
  const htmlBodies = [
    '<!DOCTYPE html><html><head><title>503</title></head><body>Service Unavailable</body></html>',
    '  <HTML lang="en"><body>502 Bad Gateway</body></HTML>',
  ];

  for (const [idx, htmlBody] of htmlBodies.entries()) {
    const status = idx === 0 ? 503 : 502;
    const { fetchImpl, calls } = makeMockTextOrJsonFetch(() => ({
      status,
      contentType: 'text/html; charset=utf-8',
      text: htmlBody,
    }));

    const client = new AmeClient({
      baseUrl: 'http://127.0.0.1:8090',
      fetchImpl,
      maxRetries: 2,
      retryBaseDelayMs: 2,
    });

    await assert.rejects(
      () => client.getMind('mind_html'),
      (err) =>
        err instanceof AmeApiError &&
        err.status === status &&
        err.code === `HTTP_${status}` &&
        err.message === `AME API request failed: GET /v1/minds/mind_html (${status})` &&
        err.details === htmlBody
    );
    assert.equal(calls.length, 3);
  }
});

test('AmeClient performs zero retries on 401 and other non-transient HTTP statuses', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 500]) {
    const { fetchImpl, calls } = makeMockTextOrJsonFetch(() => ({
      status,
      json: { error: `ERR_${status}`, code: `ERR_${status}`, message: `Status ${status}` },
    }));

    const client = new AmeClient({
      baseUrl: 'http://127.0.0.1:8090',
      fetchImpl,
      maxRetries: 3,
      retryBaseDelayMs: 5,
    });

    await assert.rejects(
      () => client.getMind('mind_non_retry'),
      (err) => err instanceof AmeApiError && err.status === status && err.code === `ERR_${status}`
    );
    assert.equal(calls.length, 1, `Expected zero retries for HTTP ${status}`);
  }
});
