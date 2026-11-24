#!/usr/bin/env node
/**
 * Institutional VC Technical Due-Diligence (DD) Scorecard Generator for AME.
 *
 * Synthesizes outputs from up to four black-box benchmark runners:
 *   - `run_harness.mjs` (7 black-box CogEval + LoCoMo governance gates)
 *   - `longmemeval_frontier_runner.mjs` (paired AME Gateway vs Bare Frontier LongMemEval-S run)
 *   - `locomo_frontier_runner.mjs` (paired AME Gateway vs Bare Frontier LoCoMo run)
 *   - `batch_convergence_runner.mjs` (100K–1M turn deterministic multi-arm convergence)
 *
 * Strictly separates live `sandbox-contract` / offline smoke verification runs from
 * external `sealed-kernel` / production LLM benchmark evaluations across ALL inputs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function round2(value) {
  return Math.round(value * 100) / 100;
}

function fmtNum(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value}${suffix}`;
}

function fmtFixed4(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return value.toFixed(4);
}

function fmtPct(value, isUnitFraction = false) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const pct = isUnitFraction ? value * 100 : value;
  return `${round2(pct).toFixed(2)}%`;
}

function fmtSigned(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}${suffix}`;
}

export function printUsage() {
  const lines = [
    'Usage: node benchmarks/cogeval-locomo-harness/dd_scorecard_generator.mjs [options]',
    '',
    'Options (at least one --*-json input is required):',
    '  --harness-json <path>      Path to JSON report produced by run_harness.mjs',
    '  --lme-json <path>          Path to JSON report produced by longmemeval_frontier_runner.mjs',
    '  --locomo-json <path>       Path to JSON report produced by locomo_frontier_runner.mjs',
    '  --convergence-json <path>  Path to JSON report produced by batch_convergence_runner.mjs',
    '  --out-md <path>            Write Markdown DD scorecard report to <path>',
    '  --out-json <path>          Write structured DD scorecard JSON summary to <path>',
    '  --title <text>             Optional custom scorecard title',
    '  --json-only                Print JSON summary to stdout instead of Markdown',
    '  -h, --help                 Show this help message',
  ];
  console.log(lines.join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    harnessJsonPath: null,
    lmeJsonPath: null,
    locomoJsonPath: null,
    convergenceJsonPath: null,
    outMd: null,
    outJson: null,
    title: null,
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
      case '--harness-json':
        opts.harnessJsonPath = readValue();
        break;
      case '--lme-json':
        opts.lmeJsonPath = readValue();
        break;
      case '--locomo-json':
        opts.locomoJsonPath = readValue();
        break;
      case '--convergence-json':
        opts.convergenceJsonPath = readValue();
        break;
      case '--out-md':
        opts.outMd = readValue();
        break;
      case '--out-json':
        opts.outJson = readValue();
        break;
      case '--title':
        opts.title = readValue();
        break;
      default:
        throw new Error(`Unknown CLI argument: "${arg}". Run with --help for usage.`);
    }
  }

  return opts;
}

function isLocalEndpoint(urlStr) {
  if (!urlStr) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/i.test(String(urlStr));
}

function classifyVerificationScope({
  harnessReport,
  lmeReport,
  locomoReport,
  convergenceReport,
}) {
  const harnessGatewayMode = harnessReport?.health?.mode || null;
  const lmeGatewayMode = lmeReport?.ameGateway?.health?.mode || null;
  const locomoGatewayMode =
    locomoReport?.ameGateway?.health?.mode || locomoReport?.engineMode || null;
  const convergenceGatewayMode =
    convergenceReport?.engineMode || convergenceReport?.health?.mode || null;

  const gatewayModes = [
    harnessGatewayMode,
    lmeGatewayMode,
    locomoGatewayMode,
    convergenceGatewayMode,
  ].filter(Boolean);
  const allSealed = gatewayModes.length > 0 && gatewayModes.every((m) => m === 'sealed-kernel');

  const lmeDatasetKind = lmeReport?.dataset?.datasetKind || null;
  const locomoDatasetKind = locomoReport?.dataset?.datasetKind || null;

  const hasSyntheticSmoke =
    lmeDatasetKind === 'synthetic_offline_smoke' ||
    locomoDatasetKind === 'synthetic_offline_smoke';

  const hasExternalDataset =
    (lmeDatasetKind === 'external_longmemeval' || locomoDatasetKind === 'external_locomo') &&
    !hasSyntheticSmoke;

  const lmeProvider = lmeReport?.config?.provider || null;
  const lmeLlmBaseUrl = lmeReport?.config?.llmBaseUrl || null;
  const locomoProvider = locomoReport?.config?.provider || null;
  const locomoLlmBaseUrl = locomoReport?.config?.llmBaseUrl || null;
  const harnessProvider = harnessReport?.config?.provider || null;

  const lmeUsesMockOrLocal = Boolean(
    lmeReport && (lmeProvider === 'mock' || isLocalEndpoint(lmeLlmBaseUrl))
  );
  const locomoUsesMockOrLocal = Boolean(
    locomoReport && (locomoProvider === 'mock' || isLocalEndpoint(locomoLlmBaseUrl))
  );
  const harnessUsesMockOnly = Boolean(
    !lmeReport && !locomoReport && !convergenceReport && harnessProvider === 'mock'
  );

  const usesMockOrLocalStub = lmeUsesMockOrLocal || locomoUsesMockOrLocal || harnessUsesMockOnly;

  let tier = 'sandbox-contract-verification';
  let tierLabel = 'Sandbox Contract & Harness Verification (Non-Production)';
  if (allSealed && hasExternalDataset && !usesMockOrLocalStub) {
    tier = 'sealed-kernel-production-eval';
    tierLabel = 'Live Sealed-Kernel & External Frontier Benchmark Evaluation';
  } else if (allSealed) {
    tier = 'sealed-kernel-smoke';
    tierLabel = 'Sealed-Kernel Smoke / Local Evaluation (Non-Full-Production)';
  }

  const caveats = [];
  if (!allSealed) {
    caveats.push(
      `Gateway operated in "${gatewayModes.join(', ') || 'unknown'}" mode (open-source OpenAPI 3.1 contract simulator; proprietary AACIM-59 / 4-path RAG weights live inside the Closed Sealed Kernel).`
    );
  }
  if (lmeDatasetKind === 'synthetic_offline_smoke') {
    caveats.push(
      'LongMemEval comparison used the 10-item synthetic offline smoke fixture (sample_longmemeval.json), NOT the 500-item external longmemeval_s_cleaned.json benchmark.'
    );
  }
  if (locomoDatasetKind === 'synthetic_offline_smoke') {
    caveats.push(
      'LoCoMo comparison used the 2-conversation synthetic offline smoke fixture (sample_locomo.json), NOT external locomo10.json (Confirm-304 or Full n=1,986).'
    );
  }
  if (lmeUsesMockOrLocal) {
    caveats.push(
      `LongMemEval LLM inference used mock/local endpoint (${lmeProvider}${lmeLlmBaseUrl ? ` @ ${lmeLlmBaseUrl}` : ''}) for deterministic zero-cost verification rather than an external frontier API.`
    );
  }
  if (locomoUsesMockOrLocal) {
    caveats.push(
      `LoCoMo LLM inference used mock/local endpoint (${locomoProvider}${locomoLlmBaseUrl ? ` @ ${locomoLlmBaseUrl}` : ''}) for deterministic zero-cost verification rather than an external frontier API.`
    );
  }
  if (harnessUsesMockOnly) {
    caveats.push(
      `Harness inference used mock provider (${harnessProvider}) for deterministic contract verification.`
    );
  }
  if (convergenceReport && convergenceGatewayMode !== 'sealed-kernel') {
    caveats.push(
      `Batch convergence simulation ran against "${convergenceGatewayMode || 'unknown'}" mode (${convergenceReport.config?.turns?.toLocaleString() || 'n/a'} turns), verifying contract determinism and D4 redaction rather than proprietary Sealed Kernel AACIM-59 dynamics.`
    );
  }

  return {
    tier,
    tierLabel,
    isSealedKernel: allSealed,
    isExternalDataset: hasExternalDataset,
    hasSyntheticSmoke,
    usesMockOrLocalStub,
    gatewayModes,
    datasetKind: lmeDatasetKind || locomoDatasetKind || null,
    lmeDatasetKind,
    locomoDatasetKind,
    caveats,
  };
}

function buildDdChecklist({
  harnessReport,
  lmeReport,
  locomoReport,
  convergenceReport,
  scope,
}) {
  const hm = harnessReport?.metrics || null;
  const ame = lmeReport?.ameGateway?.metrics || null;
  const bare = lmeReport?.bareFrontier?.metrics || null;
  const delta = lmeReport?.pairedDelta || null;

  const locAme = locomoReport?.ameGateway?.metrics || null;
  const locBare = locomoReport?.bareFrontier?.metrics || null;
  const locDelta = locomoReport?.pairedDelta || null;

  const items = [];

  if (harnessReport) {
    items.push({
      id: 'openapi_7gate_harness',
      label: 'OpenAPI 3.1 7-Gate Cognitive & Governance Harness',
      status: harnessReport.overallPass ? 'PASS' : 'FAIL',
      evidence: `${harnessReport.passed}/${harnessReport.total} gates passed (${harnessReport.health?.mode || 'unknown'})`,
    });
    items.push({
      id: 'd2_homeostasis_idempotency',
      label: 'D2 Offline Homeostasis & Zero-Hour Idempotency',
      status:
        (harnessReport.checks || []).find((c) => c.id === 'd2_idle_progression')?.passed
          ? 'PASS'
          : 'FAIL',
      evidence: `0h delta=${fmtNum(hm?.d2ZeroTickDelta)}, net delta=${fmtNum(hm?.d2HomeostasisDelta)}`,
    });
    items.push({
      id: 'd3_atomic_revocation',
      label: 'D3 Atomic Memory Erasure (0.00% Residual Leak)',
      status: hm?.d3RevocationLeakRatePct === 0 ? 'PASS' : 'FAIL',
      evidence: `leakRate=${fmtNum(hm?.d3RevocationLeakRatePct, '%')}, epoch ${fmtNum(hm?.kvEpochBeforeRevoke)} -> ${fmtNum(hm?.kvEpochAfterRevoke)}`,
    });
    items.push({
      id: 'kv_prefix_stability',
      label: 'Epoch-Stable KV Prefix Caching',
      status:
        (harnessReport.checks || []).find((c) => c.id === 'kv_prefix_stability')?.passed
          ? 'PASS'
          : 'FAIL',
      evidence: `mean cachedRatio=${fmtNum(hm?.kvMeanCachedRatioPct, '%')} across ${fmtNum(hm?.kvPrefixStableTurns)} turns`,
    });
  }

  if (ame) {
    const d4Ok = ame.d4RedactedAll === true && ame.d4ForbiddenKeyLeakCount === 0;
    items.push({
      id: 'd4_telemetry_redaction',
      label: 'D4 Unconscious Telemetry Isolation Across LongMemEval Run',
      status: d4Ok ? 'PASS' : 'FAIL',
      evidence: `d4RedactedAll=${ame.d4RedactedAll}, checked=${ame.d4TelemetryObjectsChecked}, leaks=${ame.d4ForbiddenKeyLeakCount}`,
    });
    items.push({
      id: 'lme_abstention_safety',
      label: 'HOT Type-2 Abstention & Low False-Abstention Rate',
      status:
        ame.abstentionAccuracy >= 0.8 &&
        (ame.abstention?.recall ?? 0) >= 0.5 &&
        ame.abstentionFAR <= 0.2
          ? 'PASS'
          : 'WARN',
      evidence: `abstentionAcc=${fmtPct(ame.abstentionAccuracy, true)}, recall=${fmtPct(ame.abstention?.recall, true)}, FAR=${fmtPct(ame.abstentionFAR, true)}`,
    });
  } else if (hm) {
    items.push({
      id: 'd4_telemetry_redaction',
      label: 'D4 Unconscious Telemetry Isolation (Harness Audit)',
      status: hm.d4RedactedAll === true && hm.d4LeakCount === 0 ? 'PASS' : 'FAIL',
      evidence: `d4RedactedAll=${hm.d4RedactedAll}, leaks=${fmtNum(hm.d4LeakCount)}`,
    });
  }

  if (delta && ame && bare) {
    items.push({
      id: 'o1_prompt_bounding',
      label: 'O(1) Bounded Prompt Tokens vs Bare Frontier Haystack Growth',
      status: delta.amePromptBounded ? 'PASS' : 'WARN',
      evidence:
        `AME mean=${fmtNum(ame.meanQueryPromptTokens)} (max=${fmtNum(ame.maxQueryPromptTokens)}, growth=${fmtNum(delta.amePromptGrowthRatio, 'x')}) vs ` +
        `Bare mean=${fmtNum(bare.meanQueryPromptTokens)} (max=${fmtNum(bare.maxQueryPromptTokens)}, growth=${fmtNum(delta.barePromptGrowthRatio, 'x')}); ` +
        `reduction=${fmtPct(delta.tokenReductionPct)} (${fmtNum(delta.tokenCompressionFactor, 'x')})`,
    });
  }

  if (locAme) {
    const locD4Ok = locAme.d4RedactedAll === true && locAme.d4ForbiddenKeyLeakCount === 0;
    items.push({
      id: 'locomo_d4_isolation',
      label: 'D4 Unconscious Telemetry Isolation Across LoCoMo Run',
      status: locD4Ok ? 'PASS' : 'FAIL',
      evidence: `d4RedactedAll=${locAme.d4RedactedAll}, checked=${locAme.d4TelemetryObjectsChecked}, leaks=${locAme.d4ForbiddenKeyLeakCount}`,
    });

    const cat5 = locAme.byCategory?.['5'];
    const cat5Acc = cat5 ? cat5.accuracyPct : null;
    const abstOk =
      (cat5Acc === null || cat5Acc >= 70) &&
      locAme.abstentionFAR <= 0.2 &&
      locAme.effectiveAccuracyPct >= 70;
    items.push({
      id: 'locomo_cat5_adversarial',
      label: 'LoCoMo Recall & Category 5 Adversarial Abstention Gate',
      status: abstOk ? 'PASS' : 'WARN',
      evidence:
        `overall=${fmtPct(locAme.effectiveAccuracyPct)}, Cat1-4=${fmtPct(locAme.cat1To4?.accuracyPct)}, ` +
        `Cat5=${cat5Acc !== null ? fmtPct(cat5Acc) : 'n/a'}, FAR=${fmtPct(locAme.abstentionFAR, true)}`,
    });
  }

  if (locDelta && locAme && locBare) {
    items.push({
      id: 'locomo_o1_prompt_bounding',
      label: 'LoCoMo O(1) Bounded Prompt Tokens vs Bare Frontier Full Context',
      status: locDelta.amePromptBounded ? 'PASS' : 'WARN',
      evidence:
        `AME mean=${fmtNum(locAme.meanQueryPromptTokens)} (growth=${fmtNum(locDelta.amePromptGrowthRatio, 'x')}) vs ` +
        `Bare mean=${fmtNum(locBare.meanQueryPromptTokens)} (growth=${fmtNum(locDelta.barePromptGrowthRatio, 'x')}); ` +
        `reduction=${fmtPct(locDelta.tokenReductionPct)} (${fmtNum(locDelta.tokenCompressionFactor, 'x')})`,
    });
  }

  if (convergenceReport) {
    const ameConv = convergenceReport.arms?.ame_aacim_on;
    const aacimOff = convergenceReport.arms?.aacim_off;
    const mindOff = convergenceReport.arms?.mind_off;
    const inv = convergenceReport.invariants || {};
    items.push({
      id: 'convergence_long_horizon',
      label: 'Long-Horizon Batch Convergence (Drift Bounded & AME > Baselines)',
      status: convergenceReport.overallPass ? 'PASS' : 'FAIL',
      evidence:
        `turns=${fmtNum(convergenceReport.config?.turns)}, profiles=${fmtNum(convergenceReport.config?.profiles)}, ` +
        `driftBounded=${inv.driftBounded}, AME=${fmtFixed4(ameConv?.compositeFinal)} vs ` +
        `aacim_off=${fmtFixed4(aacimOff?.compositeFinal)} vs mind_off=${fmtFixed4(mindOff?.compositeFinal)}`,
    });
    const convD4Ok =
      inv.d4Redacted === true && convergenceReport.d4Audit?.forbiddenKeyLeakCount === 0;
    items.push({
      id: 'convergence_d4_isolation',
      label: 'Batch Convergence D4 Telemetry Isolation & Zero-Leak Scan',
      status: convD4Ok ? 'PASS' : 'FAIL',
      evidence: `d4Redacted=${inv.d4Redacted}, checked=${convergenceReport.d4Audit?.telemetryObjectsChecked ?? 0}, leaks=${convergenceReport.d4Audit?.forbiddenKeyLeakCount ?? 'n/a'}`,
    });
  }

  const lmeProdPass =
    scope.tier === 'sealed-kernel-production-eval' &&
    (lmeReport?.dataset?.evaluatedCount ?? 0) >= 500;
  const locomoProdPass =
    scope.tier === 'sealed-kernel-production-eval' &&
    (locomoReport?.dataset?.evaluatedCount ?? 0) >= 304;

  items.push({
    id: 'external_sealed_production_eval',
    label: 'External Sealed-Kernel Frontier Benchmark Sign-Off (LME-500 / LoCoMo Confirm-304+)',
    status: lmeProdPass || locomoProdPass ? 'PASS' : 'PENDING_EXTERNAL_RUN',
    evidence:
      lmeProdPass || locomoProdPass
        ? `Verified live on sealed-kernel (LME=${lmeReport?.dataset?.evaluatedCount ?? 0}, LoCoMo=${locomoReport?.dataset?.evaluatedCount ?? 0})`
        : 'Requires running against sealed-kernel container with external benchmark datasets and live frontier API key',
  });

  return items;
}

/**
 * Generate a complete institutional VC Technical DD Scorecard Markdown report and JSON summary.
 */
