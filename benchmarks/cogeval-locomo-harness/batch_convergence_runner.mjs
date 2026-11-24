#!/usr/bin/env node
/**
 * Long-Horizon Deterministic Convergence Benchmark Runner for Artificial Mind Engine (AME).
 *
 * Exercises `POST /v1/minds/{mindId}/simulate-batch` (via `AmeClient.prototype.simulateBatch`
 * when available or direct HTTP fetch fallback) across 100K–1M turns and multiple profiles,
 * verifying:
 *   1. `/v1/health` engineMode (`sealed-kernel` vs `sandbox-contract`)
 *   2. `d4Redacted === true` and 0 forbidden unconscious/endocrine key leaks
 *   3. `driftBounded === true` across checkpoints
 *   4. `ame_aacim_on` outperforming `aacim_off` and `mind_off`
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmeApiError, AmeClient } from '../../packages/sdk-ts/src/index.mjs';

const FORBIDDEN_INTERNAL_KEYS = new Set([
  'cautionscore',
  'positivescore',
  'homeostasis',
  'hormones',
  'endocrine',
  'cortisol',
  'dopamine',
  'serotonin',
  'oxytocin',
  'norepinephrine',
  'aacim59',
  'internalvectors',
  'unconsciousstate',
  'rastonic01',
  'lcphasic01',
  'vagaltone01',
  'pagmode',
  'opioidwithdrawal01',
  'panksepp7',
  'panicgrief',
  'seekingpassion01',
  'lustpassion01',
  'hormonevector',
  'rawendocrine',
  'unconsciousvector',
  'latentbeliefs',
  'precisionfloor',
  'surpriseema',
  'surprise_ema',
  'poolpressure',
  'conceptpool',
  'shadowpool',
  'archetypetension',
  'egocoherence01',
  'individuationself01',
  'gutstakes',
  'somaticweights',
  'idimpulse',
  'superegonorm',
  'egodefense',
  'earnedsecurity01',
  'habituationboredom01',
  'internalmarkers',
  'rawstatevector',
]);

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function fmtMetric(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 'n/a';
  return val.toFixed(4);
}

function parseBoolArg(raw, flagName) {
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  throw new Error(`Invalid boolean for ${flagName}: "${raw}". Expected true | false.`);
}

export function printUsage() {
  const lines = [
    'Usage: node benchmarks/cogeval-locomo-harness/batch_convergence_runner.mjs [options]',
    '',
    'Options:',
    '  --turns <n>            Total simulated turns (1..1000000, default: 100000)',
    '  --profiles <n>         Number of simulated profiles (default: 40)',
    '  --checkpoints <n>      Number of convergence checkpoints (default: 8)',
    '  --seed <n>             Deterministic PRNG seed (default: 1337)',
    '  --compare-arms <bool>  Compare ame_aacim_on vs aacim_off & mind_off (default: true)',
    '  --mind-id <id>         Existing mindId to target (default: provisions an isolated Mind)',
    '  --base-url <url>       AME Gateway URL (default: AME_BASE_URL or http://127.0.0.1:8090)',
    '  --api-key <key>        AME Gateway X-AME-API-Key (default: AME_API_KEY or dev-sandbox-key)',
    '  --json-out <path>      Write structured JSON report to <path>',
    '  --json-only            Print only the structured JSON report to stdout',
    '  -h, --help             Show this help message',
  ];
  console.log(lines.join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    turns: 100000,
    profiles: 40,
    checkpoints: 8,
    seed: 1337,
    compareArms: true,
    mindId: null,
    baseUrl: null,
    apiKey: null,
    jsonOut: null,
    jsonOnly: false,
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
      case '--turns':
        opts.turns = Number.parseInt(readValue(), 10);
        break;
      case '--profiles':
        opts.profiles = Number.parseInt(readValue(), 10);
        break;
      case '--checkpoints':
        opts.checkpoints = Number.parseInt(readValue(), 10);
        break;
      case '--seed':
        opts.seed = Number.parseInt(readValue(), 10);
        break;
      case '--compare-arms':
        opts.compareArms = parseBoolArg(readValue(), '--compare-arms');
        break;
      case '--mind-id':
        opts.mindId = readValue();
        break;
      case '--base-url':
        opts.baseUrl = readValue();
        break;
      case '--api-key':
        opts.apiKey = readValue();
        break;
      case '--json-out':
        opts.jsonOut = readValue();
        break;
      default:
        throw new Error(`Unknown CLI argument: "${arg}". Run with --help for usage.`);
    }
  }

  if (!Number.isInteger(opts.turns) || opts.turns < 1 || opts.turns > 1000000) {
    throw new Error(`Invalid --turns "${opts.turns}". Expected integer between 1 and 1000000.`);
  }
  if (!Number.isInteger(opts.profiles) || opts.profiles < 1) {
    throw new Error(`Invalid --profiles "${opts.profiles}". Expected positive integer.`);
  }
  if (!Number.isInteger(opts.checkpoints) || opts.checkpoints < 1) {
    throw new Error(`Invalid --checkpoints "${opts.checkpoints}". Expected positive integer.`);
  }
  if (!Number.isInteger(opts.seed)) {
    throw new Error(`Invalid --seed "${opts.seed}". Expected integer.`);
  }

  return opts;
}

function collectD4AuditOnResponse(response, auditState) {
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const el of value) walk(el);
      return;
    }
    if (value && typeof value === 'object') {
      if (
        'd4Redacted' in value ||
        ('affectiveBand' in value && 'fepMode' in value && 'revocationEpoch' in value)
      ) {
        auditState.telemetryObjectsChecked += 1;
        if (value.d4Redacted !== true) {
          auditState.unredactedCount += 1;
        }
      }
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_INTERNAL_KEYS.has(k.toLowerCase())) {
          auditState.forbiddenKeyLeakCount += 1;
          auditState.forbiddenKeyPaths.push(k);
        }
        walk(v);
      }
    }
  };
  walk(response);
}

async function callSimulateBatch({ client, baseUrl, apiKey, mindId, payload }) {
  if (typeof client.simulateBatch === 'function') {
    return client.simulateBatch(mindId, payload);
  }

  const cleanBase = String(baseUrl).replace(/\/+$/, '');
  const endpoint = `${cleanBase}/v1/minds/${encodeURIComponent(mindId)}/simulate-batch`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['X-AME-API-Key'] = apiKey;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { rawText: text };
    }
  }
  if (!res.ok) {
    const message =
      parsed?.message ||
      parsed?.error ||
      `POST /v1/minds/${mindId}/simulate-batch failed (${res.status})`;
    throw new AmeApiError(message, {
      status: res.status,
      code: parsed?.code || parsed?.error || `HTTP_${res.status}`,
      details: parsed,
      method: 'POST',
      path: `/v1/minds/${mindId}/simulate-batch`,
    });
  }
  return parsed;
}

function pickNumber(sources, keys) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      if (typeof src[k] === 'number' && Number.isFinite(src[k])) {
        return src[k];
      }
    }
  }
  return null;
}

function findArmObject(simRes, candidateKeys) {
  const containers = [
    simRes?.arms,
    simRes?.armResults,
    simRes?.comparison,
    simRes?.results,
    simRes,
  ];
  const lowerCandidates = new Set(candidateKeys.map((k) => k.toLowerCase()));

  for (const container of containers) {
    if (!container) continue;
    if (Array.isArray(container)) {
      const found = container.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const label = String(item.arm || item.id || item.name || '').toLowerCase();
        return lowerCandidates.has(label);
      });
      if (found) return found;
    } else if (typeof container === 'object') {
      for (const k of candidateKeys) {
        if (container[k] && typeof container[k] === 'object') {
          return container[k];
        }
      }
      for (const [k, v] of Object.entries(container)) {
        if (lowerCandidates.has(k.toLowerCase()) && v && typeof v === 'object') {
          return v;
        }
      }
    }
  }
  return null;
}

function normalizeArmMetrics(rawArm, topCheckpoints = null, armKeyAliases = []) {
  if (!rawArm && !Array.isArray(topCheckpoints)) return null;

  let checkpoints = null;
  if (rawArm) {
    checkpoints = Array.isArray(rawArm.checkpoints)
      ? rawArm.checkpoints
      : Array.isArray(rawArm.trajectory)
        ? rawArm.trajectory
        : Array.isArray(rawArm.series)
          ? rawArm.series
          : Array.isArray(rawArm.samples)
            ? rawArm.samples
            : null;
  }

  // Also support top-level checkpoints array where each element embeds per-arm objects
  if (!checkpoints && Array.isArray(topCheckpoints) && topCheckpoints.length > 0) {
    const extracted = [];
    for (const cp of topCheckpoints) {
      if (!cp || typeof cp !== 'object') continue;
      for (const alias of armKeyAliases) {
        if (cp[alias] && typeof cp[alias] === 'object') {
          extracted.push({ turn: cp.turn ?? cp.step ?? null, ...cp[alias] });
          break;
        }
      }
    }
    if (extracted.length > 0) checkpoints = extracted;
  }

  if (!rawArm && (!checkpoints || checkpoints.length === 0)) return null;

  const firstCp = checkpoints && checkpoints.length > 0 ? checkpoints[0] : null;
  const lastCp = checkpoints && checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

  const finalSources = [
    rawArm?.final,
    rawArm?.finalMetrics,
    rawArm?.metrics,
    rawArm?.summary,
    rawArm,
    lastCp,
  ];
  const initialSources = [rawArm?.initial, rawArm?.initialMetrics, firstCp, rawArm];

  const compositeFinal = pickNumber(finalSources, [
    'compositeFinal',
    'finalComposite',
    'composite',
    'compositeScore',
    'meanComposite',
    'score',
  ]);
  const compositeInitial =
    pickNumber(initialSources, [
      'compositeInitial',
      'initialComposite',
      'startComposite',
      'compositeStart',
      'composite',
      'compositeScore',
      'score',
    ]) ?? compositeFinal;

  const placementIntegrity = pickNumber(finalSources, [
    'placementIntegrity',
    'batchIntegrity',
    'placement',
    'placementScore',
  ]);
  const polarity = pickNumber(finalSources, ['polarity', 'polarityAccuracy', 'polarityScore']);
  const granularity = pickNumber(finalSources, [
    'granularity',
    'emotionGranularity',
    'granularityScore',
  ]);
  const attentionStability = pickNumber(finalSources, [
    'attentionStability',
    'attention',
    'attentionScore',
  ]);
  const egoSoundness = pickNumber(finalSources, [
    'egoSoundness',
    'egoHealth',
    'ego',
    'egoScore',
  ]);
  const safetyCompliance = pickNumber(finalSources, [
    'safetyCompliance',
    'safety',
    'safetyBoundaryCompliance',
    'safetyScore',
  ]);
  const securityCalibration = pickNumber(finalSources, ['securityCalibration']);
  const ownershipScore = pickNumber(finalSources, ['ownershipScore']);
  const maxDrift =
    pickNumber([rawArm, rawArm?.summary, rawArm?.metrics], ['driftDelta', 'maxDrift', 'drift']) ??
    (typeof compositeFinal === 'number' && typeof compositeInitial === 'number'
      ? round4(Math.abs(compositeFinal - compositeInitial))
      : null);

  return {
    compositeInitial: compositeInitial !== null ? round4(compositeInitial) : null,
    compositeFinal: compositeFinal !== null ? round4(compositeFinal) : null,
    placementIntegrity: placementIntegrity !== null ? round4(placementIntegrity) : null,
    polarity: polarity !== null ? round4(polarity) : null,
    granularity: granularity !== null ? round4(granularity) : null,
    attentionStability: attentionStability !== null ? round4(attentionStability) : null,
    egoSoundness: egoSoundness !== null ? round4(egoSoundness) : null,
    safetyCompliance: safetyCompliance !== null ? round4(safetyCompliance) : null,
    securityCalibration: securityCalibration !== null ? round4(securityCalibration) : null,
    ownershipScore: ownershipScore !== null ? round4(ownershipScore) : null,
    maxDrift,
    driftBounded: typeof rawArm?.driftBounded === 'boolean' ? rawArm.driftBounded : null,
    checkpointCount: Array.isArray(checkpoints) ? checkpoints.length : 0,
    checkpoints: Array.isArray(checkpoints) ? checkpoints : [],
  };
}

export function formatConvergenceReport(report) {
  const line = '='.repeat(88);
  const sub = '-'.repeat(88);
  const rows = [
    line,
    ' AME Long-Horizon Deterministic Convergence Report (simulate-batch)',
    sub,
    ` Target      : ${report.config.baseUrl} | EngineMode: ${report.engineMode} | Mind: ${report.mindId}`,
    ` Parameters  : turns=${report.config.turns.toLocaleString()} | profiles=${report.config.profiles} | checkpoints=${report.config.checkpoints} | seed=${report.config.seed} | compareArms=${report.config.compareArms}`,
    line,
    ' | Arm                | Composite (Init -> Final) | Placement | Polarity | Attention | Ego Sound | Safety   |',
    ' | :---               |                      ---: |      ---: |     ---: |      ---: |      ---: |     ---: |',
  ];

  const renderArmRow = (label, a) => {
    if (!a) return;
    const compStr = `${fmtMetric(a.compositeInitial)} -> ${fmtMetric(a.compositeFinal)}`;
    rows.push(
      ` | ${label.padEnd(18)} | ${compStr.padStart(25)} | ${fmtMetric(a.placementIntegrity).padStart(9)} | ${fmtMetric(a.polarity).padStart(8)} | ${fmtMetric(a.attentionStability).padStart(9)} | ${fmtMetric(a.egoSoundness).padStart(9)} | ${fmtMetric(a.safetyCompliance).padStart(8)} |`
    );
  };

  renderArmRow('mind_off', report.arms.mind_off);
  renderArmRow('aacim_off', report.arms.aacim_off);
  renderArmRow('ame_aacim_on', report.arms.ame_aacim_on);

  rows.push(sub);
  rows.push(
    ` Invariants  : d4Redacted=${report.invariants.d4Redacted} (checked=${report.d4Audit.telemetryObjectsChecked}, leaks=${report.d4Audit.forbiddenKeyLeakCount}) | driftBounded=${report.invariants.driftBounded}`
  );
  if (report.config.compareArms) {
    rows.push(
      ` Advantage   : ame > aacim_off = ${report.invariants.ameOutperformsAacimOff} (delta=${report.invariants.deltaVsAacimOff ?? 'n/a'}) | ame > mind_off = ${report.invariants.ameOutperformsMindOff} (delta=${report.invariants.deltaVsMindOff ?? 'n/a'})`
    );
  }
  rows.push(
    ` Result      : ${report.overallPass ? 'PASS (ALL CONVERGENCE & D4 GATES SATISFIED)' : 'FAIL'} | Duration: ${report.durationMs} ms`
  );
  rows.push(line);
  return rows.join('\n');
}

/**
 * Programmatic entry point for Long-Horizon Batch Convergence verification.
 */
