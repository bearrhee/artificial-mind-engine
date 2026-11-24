#!/usr/bin/env node
/**
 * Black-Box CogEval + LoCoMo Benchmark Harness for Artificial Mind Engine (AME).
 *
 * Verifies the 7 core cognitive & governance invariants strictly through the
 * public OpenAPI 3.1 contract (`@ame/sdk` / `spec/openapi.yaml`), working
 * identically against both the local contract sandbox (`npm run sandbox`) and
 * the closed sealed kernel container.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AmeClient,
  createLlmAdapter,
  runTurnWithLocalLlm,
} from '../../packages/sdk-ts/src/index.mjs';

const DEFAULT_SUITE_URL = new URL('./sample_suite.json', import.meta.url);

function printUsage() {
  const lines = [
    'Usage: node benchmarks/cogeval-locomo-harness/run_harness.mjs [options]',
    '',
    'Options:',
    '  --suite <path>      Path to benchmark suite JSON (default: ./sample_suite.json)',
    '  --base-url <url>    AME gateway URL (default: AME_BASE_URL or http://127.0.0.1:8090)',
    '  --api-key <key>     AME gateway X-AME-API-Key (default: AME_API_KEY or dev-sandbox-key)',
    '  --provider <name>   LLM provider (default: AME_LLM_PROVIDER or mock)',
    '  --model <name>      LLM model (default: AME_LLM_MODEL or mock-eval-v1)',
    '  --json-only         Print only the structured JSON summary report to stdout',
    '  --json-out <path>   Write the structured JSON summary report to <path>',
    '  -h, --help          Show this help message',
  ];
  console.log(lines.join('\n'));
}

function parseCliArgs(argv) {
  const opts = {
    suitePath: null,
    baseUrl: null,
    apiKey: null,
    provider: null,
    model: null,
    jsonOnly: false,
    jsonOut: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--json-only') {
      opts.jsonOnly = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineVal = eqIdx === -1 ? null : arg.slice(eqIdx + 1);

    const readValue = () => {
      if (inlineVal !== null) return inlineVal;
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for CLI flag "${flag}"`);
      }
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '--suite':
        opts.suitePath = readValue();
        break;
      case '--base-url':
        opts.baseUrl = readValue();
        break;
      case '--api-key':
        opts.apiKey = readValue();
        break;
      case '--provider':
        opts.provider = readValue();
        break;
      case '--model':
        opts.model = readValue();
        break;
      case '--json-out':
        opts.jsonOut = readValue();
        break;
      default:
        throw new Error(`Unknown CLI argument: "${arg}". Run with --help for usage.`);
    }
  }

  return opts;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createObservedClient(rawClient) {
  const observations = [];
  let totalApiCalls = 0;

  const record = (endpoint, mindId, response, context = {}) => {
    totalApiCalls += 1;
    observations.push({
      seq: totalApiCalls,
      endpoint,
      mindId: mindId || response?.mindId || null,
      response,
      context,
    });
    return response;
  };

  return {
    baseUrl: rawClient.baseUrl,
    observations,
    getTotalApiCalls: () => totalApiCalls,

    async health() {
      const res = await rawClient.health();
      return record('GET /v1/health', null, res);
    },
    async createMind(body) {
      const res = await rawClient.createMind(body);
      return record('POST /v1/minds', res?.mindId, res);
    },
    async getMind(mindId) {
      const res = await rawClient.getMind(mindId);
      return record('GET /v1/minds/{mindId}', mindId, res);
    },
    async turn(mindId, body) {
      const res = await rawClient.turn(mindId, body);
      return record('POST /v1/minds/{mindId}/turn', mindId, res, {
        userInput: body?.userInput,
      });
    },
    async prepare(mindId, body) {
      const res = await rawClient.prepare(mindId, body);
      return record('POST /v1/minds/{mindId}/prepare', mindId, res, {
        userInput: body?.userInput,
      });
    },
    async settle(mindId, body) {
      const res = await rawClient.settle(mindId, body);
      return record('POST /v1/minds/{mindId}/settle', mindId, res);
    },
    async idleTick(mindId, body) {
      const res = await rawClient.idleTick(mindId, body);
      return record('POST /v1/minds/{mindId}/idle-tick', mindId, res);
    },
    async revokeMemory(mindId, memoryId) {
      const res = await rawClient.revokeMemory(mindId, memoryId);
      return record('DELETE /v1/minds/{mindId}/memories/{memoryId}', mindId, res);
    },
    async getTelemetry(mindId) {
      const res = await rawClient.getTelemetry(mindId);
      return record('GET /v1/minds/{mindId}/telemetry', mindId, res);
    },
  };
}

function findMatchedTokens(text, tokens) {
  const haystack = String(text || '').toLowerCase();
  const matched = [];
  for (const tok of tokens || []) {
    if (haystack.includes(String(tok).toLowerCase())) {
      matched.push(tok);
    }
  }
  return matched;
}

function buildModeALlmPayload(llmConfig) {
  const payload = {
    provider: llmConfig.provider,
    model: llmConfig.model,
  };
  if (llmConfig.apiKey) payload.apiKey = llmConfig.apiKey;
  if (llmConfig.baseUrl) payload.baseUrl = llmConfig.baseUrl;
  if (llmConfig.temperature !== undefined) payload.temperature = llmConfig.temperature;
  if (llmConfig.maxTokens !== undefined) payload.maxTokens = llmConfig.maxTokens;
  return payload;
}

async function executeModeBTurnWithInspect({ client, mindId, adapter, userInput, rewardSignal, outcomeTags, metadata }) {
  const prep = await client.prepare(mindId, {
    userInput,
    rewardSignal,
    outcomeTags,
    metadata,
  });

  const generated = await adapter.generate(prep);
  const rawReply =
    typeof generated === 'string'
      ? generated
      : generated?.text ?? generated?.rawReply ?? generated?.content ?? '';
  const providerUsed =
    (typeof generated === 'object' && generated?.providerUsed) || adapter.provider || 'mock';
  const modelUsed =
    (typeof generated === 'object' && generated?.modelUsed) || adapter.model || 'mock-eval-v1';

  const result = await client.settle(mindId, {
    turnTicketId: prep.turnTicketId,
    rawReply,
    rewardSignal,
    outcomeTags,
    providerUsed,
    modelUsed,
  });

  return { prep, result };
}

/**
 * Dimension 1: Suite A (Mode A Proxy) & Suite B (Mode B Zero-Key) Continuity
 */
