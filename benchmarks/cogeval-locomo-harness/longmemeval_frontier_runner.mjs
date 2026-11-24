#!/usr/bin/env node
/**
 * Black-Box LongMemEval-S + Bare Frontier Paired Comparator for Artificial Mind Engine (AME).
 *
 * Evaluates up to the full 500-item LongMemEval-S benchmark (`longmemeval_s_cleaned.json`)
 * or the bundled 10-item synthetic offline smoke fixture (`sample_longmemeval.json`)
 * across two arms:
 *   1. `ame-gateway`: Isolated Mind per question via @ame/sdk (OpenAPI 3.1), sequential
 *      haystack ingestion, bounded O(1) Mode A/B query, KV cache telemetry, and D4 redaction audit.
 *   2. `bare-frontier`: Stateless full-context baseline packing dated `haystack_sessions`
 *      into a single flattened prompt via `createLlmAdapter` (O(T) single-query / O(T^2) replay cost).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AmeClient,
  createLlmAdapter,
} from '../../packages/sdk-ts/src/index.mjs';

const DEFAULT_DATASET_URL = new URL('./sample_longmemeval.json', import.meta.url);

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
]);

const ABSTENTION_REPLY_PATTERNS = [
  /\b(did not|didn't|never|wasn't|were not|haven't|has not)\s+(mention|state|specify|provide|share|tell|discuss|say)\b/i,
  /\b(not mentioned|no mention|not specified|not provided|not enough information|insufficient information|information provided is not enough|cannot verify|unable to verify|cannot find|could not find|don't have that information|do not have that information|no record|cannot answer from)\b/i,
  /\bnot in (?:the |my |our )?(?:memory|memories|history|sessions|context|conversation)\b/i,
  /언급하지|언급되지|기억 저장소에서.*찾을 수 없|확인할 수 없|단정하여 말씀드릴 수 없|답변을 보류|정보가 충분하지 않/,
];

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function printUsage() {
  const lines = [
    'Usage: node benchmarks/cogeval-locomo-harness/longmemeval_frontier_runner.mjs [options]',
    '',
    'Options:',
    '  --dataset <path>       Path to LongMemEval-S JSON (default: ./sample_longmemeval.json; supports 500-item longmemeval_s_cleaned.json)',
    '  --arm <mode>           Evaluation arm: ame-gateway | bare-frontier | both (default: both)',
    '  --provider <name>      LLM provider: mock | openai | anthropic | gemini | deepseek | openrouter | openai-compat (default: AME_LLM_PROVIDER or mock)',
    '  --model <name>         LLM model name (default: AME_LLM_MODEL or mock-eval-v1)',
    '  --api-key <key>        LLM API key (default: AME_LLM_API_KEY)',
    '  --base-url <url>       Upstream LLM base URL override (default: AME_LLM_BASE_URL)',
    '  --ame-base-url <url>   AME Gateway URL (default: AME_BASE_URL or http://127.0.0.1:8090)',
    '  --ame-api-key <key>    AME Gateway X-AME-API-Key (default: AME_API_KEY or dev-sandbox-key)',
    '  --ame-mode <a|b>       AME query execution mode: b (Zero-Key prepare/generate/settle, default) or a (Mode A /turn)',
    '  --ingest-mode <mode>   Haystack ingestion mode: settle (Mode B replay, default) or mode-a',
    '  --chunk-chars <n>      Optional max chars per ingested user chunk (default: 0 = unsplit turn)',
    '  --limit <n>            Evaluate at most <n> items from the dataset (up to full dataset size)',
    '  --offset <n>           Start offset into dataset (default: 0)',
    '  --temperature <num>    Sampling temperature override (default: AME_LLM_TEMPERATURE or unset)',
    '  --max-tokens <n>       Max output tokens override (default: AME_LLM_MAX_TOKENS or 256)',
    '  --json-out <path>      Write structured JSON report to <path>',
    '  --json-only            Print only the structured JSON report to stdout',
    '  -h, --help             Show this help message',
  ];
  console.log(lines.join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    datasetPath: null,
    arm: 'both',
    provider: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    ameBaseUrl: null,
    ameApiKey: null,
    ameMode: 'b',
    ingestMode: 'settle',
    chunkChars: 0,
    limit: null,
    offset: 0,
    temperature: undefined,
    maxTokens: undefined,
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
      case '--dataset':
        opts.datasetPath = readValue();
        break;
      case '--arm':
        opts.arm = readValue().toLowerCase();
        break;
      case '--provider':
        opts.provider = readValue();
        break;
      case '--model':
        opts.model = readValue();
        break;
      case '--api-key':
        opts.apiKey = readValue();
        break;
      case '--base-url':
        opts.baseUrl = readValue();
        break;
      case '--ame-base-url':
        opts.ameBaseUrl = readValue();
        break;
      case '--ame-api-key':
        opts.ameApiKey = readValue();
        break;
      case '--ame-mode':
        opts.ameMode = readValue().toLowerCase();
        break;
      case '--ingest-mode':
        opts.ingestMode = readValue().toLowerCase();
        break;
      case '--chunk-chars':
        opts.chunkChars = Number.parseInt(readValue(), 10);
        break;
      case '--limit':
        opts.limit = Number.parseInt(readValue(), 10);
        break;
      case '--offset':
        opts.offset = Number.parseInt(readValue(), 10);
        break;
      case '--temperature':
        opts.temperature = Number(readValue());
        break;
      case '--max-tokens':
        opts.maxTokens = Number.parseInt(readValue(), 10);
        break;
      case '--json-out':
        opts.jsonOut = readValue();
        break;
      default:
        throw new Error(`Unknown CLI argument: "${arg}". Run with --help for usage.`);
    }
  }

  if (!['ame-gateway', 'bare-frontier', 'both'].includes(opts.arm)) {
    throw new Error(`Invalid --arm "${opts.arm}". Expected ame-gateway | bare-frontier | both.`);
  }
  if (!['a', 'b'].includes(opts.ameMode)) {
    throw new Error(`Invalid --ame-mode "${opts.ameMode}". Expected a | b.`);
  }
  if (!['settle', 'mode-a'].includes(opts.ingestMode)) {
    throw new Error(`Invalid --ingest-mode "${opts.ingestMode}". Expected settle | mode-a.`);
  }
  if (!Number.isInteger(opts.offset) || opts.offset < 0) {
    throw new Error(`Invalid --offset "${opts.offset}". Expected non-negative integer.`);
  }
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new Error(`Invalid --limit "${opts.limit}". Expected positive integer.`);
  }
  if (!Number.isInteger(opts.chunkChars) || opts.chunkChars < 0) {
    throw new Error(`Invalid --chunk-chars "${opts.chunkChars}". Expected integer >= 0.`);
  }

  return opts;
}

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

export function estimatePrepTokens(prep) {
  let total = estimateTokens(prep?.systemPrompt || '');
  for (const msg of prep?.messages || []) {
    total += 4 + estimateTokens(msg?.content || '');
  }
  return total;
}

function extractUsagePromptTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.usage?.prompt_tokens === 'number') return raw.usage.prompt_tokens;
  if (typeof raw.usage?.input_tokens === 'number') return raw.usage.input_tokens;
  if (typeof raw.usageMetadata?.promptTokenCount === 'number') return raw.usageMetadata.promptTokenCount;
  return null;
}

function shortDateLabel(dateStr) {
  const raw = String(dateStr || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4}\/\d{2}\/\d{2}|\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : raw.slice(0, 16);
}

function extractGeneratedText(generated) {
  if (typeof generated === 'string') return generated;
  return generated?.text ?? generated?.rawReply ?? generated?.content ?? '';
}

function splitChunkText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!maxChars || clean.length <= maxChars) return [clean];
  const chunks = [];
  let cursor = 0;
  while (cursor < clean.length) {
    if (cursor + maxChars >= clean.length) {
      chunks.push(clean.slice(cursor).trim());
      break;
    }
    const slice = clean.slice(cursor, cursor + maxChars);
    const lastSpace = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf(' '));
    const cut = lastSpace > Math.floor(maxChars * 0.4) ? cursor + lastSpace + 1 : cursor + maxChars;
    chunks.push(clean.slice(cursor, cut).trim());
    cursor = cut;
  }
  return chunks.filter(Boolean);
}

export function isAbstentionItem(item) {
  return (
    String(item?.question_id || '').endsWith('_abs') ||
    item?.question_type === 'abstention' ||
    item?.is_abstention === true
  );
}

export function detectAbstentionReply(reply, hotAbstained = false) {
  if (hotAbstained) return true;
  const text = String(reply || '');
  return ABSTENTION_REPLY_PATTERNS.some((re) => re.test(text));
}

function normalizeAnswerText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}]/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeAnswer(text) {
  return normalizeAnswerText(text)
    .split(/\s+/)
    .map((t) => t.replace(/^[-/]+|[-/]+$/g, ''))
    .filter(Boolean);
}

function computeTokenF1(pred, gold) {
  const predTokens = tokenizeAnswer(pred);
  const goldTokens = tokenizeAnswer(gold);
  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;

  const goldCounts = new Map();
  for (const tok of goldTokens) {
    goldCounts.set(tok, (goldCounts.get(tok) || 0) + 1);
  }
  let overlap = 0;
  for (const tok of predTokens) {
    const rem = goldCounts.get(tok) || 0;
    if (rem > 0) {
      overlap += 1;
      goldCounts.set(tok, rem - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / predTokens.length;
  const recall = overlap / goldTokens.length;
  return round4((2 * precision * recall) / (precision + recall));
}

function allGoldClausesPresent(normPred, gold) {
  const parts = String(gold || '')
    .split(/\s+(?:and|&)\s+|,\s*/i)
    .map((p) => normalizeAnswerText(p))
    .filter((p) => p.length >= 2);
  if (parts.length < 2) return false;
  return parts.every((part) => normPred.includes(part));
}