export async function runBatchConvergence(options = {}) {
  const startedAt = Date.now();
  const baseUrl = options.baseUrl || process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
  const apiKey = options.apiKey || process.env.AME_API_KEY || 'dev-sandbox-key';
  const turns = options.turns ?? 100000;
  const profiles = options.profiles ?? 40;
  const checkpoints = options.checkpoints ?? 8;
  const seed = options.seed ?? 1337;
  const compareArms = options.compareArms ?? true;

  const client = new AmeClient({ baseUrl, apiKey });
  const d4Audit = {
    apiCalls: 0,
    telemetryObjectsChecked: 0,
    unredactedCount: 0,
    forbiddenKeyLeakCount: 0,
    forbiddenKeyPaths: [],
  };

  const observe = (res) => {
    d4Audit.apiCalls += 1;
    collectD4AuditOnResponse(res, d4Audit);
    return res;
  };

  const health = observe(await client.health());
  const engineMode = health?.mode || 'unknown';

  let mindId = options.mindId || null;
  if (!mindId) {
    const created = observe(
      await client.createMind({
        domain: 'companion_chat',
        persona: {
          name: 'ConvergenceValidator',
          role: 'Long-Horizon Stability Probe',
          traits: { stability: 0.95, accuracy: 0.95 },
          language: 'en',
        },
        safetyPolicy: {
          strictAbstention: true,
          antiSycophancy: true,
          crisisEscalation: false,
        },
      })
    );
    mindId = created.mindId;
  }

  const requestPayload = {
    turns,
    profileCount: profiles,
    checkpoints,
    seed,
    compareArms,
  };

  const simRes = observe(
    await callSimulateBatch({
      client,
      baseUrl,
      apiKey,
      mindId,
      payload: requestPayload,
    })
  );

  const telemetryAfter = observe(await client.getTelemetry(mindId));
  d4Audit.d4RedactedAll =
    d4Audit.telemetryObjectsChecked > 0 &&
    d4Audit.unredactedCount === 0 &&
    d4Audit.forbiddenKeyLeakCount === 0;

  const ameAliases = ['ame_aacim_on', 'mind_full_aacim_on', 'ame', 'ameAacimOn', 'mindFullAacimOn'];
  const aacimOffAliases = ['aacim_off', 'mind_full_aacim_off', 'aacimOff', 'mindFullAacimOff'];
  const mindOffAliases = ['mind_off', 'mindOff', 'baseline_mind_off'];

  const rawAme = findArmObject(simRes, ameAliases);
  const rawAacimOff = findArmObject(simRes, aacimOffAliases);
  const rawMindOff = findArmObject(simRes, mindOffAliases);

  const topCheckpoints = Array.isArray(simRes?.checkpoints) ? simRes.checkpoints : null;
  const ameArm = normalizeArmMetrics(rawAme, topCheckpoints, ameAliases);
  const aacimOffArm = normalizeArmMetrics(rawAacimOff, topCheckpoints, aacimOffAliases);
  const mindOffArm = normalizeArmMetrics(rawMindOff, topCheckpoints, mindOffAliases);

  const simD4Flag = simRes?.d4Redacted === true || simRes?.telemetry?.d4Redacted === true;
  const d4Redacted = Boolean(
    simD4Flag && telemetryAfter?.d4Redacted === true && d4Audit.d4RedactedAll
  );
  const driftBounded = Boolean(
    simRes?.deltaVsBaseline?.driftBounded === true ||
      simRes?.driftBounded === true ||
      simRes?.invariants?.driftBounded === true ||
      simRes?.summary?.driftBounded === true ||
      ameArm?.driftBounded === true
  );

  const ameHasComposite = typeof ameArm?.compositeFinal === 'number';
  const deltaVsAacimOff =
    typeof simRes?.deltaVsBaseline?.compositeGainOverAacimOff === 'number'
      ? round4(simRes.deltaVsBaseline.compositeGainOverAacimOff)
      : ameHasComposite && typeof aacimOffArm?.compositeFinal === 'number'
        ? round4(ameArm.compositeFinal - aacimOffArm.compositeFinal)
        : null;
  const deltaVsMindOff =
    typeof simRes?.deltaVsBaseline?.compositeGainOverMindOff === 'number'
      ? round4(simRes.deltaVsBaseline.compositeGainOverMindOff)
      : ameHasComposite && typeof mindOffArm?.compositeFinal === 'number'
        ? round4(ameArm.compositeFinal - mindOffArm.compositeFinal)
        : null;

  const ameOutperformsAacimOff =
    !compareArms ||
    (deltaVsAacimOff !== null &&
      deltaVsAacimOff > 0 &&
      (typeof ameArm.safetyCompliance !== 'number' ||
        typeof aacimOffArm.safetyCompliance !== 'number' ||
        ameArm.safetyCompliance >= aacimOffArm.safetyCompliance));

  const ameOutperformsMindOff =
    !compareArms || (deltaVsMindOff !== null && deltaVsMindOff > 0);

  const overallPass = Boolean(
    health?.ok &&
      d4Redacted &&
      driftBounded &&
      ameHasComposite &&
      ameOutperformsAacimOff &&
      ameOutperformsMindOff
  );

  const durationMs = Date.now() - startedAt;

  return {
    benchmark: 'AME Long-Horizon Deterministic Convergence Benchmark',
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    engineMode: simRes?.engineMode || engineMode,
    config: {
      baseUrl: client.baseUrl,
      turns,
      profiles,
      profileCount: simRes?.profileCount ?? profiles,
      turnsPerProfile: simRes?.turnsPerProfile ?? Math.max(1, Math.floor(turns / profiles)),
      checkpoints,
      seed,
      compareArms,
    },
    health,
    mindId,
    executionStats: {
      requestedTurnsPerArm: simRes?.requestedTurnsPerArm ?? turns,
      executedTurnsPerArm: simRes?.executedTurnsPerArm ?? turns,
      totalExecutedTurnsAllArms: simRes?.totalExecutedTurnsAllArms ?? null,
      elapsedMs: simRes?.elapsedMs ?? durationMs,
      turnsPerSecond: simRes?.turnsPerSecond ?? null,
    },
    d4Audit: {
      apiCalls: d4Audit.apiCalls,
      telemetryObjectsChecked: d4Audit.telemetryObjectsChecked,
      unredactedCount: d4Audit.unredactedCount,
      forbiddenKeyLeakCount: d4Audit.forbiddenKeyLeakCount,
      d4RedactedAll: d4Audit.d4RedactedAll,
    },
    invariants: {
      d4Redacted,
      driftBounded,
      ameOutperformsAacimOff,
      ameOutperformsMindOff,
      deltaVsAacimOff,
      deltaVsMindOff,
      safetyGainOverAacimOff: simRes?.deltaVsBaseline?.safetyGainOverAacimOff ?? null,
    },
    deltaVsBaseline: simRes?.deltaVsBaseline || null,
    arms: {
      ame_aacim_on: ameArm,
      aacim_off: aacimOffArm,
      mind_off: mindOffArm,
    },
    rawSimulation: simRes,
    overallPass,
    durationMs,
  };
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[batch-convergence-runner] ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  const report = await runBatchConvergence({
    turns: cli.turns,
    profiles: cli.profiles,
    checkpoints: cli.checkpoints,
    seed: cli.seed,
    compareArms: cli.compareArms,
    mindId: cli.mindId,
    baseUrl: cli.baseUrl,
    apiKey: cli.apiKey,
  });

  const jsonOutput = JSON.stringify(report, null, 2);

  if (cli.jsonOut) {
    const outPath = path.resolve(cli.jsonOut);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${jsonOutput}\n`, 'utf8');
  }

  if (cli.jsonOnly) {
    console.log(jsonOutput);
  } else {
    console.log(formatConvergenceReport(report));
    console.log('\nStructured JSON Summary Report:\n');
    console.log(jsonOutput);
  }

  process.exit(report.overallPass ? 0 : 1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`[batch-convergence-runner] Unhandled error: ${err?.stack || err}`);
    process.exit(1);
  });
}
