#!/usr/bin/env node
/**
 * Institutional VC Technical Due-Diligence (DD) Scorecard Generator for AME.
 *
 * Synthesizes outputs from:
 *   - `run_harness.mjs` (7 black-box CogEval + LoCoMo governance gates)
 *   - `longmemeval_frontier_runner.mjs` (paired AME Gateway vs Bare Frontier LongMemEval-S run)
 *
 * Strictly separates live `sandbox-contract` / offline smoke verification runs from
 * external `sealed-kernel` / production LLM benchmark evaluations.
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
    'Options:',
    '  --harness-json <path>   Path to JSON report produced by run_harness.mjs',
    '  --lme-json <path>       Path to JSON report produced by longmemeval_frontier_runner.mjs',
    '  --out-md <path>         Write Markdown DD scorecard report to <path>',
    '  --out-json <path>       Write structured DD scorecard JSON summary to <path>',
    '  --title <text>          Optional custom scorecard title',
    '  --json-only             Print JSON summary to stdout instead of Markdown',
    '  -h, --help              Show this help message',
  ];
  console.log(lines.join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    harnessJsonPath: null,
    lmeJsonPath: null,
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

function classifyVerificationScope({ harnessReport, lmeReport }) {
  const harnessGatewayMode = harnessReport?.health?.mode || null;
  const lmeGatewayMode = lmeReport?.ameGateway?.health?.mode || null;
  const gatewayModes = [harnessGatewayMode, lmeGatewayMode].filter(Boolean);
  const allSealed = gatewayModes.length > 0 && gatewayModes.every((m) => m === 'sealed-kernel');

  const datasetKind = lmeReport?.dataset?.datasetKind || null;
  const lmeProvider = lmeReport?.config?.provider || null;
  const lmeLlmBaseUrl = lmeReport?.config?.llmBaseUrl || null;
  const harnessProvider = harnessReport?.config?.provider || null;

  const usesMockOrLocalStub =
    lmeProvider === 'mock' ||
    isLocalEndpoint(lmeLlmBaseUrl) ||
    (!lmeReport && harnessProvider === 'mock');

  const isExternalDataset = datasetKind === 'external_longmemeval';

  let tier = 'sandbox-contract-verification';
  let tierLabel = 'Sandbox Contract & Harness Verification (Non-Production)';
  if (allSealed && isExternalDataset && !usesMockOrLocalStub) {
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
  if (datasetKind === 'synthetic_offline_smoke') {
    caveats.push(
      'LongMemEval comparison used the 10-item synthetic offline smoke fixture (sample_longmemeval.json), NOT the 500-item external longmemeval_s_cleaned.json benchmark.'
    );
  }
  if (usesMockOrLocalStub) {
    caveats.push(
      `LLM inference used mock/local endpoint (${lmeProvider || harnessProvider}${lmeLlmBaseUrl ? ` @ ${lmeLlmBaseUrl}` : ''}) for deterministic zero-cost verification rather than an external frontier API.`
    );
  }

  return {
    tier,
    tierLabel,
    isSealedKernel: allSealed,
    isExternalDataset,
    usesMockOrLocalStub,
    gatewayModes,
    datasetKind,
    caveats,
  };
}

function buildDdChecklist({ harnessReport, lmeReport, scope }) {
  const hm = harnessReport?.metrics || null;
  const ame = lmeReport?.ameGateway?.metrics || null;
  const bare = lmeReport?.bareFrontier?.metrics || null;
  const delta = lmeReport?.pairedDelta || null;

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

  items.push({
    id: 'external_sealed_production_eval',
    label: 'External Sealed-Kernel 500-QA Frontier Benchmark Sign-Off',
    status:
      scope.tier === 'sealed-kernel-production-eval' && (lmeReport?.dataset?.evaluatedCount ?? 0) >= 500
        ? 'PASS'
        : 'PENDING_EXTERNAL_RUN',
    evidence:
      scope.tier === 'sealed-kernel-production-eval'
        ? `Verified live on sealed-kernel (${lmeReport?.dataset?.evaluatedCount || 0} items)`
        : 'Requires running against sealed-kernel container with external longmemeval_s_cleaned.json and live frontier API key',
  });

  return items;
}

/**
 * Generate a complete institutional VC Technical DD Scorecard Markdown report and JSON summary.
 */