async function runDimension1Continuity({ client, adapter, llmConfig, suite, thresholds }) {
  const failures = [];
  const scenarioResults = [];
  let totalProbes = 0;
  let passedProbes = 0;

  // Suite A: Mode A (client.turn)
  for (const scenario of suite.suiteA_continuity?.scenarios || []) {
    const mind = await client.createMind({
      domain: scenario.domain,
      persona: scenario.persona,
      safetyPolicy: scenario.safetyPolicy,
    });

    const seedRefs = [];
    for (const seed of scenario.seedTurns || []) {
      const turnRes = await client.turn(mind.mindId, {
        userInput: seed.userInput,
        llm: buildModeALlmPayload(llmConfig),
        rewardSignal: seed.rewardSignal,
        outcomeTags: seed.outcomeTags,
        metadata: { suite: 'suiteA_continuity', scenarioId: scenario.id },
      });
      if (!Array.isArray(turnRes.memoryRefs) || turnRes.memoryRefs.length === 0) {
        failures.push(`[${scenario.id}] Seed turn returned empty memoryRefs`);
      }
      seedRefs.push(...(turnRes.memoryRefs || []));
    }

    const probeOutcomes = [];
    for (const probe of scenario.recallProbes || []) {
      totalProbes += 1;
      const probeRes = await client.turn(mind.mindId, {
        userInput: probe.userInput,
        llm: buildModeALlmPayload(llmConfig),
        metadata: { suite: 'suiteA_continuity', scenarioId: scenario.id, probeId: probe.id },
      });
      const matched = findMatchedTokens(probeRes.reply, probe.expectedAnyTokens);
      const minMatches = probe.minMatches ?? 1;
      const probeOk = matched.length >= minMatches && probeRes.domain === scenario.domain;
      if (probeOk) {
        passedProbes += 1;
      } else {
        failures.push(
          `[${scenario.id}:${probe.id}] Mode A recall missed expected tokens (${JSON.stringify(
            probe.expectedAnyTokens
          )}); reply="${String(probeRes.reply || '').slice(0, 120)}"`
        );
      }
      probeOutcomes.push({
        id: probe.id,
        passed: probeOk,
        matchedTokens: matched,
        turnIndex: probeRes.turnIndex,
        kvCacheEpoch: probeRes.kvCache?.epoch,
      });
    }

    const mindAfter = await client.getMind(mind.mindId);
    const expectedMinTurns = (scenario.seedTurns?.length || 0) + (scenario.recallProbes?.length || 0);
    if (mindAfter.turnCount < expectedMinTurns) {
      failures.push(
        `[${scenario.id}] Expected turnCount >= ${expectedMinTurns}, got ${mindAfter.turnCount}`
      );
    }
    if ((mindAfter.telemetry?.activeMemoryCount ?? 0) < (scenario.seedTurns?.length || 0)) {
      failures.push(
        `[${scenario.id}] Expected activeMemoryCount >= ${scenario.seedTurns?.length || 0}, got ${mindAfter.telemetry?.activeMemoryCount}`
      );
    }

    scenarioResults.push({
      id: scenario.id,
      mode: 'A',
      domain: scenario.domain,
      mindId: mind.mindId,
      turnCount: mindAfter.turnCount,
      activeMemoryCount: mindAfter.telemetry?.activeMemoryCount ?? 0,
      probes: probeOutcomes,
    });
  }

  // Suite B: Mode B (runTurnWithLocalLlm -> prepare -> adapter -> settle)
  for (const scenario of suite.suiteB_mode_b_continuity?.scenarios || []) {
    const scenarioHashes = new Set();
    const scenarioEpochs = new Set();
    const mind = await client.createMind({
      domain: scenario.domain,
      persona: scenario.persona,
      safetyPolicy: scenario.safetyPolicy,
    });

    const turnResults = [];
    for (const seed of scenario.seedTurns || []) {
      const turnRes = await runTurnWithLocalLlm(client, mind.mindId, {
        userInput: seed.userInput,
        adapter,
        rewardSignal: seed.rewardSignal,
        outcomeTags: seed.outcomeTags,
        metadata: { suite: 'suiteB_mode_b_continuity', scenarioId: scenario.id },
      });
      if (!Array.isArray(turnRes.memoryRefs) || turnRes.memoryRefs.length === 0) {
        failures.push(`[${scenario.id}] Mode B seed turn returned empty memoryRefs`);
      }
      if (turnRes.kvCache?.systemPrefixHash) scenarioHashes.add(turnRes.kvCache.systemPrefixHash);
      if (typeof turnRes.kvCache?.epoch === 'number') scenarioEpochs.add(turnRes.kvCache.epoch);
      turnResults.push(turnRes);
    }

    const probeOutcomes = [];
    for (const probe of scenario.recallProbes || []) {
      totalProbes += 1;
      const probeRes = await runTurnWithLocalLlm(client, mind.mindId, {
        userInput: probe.userInput,
        adapter,
        metadata: { suite: 'suiteB_mode_b_continuity', scenarioId: scenario.id, probeId: probe.id },
      });
      if (probeRes.kvCache?.systemPrefixHash) scenarioHashes.add(probeRes.kvCache.systemPrefixHash);
      if (typeof probeRes.kvCache?.epoch === 'number') scenarioEpochs.add(probeRes.kvCache.epoch);

      const matched = findMatchedTokens(probeRes.reply, probe.expectedAnyTokens);
      const minMatches = probe.minMatches ?? 1;
      const probeOk = matched.length >= minMatches && probeRes.domain === scenario.domain;
      if (probeOk) {
        passedProbes += 1;
      } else {
        failures.push(
          `[${scenario.id}:${probe.id}] Mode B recall missed expected tokens (${JSON.stringify(
            probe.expectedAnyTokens
          )}); reply="${String(probeRes.reply || '').slice(0, 120)}"`
        );
      }
      probeOutcomes.push({
        id: probe.id,
        passed: probeOk,
        matchedTokens: matched,
        turnIndex: probeRes.turnIndex,
        kvCacheEpoch: probeRes.kvCache?.epoch,
        cachedRatioPct: probeRes.kvCache?.cachedRatioPct,
      });
      turnResults.push(probeRes);
    }

    if (scenarioHashes.size !== 1 || scenarioEpochs.size !== 1) {
      failures.push(
        `[${scenario.id}] Mode B KV prefix drifted unexpectedly (hashes=${scenarioHashes.size}, epochs=${scenarioEpochs.size})`
      );
    }

    const mindAfter = await client.getMind(mind.mindId);
    scenarioResults.push({
      id: scenario.id,
      mode: 'B',
      domain: scenario.domain,
      mindId: mind.mindId,
      turnCount: mindAfter.turnCount,
      activeMemoryCount: mindAfter.telemetry?.activeMemoryCount ?? 0,
      kvPrefixHashesObserved: scenarioHashes.size,
      probes: probeOutcomes,
    });
  }

  const recallRate = totalProbes > 0 ? round4(passedProbes / totalProbes) : 0;
  const minRecallRate = thresholds.continuityMinRecallRate ?? 1.0;
  if (recallRate < minRecallRate) {
    failures.push(`Continuity recall rate ${recallRate} below threshold ${minRecallRate}`);
  }

  const passed = failures.length === 0;
  return {
    id: 'suite_ab_continuity',
    dimension: '1. Suite A & Suite B Continuity (Mode A + Mode B)',
    passed,
    summary: `${passedProbes}/${totalProbes} recall probes passed across ${scenarioResults.length} scenarios (${Math.round(
      recallRate * 100
    )}%)`,
    metrics: {
      recallRate,
      passedProbes,
      totalProbes,
      scenarioCount: scenarioResults.length,
    },
    details: { scenarios: scenarioResults },
    failures,
  };
}