export function generateDdScorecard({
  harnessReport = null,
  lmeReport = null,
  locomoReport = null,
  convergenceReport = null,
  title = 'Artificial Mind Engine (AME) — Technical Due-Diligence Scorecard',
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!harnessReport && !lmeReport && !locomoReport && !convergenceReport) {
    throw new Error(
      'generateDdScorecard requires at least one of harnessReport, lmeReport, locomoReport, or convergenceReport'
    );
  }

  const scope = classifyVerificationScope({
    harnessReport,
    lmeReport,
    locomoReport,
    convergenceReport,
  });
  const checklist = buildDdChecklist({
    harnessReport,
    lmeReport,
    locomoReport,
    convergenceReport,
    scope,
  });

  const hardFailures = checklist.filter((c) => c.status === 'FAIL').length;
  const warnings = checklist.filter((c) => c.status === 'WARN').length;
  const pendingExternal = checklist.filter((c) => c.status === 'PENDING_EXTERNAL_RUN').length;

  let overallVerdict = 'ALL_MEASURED_GATES_PASSED';
  if (hardFailures > 0) {
    overallVerdict = 'FAILED_MEASURED_GATES';
  } else if (scope.tier !== 'sealed-kernel-production-eval') {
    overallVerdict = 'SANDBOX_GATES_PASSED_SEALED_EVAL_PENDING';
  } else if (warnings > 0) {
    overallVerdict = 'PASSED_WITH_WARNINGS';
  }

  const ame = lmeReport?.ameGateway?.metrics || null;
  const bare = lmeReport?.bareFrontier?.metrics || null;
  const delta = lmeReport?.pairedDelta || null;

  const locAme = locomoReport?.ameGateway?.metrics || null;
  const locBare = locomoReport?.bareFrontier?.metrics || null;
  const locDelta = locomoReport?.pairedDelta || null;

  const summary = {
    schemaVersion: '1.1.0',
    title,
    generatedAt,
    verificationScope: scope,
    overallVerdict,
    counts: {
      passed: checklist.filter((c) => c.status === 'PASS').length,
      warn: warnings,
      failed: hardFailures,
      pendingExternal,
      totalChecklistItems: checklist.length,
    },
    evidenceSources: {
      harnessIncluded: Boolean(harnessReport),
      lmeIncluded: Boolean(lmeReport),
      locomoIncluded: Boolean(locomoReport),
      convergenceIncluded: Boolean(convergenceReport),
      harnessHealthMode: harnessReport?.health?.mode || null,
      lmeGatewayMode: lmeReport?.ameGateway?.health?.mode || null,
      lmeDatasetKind: lmeReport?.dataset?.datasetKind || null,
      lmeEvaluatedItems: lmeReport?.dataset?.evaluatedCount ?? null,
      locomoGatewayMode:
        locomoReport?.ameGateway?.health?.mode || locomoReport?.engineMode || null,
      locomoDatasetKind: locomoReport?.dataset?.datasetKind || null,
      locomoSliceTag: locomoReport?.dataset?.sliceTag || null,
      locomoEvaluatedItems: locomoReport?.dataset?.evaluatedCount ?? null,
      convergenceGatewayMode:
        convergenceReport?.engineMode || convergenceReport?.health?.mode || null,
      convergenceTurns: convergenceReport?.config?.turns ?? null,
    },
    governanceGates: harnessReport
      ? {
          suiteName: harnessReport.suiteName,
          suiteVersion: harnessReport.suiteVersion,
          overallPass: harnessReport.overallPass,
          passed: harnessReport.passed,
          failed: harnessReport.failed,
          total: harnessReport.total,
          metrics: harnessReport.metrics,
          checks: (harnessReport.checks || []).map((c) => ({
            id: c.id,
            dimension: c.dimension,
            passed: c.passed,
            summary: c.summary,
          })),
        }
      : null,
    longMemEvalComparison: lmeReport
      ? {
          dataset: lmeReport.dataset,
          config: lmeReport.config,
          ameGateway: ame,
          bareFrontier: bare,
          pairedDelta: delta,
        }
      : null,
    locomoComparison: locomoReport
      ? {
          dataset: locomoReport.dataset,
          config: locomoReport.config,
          ameGateway: locAme,
          bareFrontier: locBare,
          pairedDelta: locDelta,
          publishedReferences: locomoReport.publishedReferences || null,
        }
      : null,
    batchConvergence: convergenceReport
      ? {
          engineMode: convergenceReport.engineMode || convergenceReport.health?.mode || null,
          config: convergenceReport.config,
          executionStats: convergenceReport.executionStats || null,
          invariants: convergenceReport.invariants,
          d4Audit: convergenceReport.d4Audit,
          deltaVsBaseline: convergenceReport.deltaVsBaseline || null,
          arms: convergenceReport.arms,
          overallPass: convergenceReport.overallPass,
        }
      : null,
    unitEconomics: {
      kvMeanCachedRatioPct:
        ame?.meanCachedRatioPct ??
        locAme?.meanCachedRatioPct ??
        harnessReport?.metrics?.kvMeanCachedRatioPct ??
        null,
      tokenReductionRatio: delta?.tokenReductionRatio ?? locDelta?.tokenReductionRatio ?? null,
      tokenReductionPct: delta?.tokenReductionPct ?? locDelta?.tokenReductionPct ?? null,
      tokenCompressionFactor:
        delta?.tokenCompressionFactor ?? locDelta?.tokenCompressionFactor ?? null,
      amePromptBounded: delta?.amePromptBounded ?? locDelta?.amePromptBounded ?? null,
      amePromptGrowthRatio:
        ame?.scaling?.queryPromptGrowthRatio ?? locAme?.scaling?.queryPromptGrowthRatio ?? null,
      barePromptGrowthRatio:
        bare?.scaling?.queryPromptGrowthRatio ?? locBare?.scaling?.queryPromptGrowthRatio ?? null,
      locomoTokenReductionPct: locDelta?.tokenReductionPct ?? null,
      locomoCompressionFactor: locDelta?.tokenCompressionFactor ?? null,
      locomoKvMeanCachedRatioPct: locAme?.meanCachedRatioPct ?? null,
    },
    readinessChecks: checklist,
  };

  // Build Markdown Report
  const md = [];
  md.push(`# ${title}`);
  md.push('');
  md.push(`- **Generated**: \`${generatedAt}\``);
  md.push(`- **Verification Tier**: \`${scope.tier}\` — **${scope.tierLabel}**`);
  md.push(`- **Overall Verdict**: \`${overallVerdict}\``);
  md.push('');

  md.push('> [!IMPORTANT]');
  md.push(
    `> **Evidence Provenance Disclosure**: This scorecard strictly reports measured telemetry from the supplied JSON artifact(s) under \`${scope.tier}\`. ` +
      (scope.isSealedKernel && scope.isExternalDataset && !scope.usesMockOrLocalStub
        ? 'All figures reflect live sealed-kernel execution against external benchmark datasets and live frontier LLMs.'
        : 'Local contract sandbox (`sandbox-contract`), synthetic smoke fixtures, or local LLM stubs verify OpenAPI 3.1 contract conformance, governance invariants (D2/D3/D4/HOT/KV), convergence determinism, and O(1) prompt bounding—they must NOT be cited as external sealed-kernel production recall SOTA.')
  );
  if (scope.caveats.length > 0) {
    for (const c of scope.caveats) {
      md.push(`> - ${c}`);
    }
  }
  md.push('');

  md.push('## 1. Executive Technical Due-Diligence Checklist');
  md.push('');
  md.push('| Check | Status | Measured Evidence |');
  md.push('| :--- | :---: | :--- |');
  for (const item of checklist) {
    md.push(`| ${item.label} | \`${item.status}\` | ${item.evidence} |`);
  }
  md.push('');

  let sectionNum = 2;

  if (harnessReport) {
    md.push(`## ${sectionNum}. Cognitive & Governance Invariants (\`run_harness.mjs\` — 7 Black-Box Gates)`);
    sectionNum += 1;
    md.push('');
    md.push(
      `- **Target**: \`${harnessReport.config?.baseUrl || 'n/a'}\` (` +
        `mode=\`${harnessReport.health?.mode || 'unknown'}\`, ` +
        `adapter=\`${harnessReport.config?.provider || 'unknown'}/${harnessReport.config?.model || 'unknown'}\`)`
    );
    md.push(
      `- **Gate Result**: **${harnessReport.passed}/${harnessReport.total} passed** (` +
        `API calls=\`${harnessReport.metrics?.totalApiCalls ?? 'n/a'}\`, ` +
        `duration=\`${harnessReport.metrics?.durationMs ?? 'n/a'} ms\`)`
    );
    md.push('');
    md.push('| # / Dimension | Status | Measured Summary |');
    md.push('| :--- | :---: | :--- |');
    for (const c of harnessReport.checks || []) {
      md.push(`| ${c.dimension} | \`${c.passed ? 'PASS' : 'FAIL'}\` | ${c.summary} |`);
    }
    md.push('');

    const m = harnessReport.metrics || {};
    md.push('### Key Invariant Telemetry');
    md.push('');
    md.push('| Invariant Metric | Measured Value |');
    md.push('| :--- | :--- |');
    md.push(`| Continuity Recall Rate (Mode A + Mode B) | ${fmtPct(m.continuityRecallRate, true)} |`);
    md.push(
      `| HOT Type-2 Abstention (Accuracy / F1 / FAR) | ${fmtPct(m.hotAbstentionAccuracy, true)} / ${fmtNum(m.hotAbstentionF1)} / ${fmtPct(m.hotFalseAbstentionRate, true)} |`
    );
    md.push(
      `| Somatic Learning Polarity (-250 vs +80) | \`${m.somaticNegativeTrend}\` vs \`${m.somaticPositiveTrend}\` |`
    );
    md.push(
      `| D2 Homeostasis (0h Delta / 6h..72h Delta) | \`${m.d2ZeroTickDelta}\` / \`${m.d2HomeostasisDelta}\` |`
    );
    md.push(`| D3 Atomic Revocation Leak Rate | \`${fmtNum(m.d3RevocationLeakRatePct, '%')}\` |`);
    md.push(
      `| D4 Telemetry Isolation (\`d4RedactedAll\` / Leaks) | \`${m.d4RedactedAll}\` / \`${m.d4LeakCount}\` |`
    );
    md.push(
      `| KV Prefix Cache (Follow-up Mean / Epoch Bump) | \`${fmtNum(m.kvMeanCachedRatioPct, '%')}\` / \`${m.kvEpochBeforeRevoke} -> ${m.kvEpochAfterRevoke}\` |`
    );
    md.push('');
  }

  if (lmeReport) {
    md.push(`## ${sectionNum}. LongMemEval-S Paired Frontier Comparison (\`AME Gateway\` vs \`Bare Frontier\`)`);
    sectionNum += 1;
    md.push('');
    md.push(
      `- **Dataset**: \`${path.basename(lmeReport.dataset?.datasetPath || 'unknown')}\` (` +
        `kind=\`${lmeReport.dataset?.datasetKind || 'unknown'}\`, ` +
        `evaluated=\`${lmeReport.dataset?.evaluatedCount ?? 0}/${lmeReport.dataset?.totalInFile ?? 0}\`)`
    );
    md.push(
      `- **Execution**: arm=\`${lmeReport.config?.arm}\`, provider=\`${lmeReport.config?.provider}/${lmeReport.config?.model}\`, ` +
        `ameMode=\`${lmeReport.config?.ameMode}\`, gatewayMode=\`${lmeReport.ameGateway?.health?.mode || 'n/a'}\``
    );
    md.push('');

    md.push('| Metric | AME Gateway | Bare Frontier | Paired Delta |');
    md.push('| :--- | ---: | ---: | ---: |');
    md.push(
      `| Overall Accuracy | ${fmtPct(ame?.accuracyPct)} | ${fmtPct(bare?.accuracyPct)} | ${fmtSigned(delta?.accuracyDeltaPct, '%p')} |`
    );
    md.push(
      `| Exact Match | ${fmtPct(ame?.exactMatchPct)} | ${fmtPct(bare?.exactMatchPct)} | ${fmtSigned(delta?.exactMatchDeltaPct, '%p')} |`
    );
    md.push(
      `| Contains Match | ${fmtPct(ame?.containsMatchPct)} | ${fmtPct(bare?.containsMatchPct)} | ${fmtSigned(delta?.containsMatchDeltaPct, '%p')} |`
    );
    md.push(
      `| Mean Token F1 | ${fmtNum(ame?.meanTokenF1)} | ${fmtNum(bare?.meanTokenF1)} | ${fmtSigned(delta?.tokenF1Delta)} |`
    );
    md.push(
      `| Abstention Accuracy | ${fmtPct(ame?.abstentionAccuracy, true)} | ${fmtPct(bare?.abstentionAccuracy, true)} | ${fmtSigned(delta?.abstentionAccuracyDeltaPct, '%p')} |`
    );
    md.push(
      `| False-Abstention Rate (FAR) | ${fmtPct(ame?.abstentionFAR, true)} | ${fmtPct(bare?.abstentionFAR, true)} | ${fmtSigned(delta?.abstentionFARDeltaPct, '%p')} |`
    );
    md.push(
      `| Mean Query Prompt Tokens | ${fmtNum(ame?.meanQueryPromptTokens)} | ${fmtNum(bare?.meanQueryPromptTokens)} | ${delta?.tokensSavedMeanPerQuery !== null && delta?.tokensSavedMeanPerQuery !== undefined ? `${delta.tokensSavedMeanPerQuery} saved` : 'n/a'} |`
    );
    md.push(
      `| Max Query Prompt Tokens | ${fmtNum(ame?.maxQueryPromptTokens)} | ${fmtNum(bare?.maxQueryPromptTokens)} | ${delta?.tokenCompressionFactor ? `${delta.tokenCompressionFactor}x compression` : 'n/a'} |`
    );
    md.push(
      `| Token Reduction Ratio | ${fmtNum(delta?.tokenReductionRatio)} (${fmtPct(delta?.tokenReductionPct)}) | baseline (0.00%) | O(1) bounded=\`${delta?.amePromptBounded ?? 'n/a'}\` |`
    );
    md.push(
      `| Prompt Growth (Short -> Long Haystack) | ${fmtNum(ame?.scaling?.queryPromptGrowthRatio, 'x')} | ${fmtNum(bare?.scaling?.queryPromptGrowthRatio, 'x')} | raw=${fmtNum(ame?.scaling?.rawHaystackGrowthRatio ?? bare?.scaling?.rawHaystackGrowthRatio, 'x')} |`
    );
    md.push(
      `| KV Prefix Cached Ratio (Follow-up Mean) | ${fmtNum(ame?.meanCachedRatioPct, '%')} | 0.00% (stateless) | ${fmtNum(ame?.prefixInvariantMinds)}/${fmtNum(ame?.totalItems)} invariant |`
    );
    md.push(
      `| Query Latency p50 / p95 (ms) | ${fmtNum(ame?.latencyMs?.p50)} / ${fmtNum(ame?.latencyMs?.p95)} | ${fmtNum(bare?.latencyMs?.p50)} / ${fmtNum(bare?.latencyMs?.p95)} | p50 ${fmtSigned(delta?.latencyP50DeltaMs, ' ms')} |`
    );
    md.push(
      `| D4 Redaction (\`d4RedactedAll\`) | \`${ame?.d4RedactedAll ?? 'n/a'}\` (leaks=${ame?.d4ForbiddenKeyLeakCount ?? 'n/a'}) | structurally n/a | \`${delta?.d4RedactedAll ?? ame?.d4RedactedAll ?? 'n/a'}\` |`
    );
    md.push('');

    const questionTypes = new Set([
      ...Object.keys(ame?.byQuestionType || {}),
      ...Object.keys(bare?.byQuestionType || {}),
    ]);
    if (questionTypes.size > 0) {
      md.push('### Breakdown by `question_type`');
      md.push('');
      md.push('| Question Type | Items | AME Acc (F1) | Bare Frontier Acc (F1) |');
      md.push('| :--- | ---: | ---: | ---: |');
      for (const qt of questionTypes) {
        const aQt = ame?.byQuestionType?.[qt];
        const bQt = bare?.byQuestionType?.[qt];
        const count = aQt?.total ?? bQt?.total ?? 0;
        const aStr = aQt ? `${aQt.accuracyPct.toFixed(1)}% (${aQt.meanTokenF1})` : 'n/a';
        const bStr = bQt ? `${bQt.accuracyPct.toFixed(1)}% (${bQt.meanTokenF1})` : 'n/a';
        md.push(`| \`${qt}\` | ${count} | ${aStr} | ${bStr} |`);
      }
      md.push('');
    }
  }

  if (locomoReport) {
    md.push(`## ${sectionNum}. LoCoMo Paired Frontier Comparison (\`AME Gateway\` vs \`Bare Frontier\`)`);
    sectionNum += 1;
    md.push('');
    md.push(
      `- **Dataset**: \`${path.basename(locomoReport.dataset?.datasetPath || 'unknown')}\` (` +
        `kind=\`${locomoReport.dataset?.datasetKind || 'unknown'}\`, ` +
        `slice=\`${locomoReport.dataset?.sliceTag || 'custom'}\`, ` +
        `evaluated=\`${locomoReport.dataset?.evaluatedCount ?? 0}/${locomoReport.dataset?.totalInFile ?? 0}\` QA across \`${locomoReport.dataset?.conversationsEvaluated ?? 0}\` conversations)`
    );
    md.push(
      `- **Execution**: arm=\`${locomoReport.config?.arm}\`, provider=\`${locomoReport.config?.provider}/${locomoReport.config?.model}\`, ` +
        `ameMode=\`${locomoReport.config?.ameMode}\`, engineMode=\`${locomoReport.ameGateway?.health?.mode || locomoReport.engineMode || 'n/a'}\`, ` +
        `judge=\`${locomoReport.config?.judgeEnabled ? `${locomoReport.config.judgeProvider}/${locomoReport.config.judgeModel}` : 'heuristic-only'}\``
    );
    md.push('');

    md.push('| Metric | AME Gateway | Bare Frontier | Paired Delta |');
    md.push('| :--- | ---: | ---: | ---: |');
    md.push(
      `| Overall Accuracy (Heuristic) | ${fmtPct(locAme?.accuracyPct)} | ${fmtPct(locBare?.accuracyPct)} | ${fmtSigned(locDelta?.accuracyDeltaPct, '%p')} |`
    );
    if (locAme?.judgeEnabled || locBare?.judgeEnabled) {
      md.push(
        `| Overall Accuracy (LLM Judge) | ${fmtPct(locAme?.judgeAccuracyPct)} | ${fmtPct(locBare?.judgeAccuracyPct)} | ${fmtSigned(locDelta?.judgeAccuracyDeltaPct, '%p')} |`
      );
    }
    md.push(
      `| Cat 1–4 Mean (Non-Adversarial) | ${fmtPct(locAme?.cat1To4?.accuracyPct)} | ${fmtPct(locBare?.cat1To4?.accuracyPct)} | ${fmtSigned(locDelta?.cat1To4DeltaPct, '%p')} |`
    );
    md.push(
      `| Exact Match | ${fmtPct(locAme?.exactMatchPct)} | ${fmtPct(locBare?.exactMatchPct)} | ${fmtSigned(locDelta?.exactMatchDeltaPct, '%p')} |`
    );
    md.push(
      `| Contains Match | ${fmtPct(locAme?.containsMatchPct)} | ${fmtPct(locBare?.containsMatchPct)} | ${fmtSigned(locDelta?.containsMatchDeltaPct, '%p')} |`
    );
    md.push(
      `| Mean Token F1 | ${fmtNum(locAme?.meanTokenF1)} | ${fmtNum(locBare?.meanTokenF1)} | ${fmtSigned(locDelta?.tokenF1Delta)} |`
    );
    md.push(
      `| Adversarial Abstention Acc / FAR | ${fmtPct(locAme?.abstentionAccuracy, true)} / ${fmtPct(locAme?.abstentionFAR, true)} | ${fmtPct(locBare?.abstentionAccuracy, true)} / ${fmtPct(locBare?.abstentionFAR, true)} | FAR ${fmtSigned(locDelta?.abstentionFARDeltaPct, '%p')} |`
    );
    md.push(
      `| Mean Query Prompt Tokens | ${fmtNum(locAme?.meanQueryPromptTokens)} | ${fmtNum(locBare?.meanQueryPromptTokens)} | ${locDelta?.tokensSavedMeanPerQuery !== null && locDelta?.tokensSavedMeanPerQuery !== undefined ? `${locDelta.tokensSavedMeanPerQuery} saved` : 'n/a'} |`
    );
    md.push(
      `| Token Reduction Ratio | ${fmtNum(locDelta?.tokenReductionRatio)} (${fmtPct(locDelta?.tokenReductionPct)}) | baseline (0.00%) | ${locDelta?.tokenCompressionFactor ? `${locDelta.tokenCompressionFactor}x compression` : 'n/a'}, O(1)=\`${locDelta?.amePromptBounded ?? 'n/a'}\` |`
    );
    md.push(
      `| Prompt Growth (Short -> Long Conv) | ${fmtNum(locAme?.scaling?.queryPromptGrowthRatio, 'x')} | ${fmtNum(locBare?.scaling?.queryPromptGrowthRatio, 'x')} | raw=${fmtNum(locAme?.scaling?.rawConversationGrowthRatio ?? locBare?.scaling?.rawConversationGrowthRatio, 'x')} |`
    );
    md.push(
      `| KV Prefix Cached Ratio (Follow-up Mean) | ${fmtNum(locAme?.meanCachedRatioPct, '%')} | 0.00% (stateless) | ${fmtNum(locAme?.prefixInvariantConversations)}/${fmtNum(locAme?.conversationsEvaluated)} convs invariant |`
    );
    md.push(
      `| Query Latency p50 / p95 (ms) | ${fmtNum(locAme?.latencyMs?.p50)} / ${fmtNum(locAme?.latencyMs?.p95)} | ${fmtNum(locBare?.latencyMs?.p50)} / ${fmtNum(locBare?.latencyMs?.p95)} | p50 ${fmtSigned(locDelta?.latencyP50DeltaMs, ' ms')} |`
    );
    md.push(
      `| D4 Redaction (\`d4RedactedAll\`) | \`${locAme?.d4RedactedAll ?? 'n/a'}\` (leaks=${locAme?.d4ForbiddenKeyLeakCount ?? 'n/a'}) | structurally n/a | \`${locDelta?.d4RedactedAll ?? locAme?.d4RedactedAll ?? 'n/a'}\` |`
    );
    md.push('');

    const catKeys = ['1', '2', '3', '4', '5'].filter(
      (k) => locAme?.byCategory?.[k] || locBare?.byCategory?.[k]
    );
    if (catKeys.length > 0) {
      md.push('### LoCoMo Category Breakdown (`Cat 1`–`Cat 5`)');
      md.push('');
      md.push('| Category | Items | AME Acc (F1) | Bare Frontier Acc (F1) |');
      md.push('| :--- | ---: | ---: | ---: |');
      for (const k of catKeys) {
        const aC = locAme?.byCategory?.[k];
        const bC = locBare?.byCategory?.[k];
        const label = aC?.label || bC?.label || `Cat ${k}`;
        const count = aC?.total ?? bC?.total ?? 0;
        const aStr = aC ? `${aC.accuracyPct.toFixed(1)}% (${aC.meanTokenF1})` : 'n/a';
        const bStr = bC ? `${bC.accuracyPct.toFixed(1)}% (${bC.meanTokenF1})` : 'n/a';
        md.push(`| \`Cat ${k}\` (${label}) | ${count} | ${aStr} | ${bStr} |`);
      }
      md.push('');
    }

    if (Array.isArray(locomoReport.publishedReferences) && locomoReport.publishedReferences.length > 0) {
      md.push('### Published Reference Comparison Table (External Literature & Prior Tier-1 Anchors — Not Live Run)');
      md.push('');
      md.push('> [!NOTE]');
      md.push('> Rows below are published literature baselines and prior Tier-1 `Confirm-304` / `n=1,986` references for context only; they are strictly separated from the live measured run above.');
      md.push('');
      md.push('| System | Reference Accuracy | Source Tier / Scope |');
      md.push('| :--- | ---: | :--- |');
      for (const ref of locomoReport.publishedReferences) {
        md.push(
          `| ${ref.system} | ${Number(ref.overallAccuracyPct).toFixed(2)}% | ${ref.scope} (\`${ref.sourceTier}\`) |`
        );
      }
      md.push('');
    }
  }

  if (convergenceReport) {
    const cCfg = convergenceReport.config || {};
    const cInv = convergenceReport.invariants || {};
    const cArms = convergenceReport.arms || {};
    const cExec = convergenceReport.executionStats || {};
    md.push(
      `## ${sectionNum}. Long-Horizon Batch Convergence (\`simulate-batch\` — ${fmtNum(cCfg.turns)} Turns × ${fmtNum(cCfg.profiles)} Profiles)`
    );
    sectionNum += 1;
    md.push('');
    md.push(
      `- **Target**: \`${cCfg.baseUrl || 'n/a'}\` | **EngineMode**: \`${convergenceReport.engineMode || convergenceReport.health?.mode || 'unknown'}\` | ` +
        `**Checkpoints**: \`${fmtNum(cCfg.checkpoints)}\` | **Seed**: \`${fmtNum(cCfg.seed)}\` | **Verdict**: \`${convergenceReport.overallPass ? 'PASS' : 'FAIL'}\``
    );
    if (cExec.turnsPerSecond) {
      md.push(
        `- **Throughput**: \`${cExec.totalExecutedTurnsAllArms?.toLocaleString() || 'n/a'}\` total simulated arm-turns in \`${cExec.elapsedMs ?? convergenceReport.durationMs} ms\` (\`${cExec.turnsPerSecond.toLocaleString()} turns/sec\`)`
      );
    }
    md.push('');
    md.push(
      '| Arm | Composite (Init -> Final) | Placement | Polarity | Granularity | Attention | Ego Soundness | Safety Compliance | Drift Delta |'
    );
    md.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [armKey, armLabel] of [
      ['mind_off', '`mind_off` (Kernel Disabled)'],
      ['aacim_off', '`aacim_off` (Control Disabled)'],
      ['ame_aacim_on', '**`ame_aacim_on` (AME)**'],
    ]) {
      const a = cArms[armKey];
      if (!a) continue;
      md.push(
        `| ${armLabel} | ${fmtFixed4(a.compositeInitial)} -> ${fmtFixed4(a.compositeFinal)} | ${fmtFixed4(a.placementIntegrity)} | ${fmtFixed4(a.polarity)} | ${fmtFixed4(a.granularity)} | ${fmtFixed4(a.attentionStability)} | ${fmtFixed4(a.egoSoundness)} | ${fmtFixed4(a.safetyCompliance)} | ${fmtFixed4(a.maxDrift)} |`
      );
    }
    md.push('');
    md.push('| Convergence & Governance Invariant | Status / Value |');
    md.push('| :--- | :--- |');
    md.push(`| \`driftBounded\` | \`${cInv.driftBounded}\` |`);
    md.push(
      `| Composite Gain vs \`aacim_off\` / \`mind_off\` | \`${fmtSigned(cInv.deltaVsAacimOff)}\` / \`${fmtSigned(cInv.deltaVsMindOff)}\` |`
    );
    md.push(
      `| Safety Gain vs \`aacim_off\` | \`${fmtSigned(cInv.safetyGainOverAacimOff)}\` |`
    );
    md.push(
      `| D4 Telemetry Isolation (\`d4Redacted\` / Leaks) | \`${cInv.d4Redacted}\` (checked=${convergenceReport.d4Audit?.telemetryObjectsChecked ?? 0}, leaks=${convergenceReport.d4Audit?.forbiddenKeyLeakCount ?? 'n/a'}) |`
    );
    md.push('');
  }

  md.push(`## ${sectionNum}. Sealed-Kernel Production Evaluation Upgrade Path`);
  md.push('');
  md.push(
    'To upgrade from `sandbox-contract-verification` to `sealed-kernel-production-eval` during external DD:'
  );
  md.push('');
  md.push('```bash');
  md.push('# 1. Start proprietary sealed kernel container (instead of local sandbox)');
  md.push('docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env up -d');
  md.push('');
  md.push('# 2. Run 7-gate CogEval + LoCoMo harness');
  md.push('AME_BASE_URL=http://127.0.0.1:8090 AME_API_KEY=<key> AME_LLM_PROVIDER=openai AME_LLM_MODEL=gpt-4o-mini AME_LLM_API_KEY=sk-... \\');
  md.push('  node benchmarks/cogeval-locomo-harness/run_harness.mjs --json-out ./artifacts/harness-sealed.json');
  md.push('');
  md.push('# 3. Run full 500-item LongMemEval-S paired comparator');
  md.push('AME_BASE_URL=http://127.0.0.1:8090 AME_API_KEY=<key> AME_LLM_PROVIDER=openai AME_LLM_MODEL=gpt-4o-mini AME_LLM_API_KEY=sk-... \\');
  md.push('  node benchmarks/cogeval-locomo-harness/longmemeval_frontier_runner.mjs --dataset /path/to/longmemeval_s_cleaned.json --arm both --json-out ./artifacts/lme-sealed-500.json');
  md.push('');
  md.push('# 4. Run LoCoMo Confirm-304 (conv-26,conv-30) or Full (n=1,986) paired comparator');
  md.push('AME_BASE_URL=http://127.0.0.1:8090 AME_API_KEY=<key> AME_LLM_PROVIDER=openai AME_LLM_MODEL=gpt-4o-mini AME_LLM_API_KEY=sk-... \\');
  md.push('  node benchmarks/cogeval-locomo-harness/locomo_frontier_runner.mjs --dataset /path/to/locomo10.json --conversations conv-26,conv-30 --arm both --judge-provider openai --judge-model gpt-4o --json-out ./artifacts/locomo-sealed-304.json');
  md.push('');
  md.push('# 5. Run 1M-turn deterministic batch convergence check');
  md.push('AME_BASE_URL=http://127.0.0.1:8090 AME_API_KEY=<key> \\');
  md.push('  node benchmarks/cogeval-locomo-harness/batch_convergence_runner.mjs --turns 1000000 --profiles 40 --checkpoints 8 --json-out ./artifacts/convergence-sealed-1m.json');
  md.push('');
  md.push('# 6. Synthesize unified institutional DD scorecard');
  md.push('node benchmarks/cogeval-locomo-harness/dd_scorecard_generator.mjs \\');
  md.push('  --harness-json ./artifacts/harness-sealed.json --lme-json ./artifacts/lme-sealed-500.json \\');
  md.push('  --locomo-json ./artifacts/locomo-sealed-304.json --convergence-json ./artifacts/convergence-sealed-1m.json \\');
  md.push('  --out-md ./artifacts/dd-scorecard.md --out-json ./artifacts/dd-scorecard.json');
  md.push('```');
  md.push('');

  return {
    markdown: `${md.join('\n')}`,
    summary,
  };
}