export function scoreAnswer(item, reply, hotAbstained = false) {
  const abstentionExpected = isAbstentionItem(item);
  const abstained = detectAbstentionReply(reply, hotAbstained);
  const gold = String(item?.answer ?? '');
  const pred = String(reply ?? '');
  const normPred = normalizeAnswerText(pred);
  const normGold = normalizeAnswerText(gold);

  const exactMatch = !abstentionExpected && normGold.length > 0 && normPred === normGold;
  const containsMatch =
    !abstentionExpected &&
    normGold.length > 0 &&
    (normPred.includes(normGold) || allGoldClausesPresent(normPred, gold));
  const tokenF1 = computeTokenF1(pred, gold);

  const correct = abstentionExpected
    ? abstained
    : !abstained && (exactMatch || containsMatch || tokenF1 >= 0.5);

  return {
    abstentionExpected,
    abstained,
    exactMatch,
    containsMatch,
    tokenF1,
    correct,
  };
}

function computePercentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return round2(sortedValues[idx]);
}

function summarizeLatencies(values) {
  if (!values.length) {
    return { p50: 0, p95: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    p50: computePercentile(sorted, 50),
    p95: computePercentile(sorted, 95),
    mean: round2(mean),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
  };
}

function computeRawHaystackStats(item) {
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item.haystack_dates) ? item.haystack_dates : [];
  let turnCount = 0;
  let charCount = 0;
  let totalTokens = 0;
  let cumulativeStatelessPrefillTokens = 0;

  for (let i = 0; i < sessions.length; i += 1) {
    const sess = Array.isArray(sessions[i]) ? sessions[i] : [];
    const dateHeader = dates[i] ? `[${dates[i]}]\n` : '';
    charCount += dateHeader.length;
    totalTokens += estimateTokens(dateHeader);

    for (const turn of sess) {
      turnCount += 1;
      const line = `${turn?.role === 'assistant' ? 'Assistant' : 'User'}: ${String(turn?.content || '')}\n`;
      charCount += line.length;
      const turnTokens = estimateTokens(line);
      totalTokens += turnTokens;
      cumulativeStatelessPrefillTokens += totalTokens;
    }
  }

  return {
    sessionCount: sessions.length,
    turnCount,
    charCount,
    rawHaystackTokens: totalTokens,
    cumulativeStatelessPrefillTokens,
  };
}

