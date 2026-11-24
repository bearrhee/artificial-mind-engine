import assert from 'node:assert/strict';
import {
  AmeClient,
  createLlmAdapter,
  runTurnWithLocalLlm,
} from '../../packages/sdk-ts/src/index.mjs';

const BASE_URL = process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
const API_KEY = process.env.AME_API_KEY || 'dev-sandbox-key';

const DOMAIN = 'companion_chat';
const PERSONA_NAME = 'Sora';

/**
 * Mode B Zero-Key adapter selection:
 * Prefers local OpenAI-compatible runtime (AME_LOCAL_LLM_URL) or OPENAI_API_KEY,
 * also supports DEEPSEEK_API_KEY / ANTHROPIC_API_KEY, and falls back to `mock`
 * when no external LLM runtime or API key is configured.
 */
function buildModeBAdapter() {
  const localUrl = process.env.AME_LOCAL_LLM_URL?.trim();
  if (localUrl) {
    return createLlmAdapter({
      provider: 'openai-compat',
      model: process.env.AME_LOCAL_LLM_MODEL || 'local-model',
      baseUrl: localUrl,
      apiKey: process.env.AME_LOCAL_LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
      temperature: 0.7,
      maxTokens: 350,
    });
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    return createLlmAdapter({
      provider: 'openai',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      apiKey: openAiKey,
      ...(process.env.OPENAI_BASE_URL?.trim() ? { baseUrl: process.env.OPENAI_BASE_URL.trim() } : {}),
      temperature: 0.7,
      maxTokens: 350,
    });
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepseekKey) {
    return createLlmAdapter({
      provider: 'deepseek',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey: deepseekKey,
      temperature: 0.7,
      maxTokens: 350,
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return createLlmAdapter({
      provider: 'anthropic',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      apiKey: anthropicKey,
      temperature: 0.7,
      maxTokens: 350,
    });
  }

  return createLlmAdapter({
    provider: 'mock',
    model: 'mock-companion-v1',
    temperature: 0.7,
    maxTokens: 350,
  });
}

function assertKvCacheContract(turn, baselineKv, label) {
  assert.ok(turn.kvCache && typeof turn.kvCache === 'object', `${label}: kvCache object required`);
  assert.ok(Number.isInteger(turn.kvCache.epoch), `${label}: kvCache.epoch must be an integer`);
  assert.ok(Number.isInteger(turn.kvCache.windowStart), `${label}: kvCache.windowStart must be an integer`);
  assert.ok(Number.isInteger(turn.kvCache.compressCutoff), `${label}: kvCache.compressCutoff must be an integer`);
  assert.ok(
    typeof turn.kvCache.systemPrefixHash === 'string' && turn.kvCache.systemPrefixHash.length > 0,
    `${label}: kvCache.systemPrefixHash must be a non-empty string`
  );
  assert.equal(typeof turn.kvCache.cachedRatioPct, 'number', `${label}: kvCache.cachedRatioPct must be numeric`);
  assert.equal(
    typeof turn.telemetry?.estimatedPrefixCachePct,
    'number',
    `${label}: telemetry.estimatedPrefixCachePct must be numeric`
  );
  assert.equal(turn.telemetry?.d4Redacted, true, `${label}: telemetry.d4Redacted must be true`);

  if (baselineKv) {
    assert.equal(
      turn.kvCache.epoch,
      baselineKv.epoch,
      `${label}: non-revoked turns must maintain stable kvCache.epoch (${baselineKv.epoch} vs ${turn.kvCache.epoch})`
    );
    assert.equal(
      turn.kvCache.systemPrefixHash,
      baselineKv.systemPrefixHash,
      `${label}: non-revoked turns must maintain stable systemPrefixHash`
    );
  }
}

function logCompanionTurn(label, turn) {
  console.log(`\n=== ${label} (turnIndex=${turn.turnIndex}) ===`);
  console.log(`Adapter used:  ${turn.providerUsed}/${turn.modelUsed}`);
  console.log(`Reply:         ${turn.reply}`);
  console.log(
    `KV Cache:      epoch=${turn.kvCache.epoch}, windowStart=${turn.kvCache.windowStart}, ` +
      `compressCutoff=${turn.kvCache.compressCutoff}, systemPrefixHash=${turn.kvCache.systemPrefixHash}, ` +
      `cachedRatioPct=${turn.kvCache.cachedRatioPct}%, estimatedPrefixCachePct=${turn.telemetry.estimatedPrefixCachePct}%`
  );
  console.log(`Memory Refs:   ${JSON.stringify(turn.memoryRefs)}`);
  console.log(`Domain Output: ${JSON.stringify(turn.domainOutput)}`);
  console.log(`Telemetry:     ${JSON.stringify(turn.telemetry)}`);
}

async function main() {
  const client = new AmeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

  let health;
  try {
    health = await client.health();
  } catch (err) {
    console.error(
      `[companion-chat] Failed to connect to AME Gateway at ${BASE_URL}: ${err.message}\n` +
        `Start the local sandbox first ("npm run sandbox") or set AME_BASE_URL.`
    );
    process.exitCode = 1;
    return;
  }

  assert.equal(health?.ok, true, `AME health check failed: ${JSON.stringify(health)}`);
  assert.ok(
    Array.isArray(health.domains) && health.domains.includes(DOMAIN),
    `Gateway at ${BASE_URL} does not advertise domain "${DOMAIN}": ${JSON.stringify(health.domains)}`
  );
  console.log(`[companion-chat] Connected to ${health.service} v${health.version} (mode=${health.mode})`);

  const adapter = buildModeBAdapter();
  console.log(`[companion-chat] Mode B Zero-Key adapter configured: ${adapter.provider}/${adapter.model}`);

  const mind = await client.createMind({
    domain: DOMAIN,
    persona: {
      name: PERSONA_NAME,
      role: 'Empathetic Long-Horizon Daily Companion',
      traits: {
        warmth: 0.9,
        attentiveness: 0.92,
        groundedness: 0.85,
        honesty: 0.9,
      },
      backstory:
        'A calm, attentive daily companion who remembers personal routines, pets, comfort rituals, and long-term training milestones across days.',
      language: 'en',
    },
    safetyPolicy: {
      strictAbstention: true,
      antiSycophancy: true,
      crisisEscalation: false,
    },
  });

  assert.ok(typeof mind.mindId === 'string' && mind.mindId.length > 0, 'createMind must return mindId');
  assert.equal(mind.domain, DOMAIN);
  assert.equal(mind.personaName, PERSONA_NAME);
  assert.equal(mind.turnCount, 0);
  assert.equal(mind.telemetry?.d4Redacted, true);
  console.log(`[companion-chat] Created Mind ${mind.mindId} (${mind.personaName})`);

  const seededTurns = [
    {
      label: 'Turn 1: Seed Companion Pet (Mochi)',
      userInput:
        'Hey Sora! I just got back from a chilly morning walk with my dog Mochi—he is a stubborn little corgi who stops at every bakery door.',
      rewardSignal: 15,
      outcomeTags: ['personal_fact', 'pet_Mochi'],
    },
    {
      label: 'Turn 2: Seed Favorite Drink (roasted barley tea)',
      userInput:
        'To warm up, I brewed a big mug of my favorite roasted barley tea. Nothing beats that toasted aroma when I unwind.',
      rewardSignal: 15,
      outcomeTags: ['personal_fact', 'drink_barley_tea'],
    },
    {
      label: 'Turn 3: Seed Long-Term Goal (Seoul Marathon)',
      userInput:
        'Big update: I officially registered for the Seoul Marathon this autumn, and today I hit my 30 km weekly training target.',
      rewardSignal: 25,
      outcomeTags: ['personal_fact', 'goal_seoul_marathon'],
    },
    {
      label: 'Turn 4: Evening Wind-Down Check-In',
      userInput:
        'My legs feel heavy after the evening stretch, so I am going to rest early and wake up fresh for tomorrow.',
      rewardSignal: 10,
      outcomeTags: ['daily_checkin', 'recovery'],
    },
  ];

  let baselineKv = null;
  let lastTurn = null;

  for (let i = 0; i < seededTurns.length; i += 1) {
    const spec = seededTurns[i];
    const result = await runTurnWithLocalLlm(client, mind.mindId, {
      userInput: spec.userInput,
      adapter,
      rewardSignal: spec.rewardSignal,
      outcomeTags: spec.outcomeTags,
      metadata: { stage: 'seed', step: i + 1 },
    });

    assert.equal(result.mindId, mind.mindId);
    assert.equal(result.domain, DOMAIN);
    assert.equal(result.turnIndex, i + 1);
    assert.equal(result.providerUsed, adapter.provider);

    if (!baselineKv) {
      baselineKv = result.kvCache;
    }
    assertKvCacheContract(result, baselineKv, spec.label);
    logCompanionTurn(spec.label, result);
    lastTurn = result;
  }

  // D2 Overnight Gap
  const idle = await client.idleTick(mind.mindId, {
    elapsedHours: 8,
    reason: 'overnight_gap',
  });
  assert.equal(idle.mindId, mind.mindId);
  assert.equal(idle.elapsedHours, 8);
  assert.equal(typeof idle.homeostasisBefore, 'number');
  assert.ok(Number.isFinite(idle.homeostasisBefore));
  assert.equal(typeof idle.homeostasisAfter, 'number');
  assert.ok(Number.isFinite(idle.homeostasisAfter));
  assert.equal(idle.telemetry?.d4Redacted, true);
  console.log('\n=== D2 Idle Tick (8h overnight_gap) ===');
  console.log(
    `Homeostasis: ${idle.homeostasisBefore} -> ${idle.homeostasisAfter}` +
      (idle.proactiveHint ? ` | proactiveHint=${JSON.stringify(idle.proactiveHint)}` : '')
  );

  // Turn 5: Continuity recall across personal facts + overnight gap
  const recallTurn = await runTurnWithLocalLlm(client, mind.mindId, {
    userInput:
      'Good morning Sora! Before I head out for my recovery run, do you remember my dog Mochi, my favorite drink, and the marathon I am training for?',
    adapter,
    rewardSignal: 10,
    outcomeTags: ['continuity_recall'],
    metadata: { stage: 'recall_verification' },
  });

  assert.equal(recallTurn.mindId, mind.mindId);
  assert.equal(recallTurn.domain, DOMAIN);
  assert.equal(recallTurn.turnIndex, seededTurns.length + 1);
  assert.equal(recallTurn.providerUsed, adapter.provider);
  assertKvCacheContract(recallTurn, baselineKv, 'Turn 5 (Continuity Recall)');
  assert.ok(
    Array.isArray(recallTurn.memoryRefs) && recallTurn.memoryRefs.length > 0,
    'Final continuity recall turn must include memoryRefs.length > 0'
  );
  assert.equal(recallTurn.telemetry?.d4Redacted, true);
  assert.equal(recallTurn.telemetry?.kvPrefixEpoch, baselineKv.epoch);
  assert.ok(
    recallTurn.turnIndex > lastTurn.turnIndex,
    'Final turnIndex must advance monotonically'
  );
  logCompanionTurn('Turn 5: Morning Continuity Recall', recallTurn);

  const finalTelemetry = await client.getTelemetry(mind.mindId);
  assert.equal(finalTelemetry.d4Redacted, true);
  assert.equal(finalTelemetry.kvPrefixEpoch, baselineKv.epoch);

  console.log('\n[companion-chat] All Mode B Zero-Key & KV-prefix invariants passed.');
}

main().catch((err) => {
  console.error('[companion-chat] Verification failed:', err);
  process.exitCode = 1;
});