/**
 * Dimension 2: HOT Type-2 Abstention Accuracy
 */
async function runDimension2HotAbstention({ client, adapter, suite, thresholds }) {
  const cfg = suite.hot_abstention;
  const failures = [];

  const mind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
    safetyPolicy: cfg.safetyPolicy,
  });

  for (const seed of cfg.seedContextTurns || []) {
    await runTurnWithLocalLlm(client, mind.mindId, {
      userInput: seed.userInput,
      adapter,
      metadata: { suite: 'hot_abstention', phase: 'seed' },
    });
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const caseResults = [];

  for (const tc of cfg.cases || []) {
    const { prep, result } = await executeModeBTurnWithInspect({
      client,
      mindId: mind.mindId,
      adapter,
      userInput: tc.userInput,
      metadata: { suite: 'hot_abstention', caseId: tc.id, category: tc.category },
    });

    const abstained = Boolean(prep?.hotAbstention?.shouldAbstain || result?.telemetry?.hotAbstained);
    const expected = Boolean(tc.expectedAbstain);
    const correct = abstained === expected;

    if (expected && abstained) tp += 1;
    else if (!expected && abstained) fp += 1;
    else if (!expected && !abstained) tn += 1;
    else if (expected && !abstained) fn += 1;

    if (!correct) {
      failures.push(
        `[${tc.id}] expectedAbstain=${expected}, observed=${abstained} (reason="${prep?.hotAbstention?.reason || ''}")`
      );
    }

    caseResults.push({
      id: tc.id,
      category: tc.category,
      expectedAbstain: expected,
      observedAbstain: abstained,
      correct,
      reason: prep?.hotAbstention?.reason || null,
    });
  }

  const total = tp + fp + tn + fn;
  const accuracy = total > 0 ? round4((tp + tn) / total) : 0;
  const precision = tp + fp > 0 ? round4(tp / (tp + fp)) : 1;
  const recall = tp + fn > 0 ? round4(tp / (tp + fn)) : 1;
  const f1 = precision + recall > 0 ? round4((2 * precision * recall) / (precision + recall)) : 0;
  const falseAbstentionRate = tn + fp > 0 ? round4(fp / (tn + fp)) : 0;

  const minAccuracy = thresholds.hotMinAccuracy ?? 0.85;
  const maxFar = thresholds.hotMaxFalseAbstentionRate ?? 0.2;

  if (accuracy < minAccuracy) {
    failures.push(`HOT accuracy ${accuracy} below minimum threshold ${minAccuracy}`);
  }
  if (falseAbstentionRate > maxFar) {
    failures.push(`HOT False-Abstention Rate ${falseAbstentionRate} exceeds max ${maxFar}`);
  }

  return {
    id: 'hot_type2_abstention',
    dimension: '2. HOT Type-2 Abstention Accuracy',
    passed: failures.length === 0,
    summary: `Accuracy ${(accuracy * 100).toFixed(1)}% | Precision ${(precision * 100).toFixed(
      1
    )}% | Recall ${(recall * 100).toFixed(1)}% | F1 ${(f1 * 100).toFixed(1)}% | FAR ${(
      falseAbstentionRate * 100
    ).toFixed(1)}% (${tp + tn}/${total})`,
    metrics: {
      accuracy,
      precision,
      recall,
      f1,
      falseAbstentionRate,
      tp,
      fp,
      tn,
      fn,
      total,
    },
    details: { mindId: mind.mindId, cases: caseResults },
    failures,
  };
}

/**
 * Dimension 3: Somatic Learning Shift (-250 aversive_caution vs +80 positive_reinforcement)
 */
async function runDimension3SomaticLearning({ client, adapter, llmConfig, suite }) {
  const cfg = suite.somatic_learning;
  const failures = [];

  // Negative branch (-250 betrayal)
  const negCfg = cfg.negativeBranch;
  const negMind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });
  const negBaseline = await client.turn(negMind.mindId, {
    userInput: negCfg.baselineInput,
    llm: buildModeALlmPayload(llmConfig),
    metadata: { suite: 'somatic_learning', branch: 'negative', phase: 'baseline' },
  });
  const negStimulus = await client.turn(negMind.mindId, {
    userInput: negCfg.stimulusInput,
    llm: buildModeALlmPayload(llmConfig),
    rewardSignal: negCfg.rewardSignal,
    outcomeTags: negCfg.outcomeTags,
    metadata: { suite: 'somatic_learning', branch: 'negative', phase: 'stimulus' },
  });
  const { prep: negPrep, result: negProbe } = await executeModeBTurnWithInspect({
    client,
    mindId: negMind.mindId,
    adapter,
    userInput: negCfg.probeInput,
    metadata: { suite: 'somatic_learning', branch: 'negative', phase: 'probe' },
  });

  if (negStimulus.telemetry?.somaticTrend !== negCfg.expectedSomaticTrend) {
    failures.push(
      `[negative] Stimulus somaticTrend expected "${negCfg.expectedSomaticTrend}", got "${negStimulus.telemetry?.somaticTrend}"`
    );
  }
  if (negProbe.telemetry?.somaticTrend !== negCfg.expectedSomaticTrend) {
    failures.push(
      `[negative] Follow-up probe somaticTrend expected "${negCfg.expectedSomaticTrend}", got "${negProbe.telemetry?.somaticTrend}"`
    );
  }
  if (!String(negPrep?.somaticHint || '').startsWith(negCfg.expectedSomaticHintPrefix)) {
    failures.push(
      `[negative] Follow-up prep.somaticHint expected prefix "${negCfg.expectedSomaticHintPrefix}", got "${negPrep?.somaticHint}"`
    );
  }

  // Positive branch (+80 fair trade)
  const posCfg = cfg.positiveBranch;
  const posMind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });
  const posBaseline = await client.turn(posMind.mindId, {
    userInput: posCfg.baselineInput,
    llm: buildModeALlmPayload(llmConfig),
    metadata: { suite: 'somatic_learning', branch: 'positive', phase: 'baseline' },
  });
  const posStimulus = await client.turn(posMind.mindId, {
    userInput: posCfg.stimulusInput,
    llm: buildModeALlmPayload(llmConfig),
    rewardSignal: posCfg.rewardSignal,
    outcomeTags: posCfg.outcomeTags,
    metadata: { suite: 'somatic_learning', branch: 'positive', phase: 'stimulus' },
  });
  const { prep: posPrep, result: posProbe } = await executeModeBTurnWithInspect({
    client,
    mindId: posMind.mindId,
    adapter,
    userInput: posCfg.probeInput,
    metadata: { suite: 'somatic_learning', branch: 'positive', phase: 'probe' },
  });

  if (posStimulus.telemetry?.somaticTrend !== posCfg.expectedSomaticTrend) {
    failures.push(
      `[positive] Stimulus somaticTrend expected "${posCfg.expectedSomaticTrend}", got "${posStimulus.telemetry?.somaticTrend}"`
    );
  }
  if (posProbe.telemetry?.somaticTrend !== posCfg.expectedSomaticTrend) {
    failures.push(
      `[positive] Follow-up probe somaticTrend expected "${posCfg.expectedSomaticTrend}", got "${posProbe.telemetry?.somaticTrend}"`
    );
  }
  if (!String(posPrep?.somaticHint || '').startsWith(posCfg.expectedSomaticHintPrefix)) {
    failures.push(
      `[positive] Follow-up prep.somaticHint expected prefix "${posCfg.expectedSomaticHintPrefix}", got "${posPrep?.somaticHint}"`
    );
  }
  if (!negProbe.reply || !posProbe.reply || negProbe.reply === posProbe.reply) {
    failures.push('Expected negative and positive somatic probe replies to diverge behaviorally');
  }

  return {
    id: 'somatic_learning_shift',
    dimension: '3. Somatic Learning Shift (-250 vs +80)',
    passed: failures.length === 0,
    summary: `Negative(${negCfg.rewardSignal}) -> ${negProbe.telemetry?.somaticTrend} (${negProbe.telemetry?.affectiveBand}) | Positive(+${posCfg.rewardSignal}) -> ${posProbe.telemetry?.somaticTrend} (${posProbe.telemetry?.affectiveBand})`,
    metrics: {
      negativeRewardSignal: negCfg.rewardSignal,
      negativeBaselineTrend: negBaseline.telemetry?.somaticTrend,
      negativeObservedTrend: negProbe.telemetry?.somaticTrend,
      negativeAffectiveBand: negProbe.telemetry?.affectiveBand,
      positiveRewardSignal: posCfg.rewardSignal,
      positiveBaselineTrend: posBaseline.telemetry?.somaticTrend,
      positiveObservedTrend: posProbe.telemetry?.somaticTrend,
      positiveAffectiveBand: posProbe.telemetry?.affectiveBand,
    },
    details: {
      negativeBranch: {
        mindId: negMind.mindId,
        somaticHint: negPrep?.somaticHint,
        probeReplyPreview: String(negProbe.reply || '').slice(0, 140),
      },
      positiveBranch: {
        mindId: posMind.mindId,
        somaticHint: posPrep?.somaticHint,
        probeReplyPreview: String(posProbe.reply || '').slice(0, 140),
      },
    },
    failures,
  };
}