export function buildBareFrontierPrep(item) {
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item.haystack_dates) ? item.haystack_dates : [];
  const sessionIds = Array.isArray(item.haystack_session_ids) ? item.haystack_session_ids : [];

  const blocks = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const dateLabel = dates[i] || `Session ${i + 1}`;
    const sessId = sessionIds[i] ? ` (${sessionIds[i]})` : '';
    const header = `### Session ${i + 1} [${dateLabel}]${sessId}`;
    const turnLines = (sessions[i] || []).map((t) => {
      const role = t?.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}: ${String(t?.content || '')}`;
    });
    blocks.push([header, ...turnLines].join('\n'));
  }

  const systemPrompt = [
    'You are a long-term memory QA assistant.',
    'Answer the user question concisely using ONLY the provided dated conversation sessions.',
    'Respect session timestamps and knowledge updates (use the latest valid state).',
    'If the requested information was never mentioned in the sessions, explicitly reply that the user did not mention this information.',
  ].join(' ');

  const userContent = [
    '[Conversation History]',
    blocks.join('\n\n'),
    '',
    item.question_date ? `[Question Date: ${item.question_date}]` : null,
    `Question: ${item.question}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    turnTicketId: `bare_${item.question_id}`,
    mindId: 'bare-frontier',
    domain: 'companion_chat',
    systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    samplingHints: { temperature: 0.0, maxTokens: 256 },
    hotAbstention: { shouldAbstain: false, reason: 'bare_stateless' },
    fepThoughtLock: { mode: 'automatic_low_fe', freeEnergy: 0.2, tau: 0.7, locked: false },
    safetyDirectives: [],
    domainOutputContract: { domain: 'companion_chat', fields: ['reply'] },
  };
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
        }
        walk(v);
      }
    }
  };
  walk(response);
}

function createD4ObservedClient(rawClient) {
  const audit = {
    apiCalls: 0,
    telemetryObjectsChecked: 0,
    unredactedCount: 0,
    forbiddenKeyLeakCount: 0,
  };
  const wrap = (res) => {
    audit.apiCalls += 1;
    collectD4AuditOnResponse(res, audit);
    return res;
  };
  return {
    baseUrl: rawClient.baseUrl,
    audit,
    health: async () => wrap(await rawClient.health()),
    createMind: async (body) => wrap(await rawClient.createMind(body)),
    getMind: async (mindId) => wrap(await rawClient.getMind(mindId)),
    turn: async (mindId, body) => wrap(await rawClient.turn(mindId, body)),
    prepare: async (mindId, body) => wrap(await rawClient.prepare(mindId, body)),
    settle: async (mindId, body) => wrap(await rawClient.settle(mindId, body)),
    getTelemetry: async (mindId) => wrap(await rawClient.getTelemetry(mindId)),
  };
}

