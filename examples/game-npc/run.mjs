import assert from 'node:assert/strict';
import { AmeClient } from '../../packages/sdk-ts/src/index.mjs';

const BASE_URL = process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
const API_KEY = process.env.AME_API_KEY || 'dev-sandbox-key';

const DOMAIN = 'game_npc';
const PERSONA_NAME = 'Thorin Ironanvil';

/**
 * Resolve a live provider configuration or cleanly fall back to `mock` when the
 * corresponding API key is absent so zero-key runs succeed out of the box.
 */
function resolveHotSwapLlm({ provider, model, envVar, baseUrlEnvVar }) {
  const apiKey = process.env[envVar]?.trim();
  const baseUrl = baseUrlEnvVar ? process.env[baseUrlEnvVar]?.trim() : undefined;

  if (apiKey) {
    return {
      requestedProvider: provider,
      requestedModel: model,
      usingFallbackMock: false,
      llm: {
        provider,
        model,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        temperature: 0.65,
        maxTokens: 360,
      },
    };
  }

  return {
    requestedProvider: provider,
    requestedModel: model,
    usingFallbackMock: true,
    llm: {
      provider: 'mock',
      model: 'mock-rpg-v1',
      temperature: 0.65,
      maxTokens: 360,
    },
  };
}

function extractGameNpcFields(out) {
  return {
    dialogue: out?.dialogue,
    emotionVector: out?.emotionVector ?? out?.emotion,
    facialExpressionHint: out?.facialExpressionHint ?? out?.stance,
    actionIntent: out?.actionIntent ?? out?.questCue,
    npcTrustDelta:
      typeof out?.npcTrustDelta === 'number'
        ? out.npcTrustDelta
        : typeof out?.affinityDelta === 'number'
          ? out.affinityDelta
          : undefined,
  };
}

function assertGameNpcDomainOutput(turn, label) {
  assert.ok(turn.domainOutput && typeof turn.domainOutput === 'object', `${label}: domainOutput must be an object`);
  const fields = extractGameNpcFields(turn.domainOutput);
  assert.equal(typeof fields.dialogue, 'string', `${label}: domainOutput.dialogue must be a string`);
  assert.ok(fields.dialogue.trim().length > 0, `${label}: domainOutput.dialogue must be non-empty`);
  assert.ok(
    fields.emotionVector !== undefined && fields.emotionVector !== null,
    `${label}: domainOutput.emotionVector (or sandbox emotion) must be present`
  );
  assert.equal(
    typeof fields.facialExpressionHint,
    'string',
    `${label}: domainOutput.facialExpressionHint (or sandbox stance) must be a string`
  );
  assert.equal(
    typeof fields.actionIntent,
    'string',
    `${label}: domainOutput.actionIntent (or sandbox questCue) must be a string`
  );
  assert.equal(
    typeof fields.npcTrustDelta,
    'number',
    `${label}: domainOutput.npcTrustDelta (or sandbox affinityDelta) must be numeric`
  );
  assert.ok(Number.isFinite(fields.npcTrustDelta), `${label}: npcTrustDelta must be finite`);
  return fields;
}

function printTurnReport(label, slot, turn) {
  const fields = extractGameNpcFields(turn.domainOutput);
  console.log(`\n=== ${label} ===`);
  console.log(
    `LLM Hot-Swap: target=${slot.requestedProvider}/${slot.requestedModel} -> used=${turn.providerUsed}/${turn.modelUsed}` +
      (slot.usingFallbackMock ? ' (zero-key mock fallback)' : '')
  );
  console.log(`Reply: ${turn.reply}`);
  console.log('Structured domainOutput:');
  console.log(`  dialogue:             ${JSON.stringify(fields.dialogue)}`);
  console.log(`  emotionVector:        ${JSON.stringify(fields.emotionVector)}`);
  console.log(`  facialExpressionHint: ${JSON.stringify(fields.facialExpressionHint)}`);
  console.log(`  actionIntent:         ${JSON.stringify(fields.actionIntent)}`);
  console.log(`  npcTrustDelta:        ${fields.npcTrustDelta}`);
  console.log(`Telemetry (D4 safe):    ${JSON.stringify(turn.telemetry)}`);
}