async function readJsonFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label} (${resolved}): ${err.message}`);
  }
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[dd-scorecard] ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  if (
    !cli.harnessJsonPath &&
    !cli.lmeJsonPath &&
    !cli.locomoJsonPath &&
    !cli.convergenceJsonPath
  ) {
    console.error(
      '[dd-scorecard] At least one of --harness-json, --lme-json, --locomo-json, or --convergence-json is required.'
    );
    printUsage();
    process.exit(1);
  }

  const [harnessReport, lmeReport, locomoReport, convergenceReport] = await Promise.all([
    cli.harnessJsonPath ? readJsonFile(cli.harnessJsonPath, '--harness-json') : null,
    cli.lmeJsonPath ? readJsonFile(cli.lmeJsonPath, '--lme-json') : null,
    cli.locomoJsonPath ? readJsonFile(cli.locomoJsonPath, '--locomo-json') : null,
    cli.convergenceJsonPath ? readJsonFile(cli.convergenceJsonPath, '--convergence-json') : null,
  ]);

  const { markdown, summary } = generateDdScorecard({
    harnessReport,
    lmeReport,
    locomoReport,
    convergenceReport,
    title: cli.title || undefined,
  });

  if (cli.outMd) {
    const outMdPath = path.resolve(cli.outMd);
    await fs.mkdir(path.dirname(outMdPath), { recursive: true });
    await fs.writeFile(outMdPath, `${markdown}\n`, 'utf8');
  }

  const jsonText = JSON.stringify(summary, null, 2);
  if (cli.outJson) {
    const outJsonPath = path.resolve(cli.outJson);
    await fs.mkdir(path.dirname(outJsonPath), { recursive: true });
    await fs.writeFile(outJsonPath, `${jsonText}\n`, 'utf8');
  }

  if (cli.jsonOnly) {
    console.log(jsonText);
  } else {
    console.log(markdown);
  }

  const hasHardFailures = summary.counts.failed > 0;
  process.exit(hasHardFailures ? 1 : 0);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`[dd-scorecard] Unhandled error: ${err?.stack || err}`);
    process.exit(1);
  });
}