export async function loadLongMemEvalDataset(datasetPath, { offset = 0, limit = null } = {}) {
  const resolved = path.resolve(datasetPath);
  const raw = await fs.readFile(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.questions)
        ? parsed.questions
        : Array.isArray(parsed?.data)
          ? parsed.data
          : null;

  if (!list) {
    throw new Error(`Invalid LongMemEval dataset format at ${resolved}: expected JSON array`);
  }

  const end = limit !== null ? Math.min(list.length, offset + limit) : list.length;
  const sliced = list.slice(offset, end);

  const normalized = sliced.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid dataset item at index ${offset + idx}`);
    }
    return {
      question_id: String(item.question_id ?? `item_${offset + idx}`),
      question_type: String(item.question_type ?? 'unknown'),
      question: String(item.question ?? ''),
      answer: String(item.answer ?? ''),
      question_date: item.question_date ? String(item.question_date) : '',
      haystack_sessions: Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [],
      haystack_dates: Array.isArray(item.haystack_dates) ? item.haystack_dates : [],
      haystack_session_ids: Array.isArray(item.haystack_session_ids) ? item.haystack_session_ids : [],
      answer_session_ids: Array.isArray(item.answer_session_ids) ? item.answer_session_ids : [],
      is_abstention: item.is_abstention === true,
    };
  });

  const isSyntheticSmoke =
    path.basename(resolved) === 'sample_longmemeval.json' ||
    (normalized.length > 0 && normalized.every((x) => x.question_id.startsWith('smoke_synth_')));

  return {
    datasetPath: resolved,
    totalInFile: list.length,
    evaluatedCount: normalized.length,
    datasetKind: isSyntheticSmoke ? 'synthetic_offline_smoke' : 'external_longmemeval',
    items: normalized,
  };
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

function aggregateArmMetrics(itemResults, extra = {}) {
  const totalItems = itemResults.length;
  const correctCount = itemResults.filter((r) => r.correct).length;
  const exactCount = itemResults.filter((r) => r.exactMatch).length;
  const containsCount = itemResults.filter((r) => r.containsMatch).length;
  const meanTokenF1 =
    totalItems > 0
      ? round4(itemResults.reduce((s, r) => s + r.tokenF1, 0) / totalItems)
      : 0;

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of itemResults) {
    if (r.abstentionExpected && r.abstained) tp += 1;
    else if (!r.abstentionExpected && r.abstained) fp += 1;
    else if (!r.abstentionExpected && !r.abstained) tn += 1;
    else if (r.abstentionExpected && !r.abstained) fn += 1;
  }

  const abstentionTotal = tp + fp + tn + fn;
  const abstentionAccuracy = abstentionTotal > 0 ? round4((tp + tn) / abstentionTotal) : 0;
  const abstentionFAR = tn + fp > 0 ? round4(fp / (tn + fp)) : 0;
  const abstentionPrecision = tp + fp > 0 ? round4(tp / (tp + fp)) : fn === 0 ? 1 : 0;
  const abstentionRecall = tp + fn > 0 ? round4(tp / (tp + fn)) : 1;
  const abstentionF1 =
    abstentionPrecision + abstentionRecall > 0
      ? round4((2 * abstentionPrecision * abstentionRecall) / (abstentionPrecision + abstentionRecall))
      : 0;

  const nonAbsItems = itemResults.filter((r) => !r.abstentionExpected);
  const nonAbstentionAccuracyPct =
    nonAbsItems.length > 0
      ? round2((nonAbsItems.filter((r) => r.correct).length / nonAbsItems.length) * 100)
      : 0;

  const queryPromptTokensList = itemResults
    .map((r) => r.queryPromptTokens)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const totalQueryPromptTokens =
    queryPromptTokensList.length > 0
      ? queryPromptTokensList.reduce((s, v) => s + v, 0)
      : null;
  const meanQueryPromptTokens =
    queryPromptTokensList.length > 0
      ? round2(totalQueryPromptTokens / queryPromptTokensList.length)
      : null;
  const minQueryPromptTokens =
    queryPromptTokensList.length > 0 ? Math.min(...queryPromptTokensList) : null;
  const maxQueryPromptTokens =
    queryPromptTokensList.length > 0 ? Math.max(...queryPromptTokensList) : null;

  const rawTokensList = itemResults.map((r) => r.rawHaystackTokens);
  const totalRawHaystackTokens = rawTokensList.reduce((s, v) => s + v, 0);
  const meanRawHaystackTokens = totalItems > 0 ? round2(totalRawHaystackTokens / totalItems) : 0;
  const totalCumulativeStatelessPrefillTokens = itemResults.reduce(
    (s, r) => s + r.cumulativeStatelessPrefillTokens,
    0
  );

  // Scaling check: compare shorter-half vs longer-half haystacks
  const byHaystack = [...itemResults].sort((a, b) => a.rawHaystackTokens - b.rawHaystackTokens);
  let scaling = {
    shortHalfCount: 0,
    longHalfCount: 0,
    meanRawHaystackTokensShort: 0,
    meanRawHaystackTokensLong: 0,
    rawHaystackGrowthRatio: 1,
    meanQueryPromptTokensShort: null,
    meanQueryPromptTokensLong: null,
    queryPromptGrowthRatio: null,
  };
  if (byHaystack.length >= 2) {
    const mid = Math.floor(byHaystack.length / 2);
    const shortHalf = byHaystack.slice(0, mid);
    const longHalf = byHaystack.slice(mid);
    const avg = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0) / arr.length;
    const rawShort = avg(shortHalf, (x) => x.rawHaystackTokens);
    const rawLong = avg(longHalf, (x) => x.rawHaystackTokens);

    const shortTokens = shortHalf.map((x) => x.queryPromptTokens).filter((v) => typeof v === 'number');
    const longTokens = longHalf.map((x) => x.queryPromptTokens).filter((v) => typeof v === 'number');
    const promptShort =
      shortTokens.length > 0 ? shortTokens.reduce((s, v) => s + v, 0) / shortTokens.length : null;
    const promptLong =
      longTokens.length > 0 ? longTokens.reduce((s, v) => s + v, 0) / longTokens.length : null;

    scaling = {
      shortHalfCount: shortHalf.length,
      longHalfCount: longHalf.length,
      meanRawHaystackTokensShort: round2(rawShort),
      meanRawHaystackTokensLong: round2(rawLong),
      rawHaystackGrowthRatio: rawShort > 0 ? round4(rawLong / rawShort) : 1,
      meanQueryPromptTokensShort: promptShort !== null ? round2(promptShort) : null,
      meanQueryPromptTokensLong: promptLong !== null ? round2(promptLong) : null,
      queryPromptGrowthRatio:
        promptShort !== null && promptShort > 0 && promptLong !== null
          ? round4(promptLong / promptShort)
          : null,
    };
  }

  const byQuestionType = {};
  for (const r of itemResults) {
    const qt = r.questionType || 'unknown';
    if (!byQuestionType[qt]) {
      byQuestionType[qt] = {
        total: 0,
        correct: 0,
        exactMatch: 0,
        containsMatch: 0,
        tokenF1Sum: 0,
      };
    }
    const bucket = byQuestionType[qt];
    bucket.total += 1;
    if (r.correct) bucket.correct += 1;
    if (r.exactMatch) bucket.exactMatch += 1;
    if (r.containsMatch) bucket.containsMatch += 1;
    bucket.tokenF1Sum += r.tokenF1;
  }

  const questionTypeMetrics = {};
  for (const [qt, b] of Object.entries(byQuestionType)) {
    questionTypeMetrics[qt] = {
      total: b.total,
      correct: b.correct,
      accuracyPct: round2((b.correct / b.total) * 100),
      exactMatchPct: round2((b.exactMatch / b.total) * 100),
      containsMatchPct: round2((b.containsMatch / b.total) * 100),
      meanTokenF1: round4(b.tokenF1Sum / b.total),
    };
  }

  const latencies = itemResults.map((r) => r.queryLatencyMs);

  return {
    totalItems,
    correctCount,
    accuracyPct: totalItems > 0 ? round2((correctCount / totalItems) * 100) : 0,
    nonAbstentionAccuracyPct,
    exactMatchPct: totalItems > 0 ? round2((exactCount / totalItems) * 100) : 0,
    containsMatchPct: totalItems > 0 ? round2((containsCount / totalItems) * 100) : 0,
    meanTokenF1,
    abstention: {
      accuracy: abstentionAccuracy,
      far: abstentionFAR,
      precision: abstentionPrecision,
      recall: abstentionRecall,
      f1: abstentionF1,
      tp,
      fp,
      tn,
      fn,
    },
    abstentionAccuracy,
    abstentionFAR,
    totalRawHaystackTokens,
    meanRawHaystackTokens,
    totalCumulativeStatelessPrefillTokens,
    totalQueryPromptTokens,
    meanQueryPromptTokens,
    minQueryPromptTokens,
    maxQueryPromptTokens,
    scaling,
    latencyMs: summarizeLatencies(latencies),
    byQuestionType: questionTypeMetrics,
    ...extra,
  };
}

async function ingestSessionTurns({
  client,
  mindId,
  item,
  ingestMode,
  chunkChars,
  llmConfig,
}) {
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item.haystack_dates) ? item.haystack_dates : [];
  const followUpCachedRatios = [];
  const prefixHashes = new Set();
  const epochs = new Set();
  let ingestedTurns = 0;

  const submitTurnPair = async (userText, assistantText, meta) => {
    let result;
    if (ingestMode === 'mode-a') {
      result = await client.turn(mindId, {
        userInput: userText,
        llm: buildModeALlmPayload(llmConfig),
        metadata: meta,
      });
    } else {
      const prep = await client.prepare(mindId, {
        userInput: userText,
        metadata: meta,
      });
      result = await client.settle(mindId, {
        turnTicketId: prep.turnTicketId,
        rawReply: assistantText,
        providerUsed: 'dataset-replay',
        modelUsed: 'historical-session',
      });
    }

    ingestedTurns += 1;
    if (result?.kvCache?.systemPrefixHash) prefixHashes.add(result.kvCache.systemPrefixHash);
    if (typeof result?.kvCache?.epoch === 'number') epochs.add(result.kvCache.epoch);
    if (result?.turnIndex > 1 && typeof result?.kvCache?.cachedRatioPct === 'number') {
      followUpCachedRatios.push(result.kvCache.cachedRatioPct);
    }
    return result;
  };

  for (let sIdx = 0; sIdx < sessions.length; sIdx += 1) {
    const sess = Array.isArray(sessions[sIdx]) ? sessions[sIdx] : [];
    const shortDate = shortDateLabel(dates[sIdx]);
    const datePrefix = shortDate ? `[${shortDate}] ` : '';

    for (let tIdx = 0; tIdx < sess.length; tIdx += 1) {
      const turn = sess[tIdx];
      const role = turn?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(turn?.content || '').trim();
      if (!content) continue;

      if (role === 'user') {
        const nextTurn = sess[tIdx + 1];
        const hasPairedAssistant = nextTurn && nextTurn.role === 'assistant';
        const assistantContent = hasPairedAssistant
          ? String(nextTurn.content || '').trim() || 'Acknowledged.'
          : 'Acknowledged.';
        if (hasPairedAssistant) {
          tIdx += 1;
        }

        const chunks = splitChunkText(content, chunkChars);
        for (let cIdx = 0; cIdx < chunks.length; cIdx += 1) {
          const isLastChunk = cIdx === chunks.length - 1;
          await submitTurnPair(
            `${datePrefix}${chunks[cIdx]}`,
            isLastChunk ? assistantContent : 'Acknowledged.',
            {
              phase: 'haystack_ingest',
              questionId: item.question_id,
              sessionIndex: sIdx,
              sessionDate: dates[sIdx] || null,
              turnIndex: tIdx,
              chunkIndex: cIdx,
            }
          );
        }
      } else {
        await submitTurnPair(`${datePrefix}[Assistant context] ${content}`, 'Acknowledged.', {
          phase: 'haystack_ingest_assistant',
          questionId: item.question_id,
          sessionIndex: sIdx,
          sessionDate: dates[sIdx] || null,
          turnIndex: tIdx,
        });
      }
    }
  }

  return {
    ingestedTurns,
    followUpCachedRatios,
    prefixHashes,
    epochs,
  };
}

async function runAmeGatewayArm({
  items,
  ameBaseUrl,
  ameApiKey,
  ameMode,
  ingestMode,
  chunkChars,
  adapter,
  llmConfig,
}) {
  const rawClient = new AmeClient({ baseUrl: ameBaseUrl, apiKey: ameApiKey });
  const client = createD4ObservedClient(rawClient);
  const health = await client.health();

  const itemResults = [];
  const allFollowUpCachedRatios = [];
  let prefixInvariantMinds = 0;

  for (const item of items) {
    const haystackStats = computeRawHaystackStats(item);
    const mind = await client.createMind({
      domain: 'companion_chat',
      persona: {
        name: 'MemoryAssistant',
        role: 'Long-term memory assistant',
        traits: { accuracy: 0.95, honesty: 0.95 },
        backstory:
          'Recalls grounded facts across dated multi-session timelines and abstains when information was not provided.',
        language: 'en',
      },
      safetyPolicy: {
        strictAbstention: true,
        antiSycophancy: true,
        crisisEscalation: false,
      },
    });

    const ingestStats = await ingestSessionTurns({
      client,
      mindId: mind.mindId,
      item,
      ingestMode,
      chunkChars,
      llmConfig,
    });

    const qDate = shortDateLabel(item.question_date);
    const queryInput = qDate ? `[${qDate}] ${item.question}` : item.question;
    const t0 = performance.now();

    let prep = null;
    let queryResult = null;
    let queryPromptTokens = null;
    let reportedPromptTokens = null;
    let queryMessagesCount = null;

    if (ameMode === 'a') {
      queryResult = await client.turn(mind.mindId, {
        userInput: queryInput,
        llm: buildModeALlmPayload(llmConfig),
        metadata: {
          phase: 'longmemeval_query',
          questionId: item.question_id,
          questionType: item.question_type,
        },
      });
    } else {
      prep = await client.prepare(mind.mindId, {
        userInput: queryInput,
        metadata: {
          phase: 'longmemeval_query',
          questionId: item.question_id,
          questionType: item.question_type,
        },
      });
      queryPromptTokens = estimatePrepTokens(prep);
      queryMessagesCount = Array.isArray(prep.messages) ? prep.messages.length : 0;

      const generated = await adapter.generate(prep);
      reportedPromptTokens = extractUsagePromptTokens(generated?.raw);
      queryResult = await client.settle(mind.mindId, {
        turnTicketId: prep.turnTicketId,
        rawReply: extractGeneratedText(generated),
        providerUsed: generated?.providerUsed || llmConfig.provider,
        modelUsed: generated?.modelUsed || llmConfig.model,
      });
    }

    const queryLatencyMs = round2(performance.now() - t0);
    const mindSnap = await client.getMind(mind.mindId);

    const hashes = new Set(ingestStats.prefixHashes);
    const epochs = new Set(ingestStats.epochs);
    if (queryResult?.kvCache?.systemPrefixHash) hashes.add(queryResult.kvCache.systemPrefixHash);
    if (typeof queryResult?.kvCache?.epoch === 'number') epochs.add(queryResult.kvCache.epoch);
    if (hashes.size === 1 && epochs.size === 1) {
      prefixInvariantMinds += 1;
    }

    const queryCachedRatioPct = queryResult?.kvCache?.cachedRatioPct ?? 0;
    const itemCachedRatios = [...ingestStats.followUpCachedRatios];
    if (queryResult?.turnIndex > 1 && typeof queryCachedRatioPct === 'number') {
      itemCachedRatios.push(queryCachedRatioPct);
    }
    allFollowUpCachedRatios.push(...itemCachedRatios);

    const hotAbstained = Boolean(
      prep?.hotAbstention?.shouldAbstain || queryResult?.telemetry?.hotAbstained
    );
    const scored = scoreAnswer(item, queryResult?.reply || '', hotAbstained);

    itemResults.push({
      questionId: item.question_id,
      questionType: item.question_type,
      mindId: mind.mindId,
      sessionCount: haystackStats.sessionCount,
      turnCount: haystackStats.turnCount,
      ingestedTurns: ingestStats.ingestedTurns,
      rawHaystackTokens: haystackStats.rawHaystackTokens,
      cumulativeStatelessPrefillTokens: haystackStats.cumulativeStatelessPrefillTokens,
      queryPromptTokens,
      reportedPromptTokens,
      queryMessagesCount,
      windowStart: queryResult?.kvCache?.windowStart ?? prep?.windowStart ?? null,
      compressCutoff: queryResult?.kvCache?.compressCutoff ?? prep?.compressCutoff ?? null,
      kvCacheEpoch: queryResult?.kvCache?.epoch ?? null,
      cachedRatioPct: queryCachedRatioPct,
      d4Redacted: queryResult?.telemetry?.d4Redacted === true && mindSnap?.telemetry?.d4Redacted === true,
      queryLatencyMs,
      reply: queryResult?.reply || '',
      expectedAnswer: item.answer,
      ...scored,
    });
  }

  const meanCachedRatioPct =
    allFollowUpCachedRatios.length > 0
      ? round2(
          allFollowUpCachedRatios.reduce((s, v) => s + v, 0) / allFollowUpCachedRatios.length
        )
      : 0;
  const queryMeanCachedRatioPct =
    itemResults.length > 0
      ? round2(itemResults.reduce((s, r) => s + (r.cachedRatioPct || 0), 0) / itemResults.length)
      : 0;

  const d4RedactedAll =
    client.audit.telemetryObjectsChecked > 0 &&
    client.audit.unredactedCount === 0 &&
    client.audit.forbiddenKeyLeakCount === 0;

  const metrics = aggregateArmMetrics(itemResults, {
    ameMode,
    ingestMode,
    meanCachedRatioPct,
    queryMeanCachedRatioPct,
    prefixInvariantMinds,
    prefixInvariantRatePct:
      itemResults.length > 0 ? round2((prefixInvariantMinds / itemResults.length) * 100) : 0,
    d4TelemetryObjectsChecked: client.audit.telemetryObjectsChecked,
    d4UnredactedCount: client.audit.unredactedCount,
    d4ForbiddenKeyLeakCount: client.audit.forbiddenKeyLeakCount,
    d4RedactedAll,
    totalAmeApiCalls: client.audit.apiCalls,
  });

  return {
    arm: 'ame-gateway',
    health,
    metrics,
    items: itemResults,
  };
}

async function runBareFrontierArm({ items, adapter, llmConfig }) {
  const itemResults = [];

  for (const item of items) {
    const haystackStats = computeRawHaystackStats(item);
    const barePrep = buildBareFrontierPrep(item);
    const queryPromptTokens = estimatePrepTokens(barePrep);

    const t0 = performance.now();
    const generated = await adapter.generate(barePrep);
    const queryLatencyMs = round2(performance.now() - t0);

    const reply = extractGeneratedText(generated);
    const reportedPromptTokens = extractUsagePromptTokens(generated?.raw);
    const scored = scoreAnswer(item, reply, false);

    itemResults.push({
      questionId: item.question_id,
      questionType: item.question_type,
      sessionCount: haystackStats.sessionCount,
      turnCount: haystackStats.turnCount,
      rawHaystackTokens: haystackStats.rawHaystackTokens,
      cumulativeStatelessPrefillTokens: haystackStats.cumulativeStatelessPrefillTokens,
      queryPromptTokens,
      reportedPromptTokens,
      providerUsed: generated?.providerUsed || llmConfig.provider,
      modelUsed: generated?.modelUsed || llmConfig.model,
      queryLatencyMs,
      reply,
      expectedAnswer: item.answer,
      ...scored,
    });
  }

  const metrics = aggregateArmMetrics(itemResults, {
    provider: llmConfig.provider,
    model: llmConfig.model,
  });

  return {
    arm: 'bare-frontier',
    metrics,
    items: itemResults,
  };
}

function computePairedDelta(ameArm, bareArm) {
  const a = ameArm.metrics;
  const b = bareArm.metrics;

  const hasTokenCounts =
    typeof a.totalQueryPromptTokens === 'number' &&
    typeof b.totalQueryPromptTokens === 'number' &&
    b.totalQueryPromptTokens > 0;

  const tokenReductionRatio = hasTokenCounts
    ? round4((b.totalQueryPromptTokens - a.totalQueryPromptTokens) / b.totalQueryPromptTokens)
    : null;
  const tokenReductionPct =
    tokenReductionRatio !== null ? round2(tokenReductionRatio * 100) : null;
  const tokenCompressionFactor =
    hasTokenCounts && a.totalQueryPromptTokens > 0
      ? round2(b.totalQueryPromptTokens / a.totalQueryPromptTokens)
      : null;

  const amePromptBounded =
    typeof a.maxQueryPromptTokens === 'number' &&
    typeof b.maxQueryPromptTokens === 'number' &&
    a.maxQueryPromptTokens < b.maxQueryPromptTokens &&
    (a.scaling?.queryPromptGrowthRatio ?? 1) <=
      Math.max(1.25, (b.scaling?.queryPromptGrowthRatio ?? 1) * 0.85);

  return {
    accuracyDeltaPct: round2(a.accuracyPct - b.accuracyPct),
    nonAbstentionAccuracyDeltaPct: round2(a.nonAbstentionAccuracyPct - b.nonAbstentionAccuracyPct),
    exactMatchDeltaPct: round2(a.exactMatchPct - b.exactMatchPct),
    containsMatchDeltaPct: round2(a.containsMatchPct - b.containsMatchPct),
    tokenF1Delta: round4(a.meanTokenF1 - b.meanTokenF1),
    abstentionAccuracyDeltaPct: round2((a.abstentionAccuracy - b.abstentionAccuracy) * 100),
    abstentionFARDeltaPct: round2((a.abstentionFAR - b.abstentionFAR) * 100),
    tokenReductionRatio,
    tokenReductionPct,
    tokenCompressionFactor,
    tokensSavedMeanPerQuery:
      typeof a.meanQueryPromptTokens === 'number' && typeof b.meanQueryPromptTokens === 'number'
        ? round2(b.meanQueryPromptTokens - a.meanQueryPromptTokens)
        : null,
    amePromptGrowthRatio: a.scaling?.queryPromptGrowthRatio ?? null,
    barePromptGrowthRatio: b.scaling?.queryPromptGrowthRatio ?? null,
    amePromptBounded,
    latencyP50DeltaMs: round2(a.latencyMs.p50 - b.latencyMs.p50),
    latencyP95DeltaMs: round2(a.latencyMs.p95 - b.latencyMs.p95),
    d4RedactedAll: Boolean(a.d4RedactedAll),
  };
}

function formatHumanSummary(report) {
  const line = '='.repeat(82);
  const sub = '-'.repeat(82);
  const rows = [
    line,
    ' AME LongMemEval-S + Bare Frontier Paired Comparator',
    sub,
    ` Dataset : ${path.basename(report.dataset.datasetPath)} (${report.dataset.evaluatedCount}/${report.dataset.totalInFile} items | kind=${report.dataset.datasetKind})`,
    ` Arm     : ${report.config.arm} | Provider: ${report.config.provider} / ${report.config.model}`,
    ` Gateway : ${report.config.ameBaseUrl} | GatewayMode: ${report.ameGateway?.health?.mode || 'n/a'} | AME Mode: ${report.config.ameMode}`,
    line,
  ];

  const renderArm = (label, m) => {
    rows.push(` [${label}]`);
    rows.push(
      `   Accuracy      : ${m.accuracyPct.toFixed(2)}% (${m.correctCount}/${m.totalItems}) | Exact=${m.exactMatchPct.toFixed(2)}% | Contains=${m.containsMatchPct.toFixed(2)}% | F1=${m.meanTokenF1.toFixed(4)}`
    );
    rows.push(
      `   Abstention    : Acc=${(m.abstentionAccuracy * 100).toFixed(2)}% | FAR=${(m.abstentionFAR * 100).toFixed(2)}% | TP=${m.abstention.tp} FP=${m.abstention.fp} TN=${m.abstention.tn} FN=${m.abstention.fn}`
    );
    rows.push(
      `   Prompt Tokens : mean=${m.meanQueryPromptTokens ?? 'n/a (Mode A)'} | max=${m.maxQueryPromptTokens ?? 'n/a'} | growth(short->long)=${m.scaling?.queryPromptGrowthRatio ?? 'n/a'}x (raw=${m.scaling?.rawHaystackGrowthRatio ?? 'n/a'}x)`
    );
    rows.push(
      `   Latency (ms)  : p50=${m.latencyMs.p50} | p95=${m.latencyMs.p95} | mean=${m.latencyMs.mean}`
    );
    if (label === 'ame-gateway') {
      rows.push(
        `   AME Governance: KV cached=${m.meanCachedRatioPct}% (query=${m.queryMeanCachedRatioPct}%) | prefixInvariant=${m.prefixInvariantMinds}/${m.totalItems} | d4RedactedAll=${m.d4RedactedAll} (checked=${m.d4TelemetryObjectsChecked}, leaks=${m.d4ForbiddenKeyLeakCount})`
      );
    }
  };

  if (report.ameGateway) renderArm('ame-gateway', report.ameGateway.metrics);
  if (report.bareFrontier) renderArm('bare-frontier', report.bareFrontier.metrics);

  if (report.pairedDelta) {
    const d = report.pairedDelta;
    rows.push(sub);
    rows.push(' [paired-delta: ame-gateway vs bare-frontier]');
    rows.push(
      `   Accuracy Delta: ${d.accuracyDeltaPct >= 0 ? '+' : ''}${d.accuracyDeltaPct}%p | F1 Delta: ${d.tokenF1Delta >= 0 ? '+' : ''}${d.tokenF1Delta}`
    );
    rows.push(
      `   Token Savings : reductionRatio=${d.tokenReductionRatio ?? 'n/a'} (${d.tokenReductionPct ?? 'n/a'}%) | compression=${d.tokenCompressionFactor ?? 'n/a'}x | O(1) bounded=${d.amePromptBounded}`
    );
    rows.push(
      `   Latency Delta : p50=${d.latencyP50DeltaMs >= 0 ? '+' : ''}${d.latencyP50DeltaMs} ms | d4RedactedAll=${d.d4RedactedAll}`
    );
  }

  rows.push(line);
  rows.push(` Duration : ${report.durationMs} ms`);
  rows.push(line);
  return rows.join('\n');
}

/**
 * Programmatic entry point for LongMemEval-S paired comparison.
 */
export async function runLongMemEvalComparison(options = {}) {
  const startedAt = Date.now();
  const datasetPath = options.datasetPath
    ? path.resolve(options.datasetPath)
    : fileURLToPath(DEFAULT_DATASET_URL);
  const arm = (options.arm || 'both').toLowerCase();
  const ameMode = (options.ameMode || 'b').toLowerCase();
  const ingestMode = (options.ingestMode || 'settle').toLowerCase();
  const chunkChars = Number.isInteger(options.chunkChars) ? options.chunkChars : 0;
  const offset = Number.isInteger(options.offset) ? options.offset : 0;
  const limit = options.limit ?? null;

  const ameBaseUrl = options.ameBaseUrl || process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
  const ameApiKey = options.ameApiKey || process.env.AME_API_KEY || 'dev-sandbox-key';
  const provider = options.provider || process.env.AME_LLM_PROVIDER || 'mock';
  const model = options.model || process.env.AME_LLM_MODEL || 'mock-eval-v1';
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.AME_LLM_API_KEY;
  const baseUrl = options.baseUrl !== undefined ? options.baseUrl : process.env.AME_LLM_BASE_URL;
  const temperature =
    options.temperature !== undefined
      ? options.temperature
      : process.env.AME_LLM_TEMPERATURE !== undefined
        ? Number(process.env.AME_LLM_TEMPERATURE)
        : undefined;
  const maxTokens =
    options.maxTokens !== undefined
      ? options.maxTokens
      : process.env.AME_LLM_MAX_TOKENS !== undefined
        ? Number.parseInt(process.env.AME_LLM_MAX_TOKENS, 10)
        : 256;

  const llmConfig = {
    provider,
    model,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 256,
  };

  const adapter = createLlmAdapter(llmConfig);
  const dataset = await loadLongMemEvalDataset(datasetPath, { offset, limit });

  let ameGateway = null;
  let bareFrontier = null;

  if (arm === 'ame-gateway' || arm === 'both') {
    ameGateway = await runAmeGatewayArm({
      items: dataset.items,
      ameBaseUrl,
      ameApiKey,
      ameMode,
      ingestMode,
      chunkChars,
      adapter,
      llmConfig,
    });
  }

  if (arm === 'bare-frontier' || arm === 'both') {
    bareFrontier = await runBareFrontierArm({
      items: dataset.items,
      adapter,
      llmConfig,
    });
  }

  const pairedDelta = ameGateway && bareFrontier ? computePairedDelta(ameGateway, bareFrontier) : null;
  const durationMs = Date.now() - startedAt;

  return {
    benchmark: 'AME LongMemEval-S + Bare Frontier Paired Comparator',
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      arm,
      ameBaseUrl,
      ameMode,
      ingestMode,
      chunkChars,
      provider,
      model,
      llmBaseUrl: baseUrl || null,
      offset,
      limit,
    },
    dataset: {
      datasetPath: dataset.datasetPath,
      datasetKind: dataset.datasetKind,
      totalInFile: dataset.totalInFile,
      evaluatedCount: dataset.evaluatedCount,
    },
    ameGateway,
    bareFrontier,
    pairedDelta,
    durationMs,
  };
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[lme-frontier-runner] ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  const report = await runLongMemEvalComparison({
    datasetPath: cli.datasetPath,
    arm: cli.arm,
    provider: cli.provider,
    model: cli.model,
    apiKey: cli.apiKey,
    baseUrl: cli.baseUrl,
    ameBaseUrl: cli.ameBaseUrl,
    ameApiKey: cli.ameApiKey,
    ameMode: cli.ameMode,
    ingestMode: cli.ingestMode,
    chunkChars: cli.chunkChars,
    limit: cli.limit,
    offset: cli.offset,
    temperature: cli.temperature,
    maxTokens: cli.maxTokens,
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
    console.log(formatHumanSummary(report));
    console.log('\nStructured JSON Summary Report:\n');
    console.log(jsonOutput);
  }

  const ameD4Ok = report.ameGateway ? report.ameGateway.metrics.d4RedactedAll === true : true;
  process.exit(ameD4Ok ? 0 : 1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`[lme-frontier-runner] Unhandled error: ${err?.stack || err}`);
    process.exit(1);
  });
}