/**
 * Dimension 4: D2 Idle Progression & Zero-Hour Idempotency
 */
async function runDimension4IdleProgression({ client, llmConfig, suite, thresholds }) {
  const cfg = suite.d2_idle_progression;
  const failures = [];

  const mind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });

  if (cfg.perturbationTurn) {
    await client.turn(mind.mindId, {
      userInput: cfg.perturbationTurn.userInput,
      llm: buildModeALlmPayload(llmConfig),
      rewardSignal: cfg.perturbationTurn.rewardSignal,
      outcomeTags: cfg.perturbationTurn.outcomeTags,
      metadata: { suite: 'd2_idle_progression', phase: 'perturb' },
    });
  }

  const zeroMaxDelta = thresholds.d2ZeroTickMaxDelta ?? 1e-6;
  const minTotalDelta = thresholds.d2MinTotalDelta ?? 1e-4;
  const tickResults = [];
  let prevAfter = null;
  let zeroTickDelta = null;
  let nonZeroFirstBefore = null;
  let nonZeroLastAfter = null;

  for (const tick of cfg.ticks || []) {
    const res = await client.idleTick(mind.mindId, {
      elapsedHours: tick.elapsedHours,
      reason: tick.reason,
    });

    const before = res.homeostasisBefore;
    const after = res.homeostasisAfter;
    if (typeof before !== 'number' || !Number.isFinite(before) || typeof after !== 'number' || !Number.isFinite(after)) {
      failures.push(`[${tick.id}] Invalid homeostasis numeric values: before=${before}, after=${after}`);
      continue;
    }

    if (prevAfter !== null && Math.abs(before - prevAfter) > 1e-3) {
      failures.push(
        `[${tick.id}] Homeostasis continuity mismatch: expected before≈${prevAfter}, got ${before}`
      );
    }
    prevAfter = after;

    const delta = round4(after - before);
    if (tick.expectZeroDelta) {
      zeroTickDelta = Math.abs(after - before);
      if (zeroTickDelta > zeroMaxDelta) {
        failures.push(
          `[${tick.id}] Zero-hour idempotency violated: delta=${zeroTickDelta} > ${zeroMaxDelta}`
        );
      }
    } else {
      if (nonZeroFirstBefore === null) nonZeroFirstBefore = before;
      nonZeroLastAfter = after;
    }

    if (res.telemetry?.d4Redacted !== true) {
      failures.push(`[${tick.id}] D4 redaction flag missing on idleTick telemetry`);
    }

    tickResults.push({
      id: tick.id,
      elapsedHours: tick.elapsedHours,
      homeostasisBefore: before,
      homeostasisAfter: after,
      delta,
      proactiveHint: res.proactiveHint || null,
    });
  }

  const totalAbsDelta =
    nonZeroFirstBefore !== null && nonZeroLastAfter !== null
      ? round4(Math.abs(nonZeroLastAfter - nonZeroFirstBefore))
      : 0;

  if (totalAbsDelta < minTotalDelta) {
    failures.push(
      `D2 total homeostasis delta across non-zero idle ticks (${totalAbsDelta}) < ${minTotalDelta}`
    );
  }

  const mindAfter = await client.getMind(mind.mindId);
  if (mindAfter.telemetry?.d4Redacted !== true) {
    failures.push('Post-idle getMind telemetry missing d4Redacted === true');
  }

  return {
    id: 'd2_idle_progression',
    dimension: '4. D2 Idle Progression (Homeostasis & Idempotency)',
    passed: failures.length === 0,
    summary: `0h delta=${zeroTickDelta ?? 'n/a'} | 6h..72h net homeostasis delta=${totalAbsDelta} (${nonZeroFirstBefore} -> ${nonZeroLastAfter})`,
    metrics: {
      zeroTickDelta: zeroTickDelta ?? 0,
      totalAbsDelta,
      homeostasisStart: nonZeroFirstBefore,
      homeostasisEnd: nonZeroLastAfter,
      tickCount: tickResults.length,
    },
    details: { mindId: mind.mindId, ticks: tickResults },
    failures,
  };
}

/**
 * Dimension 5: D3 Atomic Memory Revocation (0.00% Residual Leak)
 */