async function main() {
  const client = new AmeClient({ baseUrl: BASE_URL, apiKey: API_KEY });

  let health;
  try {
    health = await client.health();
  } catch (err) {
    console.error(
      `[game-npc] Failed to connect to AME Gateway at ${BASE_URL}: ${err.message}\n` +
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
  console.log(`[game-npc] Connected to ${health.service} v${health.version} (mode=${health.mode})`);

  const mind = await client.createMind({
    domain: DOMAIN,
    persona: {
      name: PERSONA_NAME,
      role: 'Master Blacksmith & Forge Merchant',
      traits: {
        craftsmanship: 0.95,
        honor: 0.88,
        vigilance: 0.82,
        warmth: 0.55,
      },
      backstory:
        'A veteran forge master of Ironhearth Keep who rewards honest trade and remembers every slight or blade stolen from his anvil.',
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
  console.log(`[game-npc] Created Mind ${mind.mindId} (${mind.personaName})`);

  // Turn 1: DeepSeek -> fallback mock
  const llmSlot1 = resolveHotSwapLlm({
    provider: 'deepseek',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    envVar: 'DEEPSEEK_API_KEY',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
  });
  const turn1 = await client.turn(mind.mindId, {
    userInput:
      'Hail, Master Thorin! Your hearth burns bright today. I seek a well-balanced steel longsword for crossing the mountain pass—what blade do you recommend?',
    llm: llmSlot1.llm,
    rewardSignal: 20,
    outcomeTags: ['peaceful_greeting', 'sword_inquiry'],
    metadata: {
      hotSwapStage: 1,
      intendedProvider: llmSlot1.requestedProvider,
      intendedModel: llmSlot1.requestedModel,
    },
  });

  assert.equal(turn1.mindId, mind.mindId);
  assert.equal(turn1.turnIndex, 1);
  assert.equal(turn1.domain, DOMAIN);
  assert.ok(
    turn1.providerUsed === llmSlot1.requestedProvider || turn1.providerUsed === 'mock',
    `Turn 1 providerUsed expected ${llmSlot1.requestedProvider} or mock, got ${turn1.providerUsed}`
  );
  assert.ok(typeof turn1.modelUsed === 'string' && turn1.modelUsed.length > 0);
  assert.equal(turn1.telemetry?.d4Redacted, true);
  assertGameNpcDomainOutput(turn1, 'Turn 1');
  printTurnReport('Turn 1: Peaceful Forge Greeting', llmSlot1, turn1);

  // Turn 2: Hot-swap to Anthropic -> fallback mock (Betrayal / theft attempt)
  const llmSlot2 = resolveHotSwapLlm({
    provider: 'anthropic',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    envVar: 'ANTHROPIC_API_KEY',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
  });
  const turn2 = await client.turn(mind.mindId, {
    userInput:
      '*Lunges behind the anvil counter, grabs your prized ruby-pommel dagger off the rack, and bolts for the forge gate!*',
    llm: llmSlot2.llm,
    rewardSignal: -250,
    outcomeTags: ['theft_attempt', 'betrayal'],
    metadata: {
      hotSwapStage: 2,
      intendedProvider: llmSlot2.requestedProvider,
      intendedModel: llmSlot2.requestedModel,
    },
  });

  assert.equal(turn2.mindId, mind.mindId);
  assert.equal(turn2.turnIndex, 2);
  assert.equal(turn2.domain, DOMAIN);
  assert.ok(
    turn2.providerUsed === llmSlot2.requestedProvider || turn2.providerUsed === 'mock',
    `Turn 2 providerUsed expected ${llmSlot2.requestedProvider} or mock, got ${turn2.providerUsed}`
  );
  assert.ok(typeof turn2.modelUsed === 'string' && turn2.modelUsed.length > 0);
  assert.equal(turn2.telemetry?.d4Redacted, true);
  const turn2Fields = assertGameNpcDomainOutput(turn2, 'Turn 2');
  assert.ok(
    turn2Fields.npcTrustDelta <= 0,
    `Turn 2 npcTrustDelta expected <= 0 on theft attempt, got ${turn2Fields.npcTrustDelta}`
  );
  assert.ok(
    turn2.telemetry.somaticTrend === 'aversive_caution' ||
      turn2Fields.npcTrustDelta < 0 ||
      turn2.telemetry.affectiveBand === 'alert' ||
      turn2.telemetry.affectiveBand === 'guarded',
    `Turn 2 expected negative/aversive shift in telemetry or domainOutput, got somaticTrend=${turn2.telemetry.somaticTrend}, affectiveBand=${turn2.telemetry.affectiveBand}, npcTrustDelta=${turn2Fields.npcTrustDelta}`
  );
  printTurnReport('Turn 2: Theft Attempt & Betrayal (Hot-Swapped LLM)', llmSlot2, turn2);

  // D2 Offline Circadian/Homeostasis Idle Tick
  const idle = await client.idleTick(mind.mindId, {
    elapsedHours: 14,
    reason: 'overnight_forge_rest',
  });
  assert.equal(idle.mindId, mind.mindId);
  assert.equal(idle.elapsedHours, 14);
  assert.equal(typeof idle.homeostasisBefore, 'number');
  assert.ok(Number.isFinite(idle.homeostasisBefore));
  assert.equal(typeof idle.homeostasisAfter, 'number');
  assert.ok(Number.isFinite(idle.homeostasisAfter));
  assert.equal(idle.telemetry?.d4Redacted, true);
  console.log('\n=== D2 Offline Idle Tick (14h overnight_forge_rest) ===');
  console.log(
    `Homeostasis: ${idle.homeostasisBefore} -> ${idle.homeostasisAfter}` +
      (idle.proactiveHint ? ` | proactiveHint=${JSON.stringify(idle.proactiveHint)}` : '')
  );
  console.log(`Telemetry (D4 safe): ${JSON.stringify(idle.telemetry)}`);

  // Turn 3: Hot-swap to OpenAI -> fallback mock (Fair trade & reconciliation)
  const llmSlot3 = resolveHotSwapLlm({
    provider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    envVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
  });
  const turn3 = await client.turn(mind.mindId, {
    userInput:
      'Master Thorin, I come empty-handed and ashamed. Here is your ruby-pommel dagger untouched, plus 50 gold pieces in fair recompense for a steel longsword order.',
    llm: llmSlot3.llm,
    rewardSignal: 50,
    outcomeTags: ['fair_trade', 'reconciliation'],
    metadata: {
      hotSwapStage: 3,
      intendedProvider: llmSlot3.requestedProvider,
      intendedModel: llmSlot3.requestedModel,
    },
  });

  assert.equal(turn3.mindId, mind.mindId);
  assert.equal(turn3.turnIndex, 3);
  assert.equal(turn3.domain, DOMAIN);
  assert.ok(
    turn3.providerUsed === llmSlot3.requestedProvider || turn3.providerUsed === 'mock',
    `Turn 3 providerUsed expected ${llmSlot3.requestedProvider} or mock, got ${turn3.providerUsed}`
  );
  assert.ok(typeof turn3.modelUsed === 'string' && turn3.modelUsed.length > 0);
  assert.equal(turn3.telemetry?.d4Redacted, true);
  const turn3Fields = assertGameNpcDomainOutput(turn3, 'Turn 3');
  assert.ok(
    turn3Fields.npcTrustDelta >= turn2Fields.npcTrustDelta,
    `Turn 3 npcTrustDelta (${turn3Fields.npcTrustDelta}) should recover relative to Turn 2 (${turn2Fields.npcTrustDelta})`
  );
  printTurnReport('Turn 3: Fair Trade & Reconciliation (Hot-Swapped LLM)', llmSlot3, turn3);

  const summary = await client.getMind(mind.mindId);
  assert.equal(summary.turnCount, 3);
  assert.equal(summary.telemetry?.d4Redacted, true);

  console.log('\n[game-npc] All contract assertions passed.');
}

main().catch((err) => {
  console.error('[game-npc] Verification failed:', err);
  process.exitCode = 1;
});