export function generateDdScorecard({
  harnessReport = null,
  lmeReport = null,
  title = 'Artificial Mind Engine (AME) — Technical Due-Diligence Scorecard',
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!harnessReport && !lmeReport) {
    throw new Error('generateDdScorecard requires at least one of harnessReport or lmeReport');
  }

  const scope = classifyVerificationScope({ harnessReport, lmeReport });
  const checklist = buildDdChecklist({ harnessReport, lmeReport, scope });

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

  const summary = {
    schemaVersion: '1.0.0',
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
      harnessHealthMode: harnessReport?.health?.mode || null,
      lmeGatewayMode: lmeReport?.ameGateway?.health?.mode || null,
      lmeDatasetKind: lmeReport?.dataset?.datasetKind || null,
      lmeEvaluatedItems: lmeReport?.dataset?.evaluatedCount ?? null,
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
    unitEconomics: {
      kvMeanCachedRatioPct:
        ame?.meanCachedRatioPct ?? harnessReport?.metrics?.kvMeanCachedRatioPct ?? null,
      tokenReductionRatio: delta?.tokenReductionRatio ?? null,
      tokenReductionPct: delta?.tokenReductionPct ?? null,
      tokenCompressionFactor: delta?.tokenCompressionFactor ?? null,
      amePromptBounded: delta?.amePromptBounded ?? null,
      amePromptGrowthRatio: ame?.scaling?.queryPromptGrowthRatio ?? null,
      barePromptGrowthRatio: bare?.scaling?.queryPromptGrowthRatio ?? null,
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
        ? 'All figures reflect live sealed-kernel execution against an external LongMemEval dataset and live frontier LLM.'
        : 'Local contract sandbox (`sandbox-contract`), synthetic smoke fixtures, or local LLM stubs verify OpenAPI 3.1 contract conformance, governance invariants (D2/D3/D4/HOT/KV), and O(1) prompt bounding—they must NOT be cited as external sealed-kernel production recall SOTA.')
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

  if (harnessReport) {
    md.push('## 2. Cognitive & Governance Invariants (`run_harness.mjs` — 7 Black-Box Gates)');
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
    const sectionNum = harnessReport ? 3 : 2;
    md.push(`## ${sectionNum}. LongMemEval-S Paired Frontier Comparison (\`AME Gateway\` vs \`Bare Frontier\`)`);
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

  const nextSection = (harnessReport ? 1 : 0) + (lmeReport ? 1 : 0) + 2;
  md.push(`## ${nextSection}. Sealed-Kernel Production Evaluation Upgrade Path`);
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
  md.push('# 4. Synthesize institutional DD scorecard');
  md.push('node benchmarks/cogeval-locomo-harness/dd_scorecard_generator.mjs \\');
  md.push('  --harness-json ./artifacts/harness-sealed.json --lme-json ./artifacts/lme-sealed-500.json \\');
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

  if (!cli.harnessJsonPath && !cli.lmeJsonPath) {
    console.error('[dd-scorecard] At least one of --harness-json or --lme-json is required.');
    printUsage();
    process.exit(1);
  }

  const harnessReport = cli.harnessJsonPath
    ? await readJsonFile(cli.harnessJsonPath, '--harness-json')
    : null;
  const lmeReport = cli.lmeJsonPath
    ? await readJsonFile(cli.lmeJsonPath, '--lme-json')
    : null;

  const { markdown, summary } = generateDdScorecard({
    harnessReport,
    lmeReport,
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