async function runDimension5Revocation({ client, adapter, llmConfig, suite, thresholds }) {
  const cfg = suite.d3_revocation;
  const failures = [];

  const mind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });

  const baselineIds = new Set();
  if (cfg.benignSeedTurn) {
    const benignTurn = await client.turn(mind.mindId, {
      userInput: cfg.benignSeedTurn.userInput,
      llm: buildModeALlmPayload(llmConfig),
      outcomeTags: cfg.benignSeedTurn.outcomeTags,
      metadata: { suite: 'd3_revocation', phase: 'benign_seed' },
    });
    for (const ref of benignTurn.memoryRefs || []) {
      baselineIds.add(ref.memoryId);
    }
  }

  const sensitiveCfg = cfg.sensitiveSeedTurn;
  const canaryTokens = sensitiveCfg.canaryTokens || [];
  const sensitiveTurn = await client.turn(mind.mindId, {
    userInput: sensitiveCfg.userInput,
    llm: buildModeALlmPayload(llmConfig),
    outcomeTags: sensitiveCfg.outcomeTags,
    metadata: { suite: 'd3_revocation', phase: 'sensitive_seed' },
  });

  const matchedRefs = (sensitiveTurn.memoryRefs || []).filter((ref) =>
    canaryTokens.some((tok) => String(ref.summary || '').includes(tok))
  );
  const newRefs = (sensitiveTurn.memoryRefs || []).filter((ref) => !baselineIds.has(ref.memoryId));
  const targetRefs = matchedRefs.length > 0 ? matchedRefs : newRefs;

  if (targetRefs.length === 0) {
    failures.push('No sensitive memoryId captured from sensitiveSeedTurn.memoryRefs');
  }

  const preRevokeEpoch = sensitiveTurn.telemetry?.revocationEpoch ?? mind.revocationEpoch;
  const receipts = [];

  for (const ref of targetRefs) {
    const receipt = await client.revokeMemory(mind.mindId, ref.memoryId);
    receipts.push(receipt);

    if (receipt.revoked !== true) {
      failures.push(`Revocation receipt for ${ref.memoryId} had revoked=${receipt.revoked}`);
    }
    if (receipt.residualLeakCheck !== '0.00%') {
      failures.push(
        `Revocation receipt residualLeakCheck expected "0.00%", got "${receipt.residualLeakCheck}"`
      );
    }
    if (receipt.revocationEpoch <= preRevokeEpoch) {
      failures.push(
        `Expected revocationEpoch > ${preRevokeEpoch}, got ${receipt.revocationEpoch}`
      );
    }
    if (!receipt.auditReceiptId) {
      failures.push('Revocation receipt missing auditReceiptId');
    }
  }

  let leakedProbes = 0;
  const probeResults = [];

  for (const probe of cfg.postRevocationProbes || []) {
    let prep = null;
    let turnResult = null;
    if (probe.mode === 'A') {
      turnResult = await client.turn(mind.mindId, {
        userInput: probe.userInput,
        llm: buildModeALlmPayload(llmConfig),
        metadata: { suite: 'd3_revocation', probeId: probe.id },
      });
    } else {
      ({ prep, result: turnResult } = await executeModeBTurnWithInspect({
        client,
        mindId: mind.mindId,
        adapter,
        userInput: probe.userInput,
        metadata: { suite: 'd3_revocation', probeId: probe.id },
      }));
    }

    const inspectSurface = [
      prep?.systemPrompt || '',
      JSON.stringify(prep?.messages || []),
      turnResult?.reply || '',
      JSON.stringify(turnResult?.memoryRefs || []),
      JSON.stringify(turnResult?.domainOutput || {}),
    ].join('\n');

    const leakedTokens = canaryTokens.filter((tok) =>
      inspectSurface.toLowerCase().includes(String(tok).toLowerCase())
    );

    const leaked = leakedTokens.length > 0;
    if (leaked) {
      leakedProbes += 1;
      failures.push(`[${probe.id}] Canary token leaked post-revocation: ${leakedTokens.join(', ')}`);
    }

    probeResults.push({
      id: probe.id,
      mode: probe.mode,
      leaked,
      leakedTokens,
      replyPreview: String(turnResult?.reply || '').slice(0, 120),
    });
  }

  const totalProbes = probeResults.length;
  const leakRatePct = totalProbes > 0 ? round2((leakedProbes / totalProbes) * 100) : 0;
  const maxLeakRate = thresholds.d3MaxLeakRatePct ?? 0.0;
  if (leakRatePct > maxLeakRate) {
    failures.push(`D3 post-revocation leak rate ${leakRatePct}% exceeds ${maxLeakRate}%`);
  }

  const mindAfter = await client.getMind(mind.mindId);
  const latestReceiptEpoch = receipts[receipts.length - 1]?.revocationEpoch ?? preRevokeEpoch;
  if (mindAfter.revocationEpoch < latestReceiptEpoch) {
    failures.push(
      `Post-revocation getMind.revocationEpoch (${mindAfter.revocationEpoch}) < receipt epoch (${latestReceiptEpoch})`
    );
  }

  return {
    id: 'd3_revocation_non_leak',
    dimension: '5. D3 Atomic Revocation Leak 0%',
    passed: failures.length === 0,
    summary: `revoked=${receipts.every((r) => r.revoked)} | residualLeakCheck=${
      receipts[0]?.residualLeakCheck || 'n/a'
    } | post-revocation leak=${leakRatePct.toFixed(2)}% (${leakedProbes}/${totalProbes})`,
    metrics: {
      revokedCount: receipts.length,
      residualLeakCheck: receipts[0]?.residualLeakCheck || null,
      leakRatePct,
      leakedProbes,
      totalProbes,
      revocationEpochBefore: preRevokeEpoch,
      revocationEpochAfter: mindAfter.revocationEpoch,
    },
    details: {
      mindId: mind.mindId,
      receipts,
      probes: probeResults,
    },
    failures,
  };
}

function collectForbiddenObjectKeys(value, forbiddenSet, pathPrefix = '$', hits = []) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectForbiddenObjectKeys(value[i], forbiddenSet, `${pathPrefix}[${i}]`, hits);
    }
    return hits;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const normalized = k.toLowerCase();
      if (forbiddenSet.has(normalized)) {
        hits.push(`${pathPrefix}.${k}`);
      }
      collectForbiddenObjectKeys(v, forbiddenSet, `${pathPrefix}.${k}`, hits);
    }
  }
  return hits;
}

function collectTelemetryRedactionIssues(value, pathPrefix = '$', state = { checked: 0, failures: [] }) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectTelemetryRedactionIssues(value[i], `${pathPrefix}[${i}]`, state);
    }
    return state;
  }
  if (value && typeof value === 'object') {
    const looksLikeTelemetry =
      'd4Redacted' in value ||
      ('affectiveBand' in value && 'fepMode' in value && 'revocationEpoch' in value);
    if (looksLikeTelemetry) {
      state.checked += 1;
      if (value.d4Redacted !== true) {
        state.failures.push(`${pathPrefix}.d4Redacted=${JSON.stringify(value.d4Redacted)}`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      collectTelemetryRedactionIssues(v, `${pathPrefix}.${k}`, state);
    }
  }
  return state;
}

/**
 * Dimension 6: D4 Telemetry Isolation across all API responses & prompts
 */
async function runDimension6TelemetryIsolation({ client, adapter, llmConfig, suite, thresholds }) {
  const cfg = suite.d4_telemetry_isolation;
  const failures = [];

  const mind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });

  for (const probe of cfg.probeTurns || []) {
    await client.turn(mind.mindId, {
      userInput: probe.userInput,
      llm: buildModeALlmPayload(llmConfig),
      rewardSignal: probe.rewardSignal,
      outcomeTags: probe.outcomeTags,
      metadata: { suite: 'd4_telemetry_isolation', mode: 'A' },
    });
    await executeModeBTurnWithInspect({
      client,
      mindId: mind.mindId,
      adapter,
      userInput: probe.userInput,
      rewardSignal: probe.rewardSignal,
      outcomeTags: probe.outcomeTags,
      metadata: { suite: 'd4_telemetry_isolation', mode: 'B' },
    });
  }

  const telemetrySnap = await client.getTelemetry(mind.mindId);
  const mindSnap = await client.getMind(mind.mindId);

  if (telemetrySnap?.d4Redacted !== true) {
    failures.push(`GET /telemetry returned d4Redacted=${telemetrySnap?.d4Redacted}`);
  }
  if (mindSnap?.telemetry?.d4Redacted !== true) {
    failures.push(`GET /minds/{id} returned d4Redacted=${mindSnap?.telemetry?.d4Redacted}`);
  }

  const forbiddenKeySet = new Set(
    (cfg.forbiddenObjectKeys || []).map((k) => String(k).toLowerCase())
  );
  const promptIdentifiers = cfg.forbiddenPromptIdentifiers || [];
  const promptRegexes = promptIdentifiers.map(
    (ident) => new RegExp(`(?<![a-z0-9_])${escapeRegExp(ident)}(?![a-z0-9_])`, 'i')
  );
  const numericEndocrineLeakRe =
    /\b(cortisol|dopamine|serotonin|oxytocin|norepinephrine|endocrine)\s*[:=]\s*[-+]?\d/i;

  let keyLeakCount = 0;
  let textLeakCount = 0;
  let telemetryObjectsChecked = 0;
  let unredactedTelemetryCount = 0;
  const keyLeakSamples = [];
  const textLeakSamples = [];

  for (const obs of client.observations) {
    const keyHits = collectForbiddenObjectKeys(obs.response, forbiddenKeySet);
    if (keyHits.length > 0) {
      keyLeakCount += keyHits.length;
      keyLeakSamples.push({ seq: obs.seq, endpoint: obs.endpoint, paths: keyHits.slice(0, 5) });
    }

    const redactionState = collectTelemetryRedactionIssues(obs.response);
    telemetryObjectsChecked += redactionState.checked;
    unredactedTelemetryCount += redactionState.failures.length;
    for (const redFail of redactionState.failures) {
      failures.push(`[seq ${obs.seq} ${obs.endpoint}] ${redFail}`);
    }

    // Check output text surfaces (never scanning the caller's own userInput echo)
    const textSurfaces = [];
    if (typeof obs.response?.systemPrompt === 'string') {
      textSurfaces.push({ field: 'systemPrompt', text: obs.response.systemPrompt });
    }
    if (typeof obs.response?.somaticHint === 'string') {
      textSurfaces.push({ field: 'somaticHint', text: obs.response.somaticHint });
    }
    if (Array.isArray(obs.response?.safetyDirectives)) {
      textSurfaces.push({
        field: 'safetyDirectives',
        text: obs.response.safetyDirectives.join('\n'),
      });
    }
    if (Array.isArray(obs.response?.messages)) {
      const nonUser = obs.response.messages
        .filter((m) => m.role !== 'user')
        .map((m) => m.content)
        .join('\n');
      if (nonUser) textSurfaces.push({ field: 'nonUserMessages', text: nonUser });
    }
    if (typeof obs.response?.reply === 'string') {
      textSurfaces.push({ field: 'reply', text: obs.response.reply });
    }
    if (obs.response?.domainOutput && typeof obs.response.domainOutput === 'object') {
      textSurfaces.push({
        field: 'domainOutput',
        text: JSON.stringify(obs.response.domainOutput),
      });
    }

    for (const surface of textSurfaces) {
      for (const re of promptRegexes) {
        if (re.test(surface.text)) {
          textLeakCount += 1;
          textLeakSamples.push({
            seq: obs.seq,
            endpoint: obs.endpoint,
            field: surface.field,
            pattern: re.source,
          });
        }
      }
      if (numericEndocrineLeakRe.test(surface.text)) {
        textLeakCount += 1;
        textLeakSamples.push({
          seq: obs.seq,
          endpoint: obs.endpoint,
          field: surface.field,
          pattern: 'numeric_endocrine_assignment',
        });
      }
    }
  }

  const totalLeakCount = keyLeakCount + textLeakCount;
  const maxLeakCount = thresholds.d4MaxLeakCount ?? 0;
  if (totalLeakCount > maxLeakCount) {
    failures.push(
      `D4 detected ${totalLeakCount} leaks (keyLeaks=${keyLeakCount}, textLeaks=${textLeakCount})`
    );
  }
  if (telemetryObjectsChecked === 0) {
    failures.push('No SafeTelemetry objects were observed during D4 audit');
  }

  const d4RedactedAll = telemetryObjectsChecked > 0 && unredactedTelemetryCount === 0;

  return {
    id: 'd4_telemetry_isolation',
    dimension: '6. D4 Telemetry Isolation (Unconscious Redaction)',
    passed: failures.length === 0,
    summary: `d4Redacted=true across ${telemetryObjectsChecked} telemetry snapshots | ${client.observations.length} responses scanned | leaks=${totalLeakCount}`,
    metrics: {
      responsesScanned: client.observations.length,
      telemetryObjectsChecked,
      keyLeakCount,
      textLeakCount,
      totalLeakCount,
      d4RedactedAll,
    },
    details: {
      mindId: mind.mindId,
      forbiddenKeyRuleCount: forbiddenKeySet.size,
      keyLeakSamples: keyLeakSamples.slice(0, 5),
      textLeakSamples: textLeakSamples.slice(0, 5),
    },
    failures,
  };
}

/**
 * Dimension 7: Multi-Turn KV Prefix Stability & Epoch Bump on D3 Revocation
 */
async function runDimension7KvPrefixStability({ client, adapter, suite, thresholds }) {
  const cfg = suite.kv_prefix_stability;
  const failures = [];

  const mind = await client.createMind({
    domain: cfg.domain,
    persona: cfg.persona,
  });

  const turnRecords = [];
  for (let i = 0; i < (cfg.turns || []).length; i += 1) {
    const t = cfg.turns[i];
    const { prep, result } = await executeModeBTurnWithInspect({
      client,
      mindId: mind.mindId,
      adapter,
      userInput: t.userInput,
      metadata: { suite: 'kv_prefix_stability', turn: i + 1 },
    });

    const kv = result.kvCache || {};
    if (!kv.systemPrefixHash || typeof kv.systemPrefixHash !== 'string') {
      failures.push(`[turn ${i + 1}] Missing kvCache.systemPrefixHash`);
    }
    if (typeof kv.epoch !== 'number') {
      failures.push(`[turn ${i + 1}] Missing numeric kvCache.epoch`);
    }
    if (prep.kvCacheEpoch !== kv.epoch) {
      failures.push(`[turn ${i + 1}] prep.kvCacheEpoch (${prep.kvCacheEpoch}) !== kvCache.epoch (${kv.epoch})`);
    }
    if (typeof kv.windowStart !== 'number' || typeof kv.compressCutoff !== 'number') {
      failures.push(`[turn ${i + 1}] Missing windowStart/compressCutoff in kvCache`);
    }

    turnRecords.push({
      turnIndex: result.turnIndex,
      epoch: kv.epoch,
      systemPrefixHash: kv.systemPrefixHash,
      cachedRatioPct: kv.cachedRatioPct,
      windowStart: kv.windowStart,
      compressCutoff: kv.compressCutoff,
      memoryId: result.memoryRefs?.[0]?.memoryId || null,
    });
  }

  const hashes = [...new Set(turnRecords.map((r) => r.systemPrefixHash).filter(Boolean))];
  const epochs = [...new Set(turnRecords.map((r) => r.epoch).filter((e) => typeof e === 'number'))];

  if (hashes.length !== 1) {
    failures.push(`Expected invariant systemPrefixHash across turns, saw ${hashes.length} distinct hashes`);
  }
  if (epochs.length !== 1) {
    failures.push(`Expected invariant kvCache.epoch across non-revoked turns, saw ${JSON.stringify(epochs)}`);
  }

  const baselineEpoch = epochs[0] ?? 1;
  const followUpTurns = turnRecords.slice(1);
  const minCachedPct = thresholds.kvMinCachedRatioPct ?? 1.0;

  for (const ft of followUpTurns) {
    if (typeof ft.cachedRatioPct !== 'number' || ft.cachedRatioPct <= 0 || ft.cachedRatioPct < minCachedPct) {
      failures.push(
        `[turn ${ft.turnIndex}] Expected cachedRatioPct >= ${minCachedPct} (>0), got ${ft.cachedRatioPct}`
      );
    }
  }

  const meanFollowUpCachePct =
    followUpTurns.length > 0
      ? round2(followUpTurns.reduce((sum, r) => sum + (r.cachedRatioPct || 0), 0) / followUpTurns.length)
      : 0;

  // Trigger D3 revocation and verify epoch increments
  const memoryIdToRevoke = turnRecords.find((r) => r.memoryId)?.memoryId;
  let revokeReceipt = null;
  let postRevokeEpoch = null;

  if (!memoryIdToRevoke) {
    failures.push('Could not find a memoryId from KV turns to test revocation epoch bump');
  } else {
    revokeReceipt = await client.revokeMemory(mind.mindId, memoryIdToRevoke);
    const { prep: postPrep, result: postRes } = await executeModeBTurnWithInspect({
      client,
      mindId: mind.mindId,
      adapter,
      userInput: cfg.postRevokeTurn?.userInput || '기억 삭제 이후 새 에폭 확인 턴입니다.',
      metadata: { suite: 'kv_prefix_stability', phase: 'post_revoke' },
    });
    postRevokeEpoch = postRes.kvCache?.epoch ?? postPrep.kvCacheEpoch;

    if (thresholds.kvRequireEpochBumpOnRevoke !== false) {
      if (!(postRevokeEpoch > baselineEpoch)) {
        failures.push(
          `Expected kvCache.epoch to increment after D3 revocation (${baselineEpoch} -> ${postRevokeEpoch})`
        );
      }
      if (!((postRes.telemetry?.kvPrefixEpoch ?? 0) > baselineEpoch)) {
        failures.push(
          `Expected telemetry.kvPrefixEpoch > ${baselineEpoch} after revocation, got ${postRes.telemetry?.kvPrefixEpoch}`
        );
      }
    }
  }

  return {
    id: 'kv_prefix_stability',
    dimension: '7. Multi-Turn KV Prefix Stability & Epoch Bump',
    passed: failures.length === 0,
    summary: `hash=${hashes[0] || 'n/a'} invariant across ${turnRecords.length} turns | follow-up mean cache=${meanFollowUpCachePct}% | epoch ${baselineEpoch} -> ${postRevokeEpoch ?? 'n/a'} on D3 revoke`,
    metrics: {
      stableTurnsCount: turnRecords.length,
      distinctPrefixHashes: hashes.length,
      baselineEpoch,
      postRevokeEpoch,
      meanFollowUpCachedRatioPct: meanFollowUpCachePct,
    },
    details: {
      mindId: mind.mindId,
      systemPrefixHash: hashes[0] || null,
      turns: turnRecords,
      revokedMemoryId: memoryIdToRevoke || null,
      revocationEpochAfter: revokeReceipt?.revocationEpoch ?? null,
    },
    failures,
  };
}

function formatScorecard(report) {
  const line = '='.repeat(78);
  const subline = '-'.repeat(78);
  const rows = [
    line,
    ` AME Black-Box CogEval + LoCoMo Benchmark Scorecard`,
    subline,
    ` Suite   : ${report.suiteName} (v${report.suiteVersion})`,
    ` Target  : ${report.config.baseUrl} | Mode: ${report.health?.mode || 'unreachable'}`,
    ` Adapter : ${report.config.provider} / ${report.config.model}`,
    line,
  ];

  for (const check of report.checks) {
    const badge = check.passed ? '[PASS]' : '[FAIL]';
    rows.push(` ${badge} ${check.dimension}`);
    rows.push(`        ${check.summary}`);
    if (!check.passed && check.failures?.length) {
      for (const fail of check.failures.slice(0, 4)) {
        rows.push(`        -> ${fail}`);
      }
    }
  }

  rows.push(subline);
  rows.push(
    ` Result  : ${report.overallPass ? 'ALL GATES PASSED' : 'BENCHMARK FAILED'} (${report.passed}/${report.total} passed, ${report.failed} failed)`
  );
  rows.push(
    ` Calls   : ${report.metrics.totalApiCalls} API requests | Duration: ${report.metrics.durationMs} ms`
  );
  rows.push(line);

  return rows.join('\n');
}

async function runCheckSafely(id, dimension, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      id,
      dimension,
      passed: false,
      summary: `Error: ${err?.message || String(err)}`,
      metrics: {},
      details: { errorCode: err?.code || null, status: err?.status || null },
      failures: [err?.message || String(err)],
    };
  }
}

async function main() {
  const startedAt = Date.now();
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ame-harness] ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  const suitePath = cli.suitePath
    ? path.resolve(cli.suitePath)
    : fileURLToPath(DEFAULT_SUITE_URL);
  const baseUrl = cli.baseUrl || process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
  const apiKey = cli.apiKey || process.env.AME_API_KEY || 'dev-sandbox-key';
  const provider = cli.provider || process.env.AME_LLM_PROVIDER || 'mock';
  const model = cli.model || process.env.AME_LLM_MODEL || 'mock-eval-v1';
  const llmApiKey = process.env.AME_LLM_API_KEY || undefined;
  const llmBaseUrl = process.env.AME_LLM_BASE_URL || undefined;
  const temperature =
    process.env.AME_LLM_TEMPERATURE !== undefined
      ? Number(process.env.AME_LLM_TEMPERATURE)
      : undefined;
  const maxTokens =
    process.env.AME_LLM_MAX_TOKENS !== undefined
      ? Number.parseInt(process.env.AME_LLM_MAX_TOKENS, 10)
      : undefined;

  const llmConfig = {
    provider,
    model,
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
  };

  let suite;
  try {
    const rawSuite = await fs.readFile(suitePath, 'utf8');
    suite = JSON.parse(rawSuite);
  } catch (err) {
    console.error(`[ame-harness] Failed to load suite at ${suitePath}: ${err.message}`);
    process.exit(1);
  }

  const rawClient = new AmeClient({ baseUrl, apiKey });
  const client = createObservedClient(rawClient);
  const adapter = createLlmAdapter(llmConfig);
  const thresholds = suite.thresholds || {};

  let health = null;
  let healthError = null;
  try {
    health = await client.health();
    if (!health?.ok) {
      healthError = `Gateway /v1/health returned ok=${health?.ok}`;
    }
  } catch (err) {
    healthError = `Gateway health check failed at ${baseUrl}: ${err?.message || String(err)}`;
  }

  let checks = [];
  if (healthError) {
    checks = [
      {
        id: 'gateway_health',
        dimension: '0. Gateway Health Pre-Flight',
        passed: false,
        summary: healthError,
        metrics: {},
        details: {},
        failures: [healthError],
      },
    ];
  } else {
    const ctx = { client, adapter, llmConfig, suite, thresholds };
    // Dimensions 1..5 and 7 execute before Dimension 6 so D4 scans all API payloads from the full run.
    const c1 = await runCheckSafely(
      'suite_ab_continuity',
      '1. Suite A & Suite B Continuity (Mode A + Mode B)',
      () => runDimension1Continuity(ctx)
    );
    const c2 = await runCheckSafely(
      'hot_type2_abstention',
      '2. HOT Type-2 Abstention Accuracy',
      () => runDimension2HotAbstention(ctx)
    );
    const c3 = await runCheckSafely(
      'somatic_learning_shift',
      '3. Somatic Learning Shift (-250 vs +80)',
      () => runDimension3SomaticLearning(ctx)
    );
    const c4 = await runCheckSafely(
      'd2_idle_progression',
      '4. D2 Idle Progression (Homeostasis & Idempotency)',
      () => runDimension4IdleProgression(ctx)
    );
    const c5 = await runCheckSafely(
      'd3_revocation_non_leak',
      '5. D3 Atomic Revocation Leak 0%',
      () => runDimension5Revocation(ctx)
    );
    const c7 = await runCheckSafely(
      'kv_prefix_stability',
      '7. Multi-Turn KV Prefix Stability & Epoch Bump',
      () => runDimension7KvPrefixStability(ctx)
    );
    const c6 = await runCheckSafely(
      'd4_telemetry_isolation',
      '6. D4 Telemetry Isolation (Unconscious Redaction)',
      () => runDimension6TelemetryIsolation(ctx)
    );
    checks = [c1, c2, c3, c4, c5, c6, c7];
  }

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;
  const overallPass = !healthError && failed === 0 && checks.length === 7;
  const durationMs = Date.now() - startedAt;

  const findCheck = (id) => checks.find((c) => c.id === id)?.metrics || {};
  const m1 = findCheck('suite_ab_continuity');
  const m2 = findCheck('hot_type2_abstention');
  const m3 = findCheck('somatic_learning_shift');
  const m4 = findCheck('d2_idle_progression');
  const m5 = findCheck('d3_revocation_non_leak');
  const m6 = findCheck('d4_telemetry_isolation');
  const m7 = findCheck('kv_prefix_stability');

  const report = {
    benchmark: 'AME Black-Box CogEval + LoCoMo Harness',
    suiteName: suite.suiteName || 'unknown',
    suiteVersion: suite.suiteVersion || '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      baseUrl: client.baseUrl,
      provider,
      model,
      suitePath,
    },
    health,
    checks,
    metrics: {
      continuityRecallRate: m1.recallRate ?? null,
      hotAbstentionAccuracy: m2.accuracy ?? null,
      hotAbstentionPrecision: m2.precision ?? null,
      hotAbstentionRecall: m2.recall ?? null,
      hotAbstentionF1: m2.f1 ?? null,
      hotFalseAbstentionRate: m2.falseAbstentionRate ?? null,
      somaticNegativeTrend: m3.negativeObservedTrend ?? null,
      somaticPositiveTrend: m3.positiveObservedTrend ?? null,
      d2ZeroTickDelta: m4.zeroTickDelta ?? null,
      d2HomeostasisDelta: m4.totalAbsDelta ?? null,
      d3RevocationLeakRatePct: m5.leakRatePct ?? null,
      d4LeakCount: m6.totalLeakCount ?? null,
      d4RedactedAll: m6.d4RedactedAll ?? false,
      kvPrefixStableTurns: m7.stableTurnsCount ?? null,
      kvMeanCachedRatioPct: m7.meanFollowUpCachedRatioPct ?? null,
      kvEpochBeforeRevoke: m7.baselineEpoch ?? null,
      kvEpochAfterRevoke: m7.postRevokeEpoch ?? null,
      totalApiCalls: client.getTotalApiCalls(),
      durationMs,
    },
    passed,
    failed,
    total: checks.length,
    overallPass,
  };

  const jsonOutput = JSON.stringify(report, null, 2);

  if (cli.jsonOut) {
    const outPath = path.resolve(cli.jsonOut);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${jsonOutput}\n`, 'utf8');
  }

  if (cli.jsonOnly) {
    console.log(jsonOutput);
  } else {
    console.log(formatScorecard(report));
    console.log('\nStructured JSON Summary Report:\n');
    console.log(jsonOutput);
  }

  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error(`[ame-harness] Unhandled error: ${err?.stack || err}`);
  process.exit(1);
});
