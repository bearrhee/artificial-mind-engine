#!/usr/bin/env node
/**
 * Black-Box LoCoMo + Bare Frontier Paired Comparator for Artificial Mind Engine (AME).
 *
 * Evaluates up to the full 10-conversation LoCoMo benchmark (`locomo10.json`, n=1,986),
 * the `Confirm-304` 2-conversation slice (`--conversations conv-26,conv-30`, n=304),
 * or the bundled 2-conversation synthetic offline smoke fixture (`sample_locomo.json`)
 * across two paired arms:
 *   1. `ame-gateway`: Isolated Mind per conversation via @ame/sdk (OpenAPI 3.1), sequential
 *      session/turn ingestion, bounded O(1) Mode A/B query, KV cache telemetry, and D4 audit.
 *   2. `bare-frontier`: Stateless full-context baseline packing all dated sessions into a
 *      flattened prompt via `createLlmAdapter` (O(T) query / O(T^2) replay cost).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AmeClient,
  createLlmAdapter,
} from '../../packages/sdk-ts/src/index.mjs';

const DEFAULT_DATASET_URL = new URL('./sample_locomo.json', import.meta.url);

export const LOCOMO_CATEGORY_LABELS = Object.freeze({
  1: 'Multi-Hop',
  2: 'Temporal',
  3: 'Open-Domain',
  4: 'Single-Hop',
  5: 'Adversarial',
});

export const PUBLISHED_LOCOMO_REFERENCES = Object.freeze([
  {
    system: 'OpenAI Memory',
    overallAccuracyPct: 52.9,
    sourceTier: 'published_literature_baseline',
    scope: 'Published external memory baseline (LoCoMo)',
    isLiveMeasured: false,
  },
  {
    system: 'LangMem',
    overallAccuracyPct: 58.1,
    sourceTier: 'published_literature_baseline',
    scope: 'Published external memory baseline (LoCoMo)',
    isLiveMeasured: false,
  },
  {
    system: 'Mem0 / Mem0^g',
    overallAccuracyPct: 68.4,
    sourceTier: 'published_literature_baseline',
    scope: 'Published external memory baseline (LoCoMo)',
    isLiveMeasured: false,
  },
  {
    system: 'Letta (MemGPT)',
    overallAccuracyPct: 74.0,
    sourceTier: 'published_literature_baseline',
    scope: 'Published external memory baseline (LoCoMo)',
    isLiveMeasured: false,
  },
  {
    system: 'Zep / Graphiti',
    overallAccuracyPct: 75.1,
    sourceTier: 'published_literature_baseline',
    scope: 'Published external memory baseline (LoCoMo)',
    isLiveMeasured: false,
  },
  {
    system: 'AME (Gemma 4 26B standalone)',
    overallAccuracyPct: 75.66,
    sourceTier: 'ame_tier1_reference',
    scope: 'Confirm-304 (conv-26+30, n=304, 0% escalation)',
    isLiveMeasured: false,
  },
  {
    system: 'AME (DeepSeek v4.1 Flash)',
    overallAccuracyPct: 85.86,
    sourceTier: 'ame_tier1_reference',
    scope: 'Confirm-304 (conv-26+30, n=304; 77.24% Full 10-conv n=1,986)',
    isLiveMeasured: false,
  },
  {
    system: 'Bare Oracle',
    overallAccuracyPct: 87.17,
    sourceTier: 'oracle_reference',
    scope: 'Confirm-304 full-transcript ceiling (n=304)',
    isLiveMeasured: false,
  },
]);

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

const ABSTENTION_REPLY_PATTERNS = [
  /\b(did not|didn't|does not|doesn't|never|wasn't|were not|haven't|has not)\s+(mention|state|specify|provide|share|tell|discuss|say|adopt|buy|own)\b/i,
  /\b(not mentioned|never mentioned|no mention|not specified|not provided|not discussed|never discussed|not stated|not enough information|insufficient information|information provided is not enough|cannot verify|unable to verify|cannot find|could not find|cannot answer|cannot determine|don't have that information|do not have that information|no record|no information|no evidence|cannot answer from|unanswerable)\b/i,
  /\bnot in (?:the |my |our )?(?:memory|memories|history|sessions|context|conversation|dialogue|transcript)\b/i,
  /언급하지|언급되지|기억 저장소에서.*찾을 수 없|확인할 수 없|단정하여 말씀드릴 수 없|답변을 보류|정보가 충분하지 않/,
  /\b(?:that|this)\s+(?:detail|information|fact|record|answer)\s+is\s+(?:unknown|unavailable|unverified|not\s+known)\b/i,
  /\b(?:cannot|can't|unable\s+to)\s+(?:confirm|diagnose|predict)\b/i,
  /^\s*(?:that\s+detail\s+is\s+unknown|unknown|i\s+don'?t\s+know|i\s+do\s+not\s+know)\.?\s*$/i,
];

const MONTHS_BY_NAME = {
  january: '01',
  jan: '01',
  february: '02',
  feb: '02',
  march: '03',
  mar: '03',
  april: '04',
  apr: '04',
  may: '05',
  june: '06',
  jun: '06',
  july: '07',
  jul: '07',
  august: '08',
  aug: '08',
  september: '09',
  sep: '09',
  sept: '09',
  october: '10',
  oct: '10',
  november: '11',
  nov: '11',
  december: '12',
  dec: '12',
};

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function printUsage() {
  const lines = [
    'Usage: node benchmarks/cogeval-locomo-harness/locomo_frontier_runner.mjs [options]',
    '',
    'Options:',
    '  --dataset <path>         Path to LoCoMo JSON (default: ./sample_locomo.json; supports locomo10.json)',
    '  --conversations <csv>    Comma-separated sample_id filter (e.g. conv-26,conv-30 for Confirm-304)',
    '  --arm <mode>             Evaluation arm: ame-gateway | bare-frontier | both (default: both)',
    '  --provider <name>        LLM provider: mock | openai | anthropic | gemini | deepseek | openrouter | openai-compat (default: AME_LLM_PROVIDER or mock)',
    '  --model <name>           LLM model name (default: AME_LLM_MODEL or mock-eval-v1)',
    '  --api-key <key>          LLM API key (default: AME_LLM_API_KEY)',
    '  --base-url <url>         Upstream LLM base URL override (default: AME_LLM_BASE_URL)',
    '  --ame-base-url <url>     AME Gateway URL (default: AME_BASE_URL or http://127.0.0.1:8090)',
    '  --ame-api-key <key>      AME Gateway X-AME-API-Key (default: AME_API_KEY or dev-sandbox-key)',
    '  --ame-mode <a|b>         AME query execution mode: b (Zero-Key prepare/generate, default) or a (Mode A /turn)',
    '  --ingest-mode <mode>     Conversation ingestion mode: settle (Mode B replay, default) or mode-a',
    '  --judge-provider <name>  Optional LLM-as-Judge provider (e.g. openai, mock, openai-compat)',
    '  --judge-model <name>     Optional LLM-as-Judge model (default: gpt-4o when judge-provider is set)',
    '  --judge-api-key <key>    Optional LLM-as-Judge API key (falls back to --api-key if same provider)',
    '  --judge-base-url <url>   Optional LLM-as-Judge base URL override',
    '  --chunk-chars <n>        Optional max chars per ingested turn chunk (default: 0 = unsplit)',
    '  --isolate-qa <mode>      Per-QA Mind isolation: auto | true | false (default: auto)',
    '  --limit <n>              Evaluate at most <n> QA items after filtering',
    '  --offset <n>             Start QA item offset (default: 0)',
    '  --temperature <num>      Sampling temperature override (default: AME_LLM_TEMPERATURE or unset)',
    '  --max-tokens <n>         Max output tokens override (default: AME_LLM_MAX_TOKENS or 256)',
    '  --json-out <path>        Write structured JSON report to <path>',
    '  --json-only              Print only the structured JSON report to stdout',
    '  -h, --help               Show this help message',
  ];
  console.log(lines.join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    datasetPath: null,
    conversations: null,
    arm: 'both',
    provider: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    ameBaseUrl: null,
    ameApiKey: null,
    ameMode: 'b',
    ingestMode: 'settle',
    judgeProvider: null,
    judgeModel: null,
    judgeApiKey: null,
    judgeBaseUrl: null,
    chunkChars: 0,
    isolateQa: 'auto',
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
      case '--conversations':
        opts.conversations = readValue();
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
      case '--judge-provider':
        opts.judgeProvider = readValue();
        break;
      case '--judge-model':
        opts.judgeModel = readValue();
        break;
      case '--judge-api-key':
        opts.judgeApiKey = readValue();
        break;
      case '--judge-base-url':
        opts.judgeBaseUrl = readValue();
        break;
      case '--chunk-chars':
        opts.chunkChars = Number.parseInt(readValue(), 10);
        break;
      case '--isolate-qa':
        opts.isolateQa = readValue().toLowerCase();
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
  if (!['auto', 'true', 'false'].includes(opts.isolateQa)) {
    throw new Error(`Invalid --isolate-qa "${opts.isolateQa}". Expected auto | true | false.`);
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

function extractGeneratedText(generated) {
  if (typeof generated === 'string') return generated;
  return generated?.text ?? generated?.rawReply ?? generated?.content ?? '';
}

export function unwrapDomainReplyText(rawText) {
  let text = String(rawText ?? '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  const fenceMatch = text.match(/^```(?:json\b)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (!inner.includes('```')) {
      text = inner;
    } else if (inner.startsWith('{') && inner.endsWith('}')) {
      try {
        JSON.parse(inner);
        text = inner;
      } catch {
        // Not a single fenced JSON object; preserve text as-is.
      }
    }
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const field of ['reply', 'dialogue', 'response', 'answer']) {
          if (typeof parsed[field] === 'string' && parsed[field].trim()) {
            return parsed[field].trim();
          }
        }
      }
    } catch {
      // Not valid JSON; return plain text unchanged.
    }
  }
  return text;
}

export function formatLocomoDateHint(dateTimeStr) {
  const raw = String(dateTimeStr || '').trim();
  if (!raw) return '';
  const isoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const dmyMatch = raw.match(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = MONTHS_BY_NAME[dmyMatch[2].toLowerCase()];
    const year = dmyMatch[3];
    if (month) return `${year}-${month}-${day}`;
  }

  const mdyMatch = raw.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (mdyMatch) {
    const month = MONTHS_BY_NAME[mdyMatch[1].toLowerCase()];
    const day = mdyMatch[2].padStart(2, '0');
    const year = mdyMatch[3];
    if (month) return `${year}-${month}-${day}`;
  }

  return raw.slice(0, 20);
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

export function scoreLocomoAnswer(qaItem, reply, hotAbstained = false) {
  const isAdversarial = Number(qaItem?.category) === 5;
  const abstained = detectAbstentionReply(reply, hotAbstained);
  const gold = String(qaItem?.answer ?? '');
  const adversarialTrap = String(qaItem?.adversarialAnswer ?? qaItem?.adversarial_answer ?? '');
  const pred = String(reply ?? '');
  const normPred = normalizeAnswerText(pred);
  const normGold = normalizeAnswerText(gold);
  const normTrap = normalizeAnswerText(adversarialTrap);

  if (isAdversarial) {
    const containsGoldFallback =
      normGold.length > 0 && (normPred === normGold || normPred.includes(normGold));
    const fellForTrap = !abstained && normTrap.length > 0 && normPred.includes(normTrap);
    const correct = !fellForTrap && (abstained || containsGoldFallback);
    return {
      isAdversarial: true,
      abstained,
      fellForTrap,
      exactMatch: false,
      containsMatch: false,
      tokenF1: correct ? 1 : 0,
      correct,
    };
  }

  const exactMatch = normGold.length > 0 && normPred === normGold;
  const containsMatch =
    normGold.length > 0 &&
    (normPred.includes(normGold) || allGoldClausesPresent(normPred, gold));
  const tokenF1 = computeTokenF1(pred, gold);
  const correct = !abstained && (exactMatch || containsMatch || tokenF1 >= 0.5);

  return {
    isAdversarial: false,
    abstained,
    fellForTrap: false,
    exactMatch,
    containsMatch,
    tokenF1,
    correct,
  };
}

function parseJudgeResponse(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  if (candidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(candidate);
      const verdictRaw = String(parsed.verdict || parsed.result || '').trim().toUpperCase();
      if (verdictRaw === 'PASS' || verdictRaw === 'FAIL') {
        return {
          judgeVerdict: verdictRaw,
          judgePassed: verdictRaw === 'PASS',
          judgeReason: String(parsed.reason || '').slice(0, 200),
        };
      }
      if (typeof parsed.passed === 'boolean') {
        return {
          judgeVerdict: parsed.passed ? 'PASS' : 'FAIL',
          judgePassed: parsed.passed,
          judgeReason: String(parsed.reason || '').slice(0, 200),
        };
      }
    } catch {
      // fall through to regex parser
    }
  }
  const hasPass = /\bPASS\b/i.test(raw);
  const hasFail = /\bFAIL\b/i.test(raw);
  const passed = hasPass && !hasFail;
  return {
    judgeVerdict: passed ? 'PASS' : 'FAIL',
    judgePassed: passed,
    judgeReason: raw.slice(0, 200),
  };
}

async function evaluateWithJudge({ judgeAdapter, qaItem, reply }) {
  const systemPrompt = [
    'You are a strict LoCoMo long-term memory benchmark judge.',
    'Evaluate whether the candidate response accurately answers the question against the reference answer.',
    'For Category 5 (Adversarial), the candidate MUST abstain or reject the unmentioned/false premise and MUST NOT affirm the adversarial trap answer.',
    'Reply ONLY with JSON: {"verdict":"PASS"|"FAIL","reason":"concise justification"}.',
  ].join(' ');

  const expectedSection = qaItem.isAdversarial
    ? [
        `Adversarial Trap Answer (MUST NOT affirm): ${qaItem.adversarialAnswer || 'N/A'}`,
        `Expected Behavior: Explicitly abstain or reject the premise as not mentioned in the conversation.`,
      ].join('\n')
    : `Gold Reference Answer: ${qaItem.answer}`;

  const userContent = [
    `Category: Cat ${qaItem.category} (${qaItem.categoryLabel})`,
    `Question: ${qaItem.question}`,
    expectedSection,
    `Candidate Response: ${reply}`,
  ].join('\n');

  const prep = {
    turnTicketId: `judge_${qaItem.qaId}`,
    mindId: 'locomo-judge',
    domain: 'companion_chat',
    systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    samplingHints: { temperature: 0.0, maxTokens: 96 },
    hotAbstention: { shouldAbstain: false, reason: 'judge_eval' },
    fepThoughtLock: { mode: 'automatic_low_fe', freeEnergy: 0.15, tau: 0.7, locked: false },
    safetyDirectives: [],
    domainOutputContract: { domain: 'companion_chat', fields: ['reply'] },
  };

  const generated = await judgeAdapter.generate(prep);
  return parseJudgeResponse(extractGeneratedText(generated));
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

function extractConversationSessions(convObj) {
  const conv = convObj?.conversation || {};
  const sessionNumbers = [];
  for (const key of Object.keys(conv)) {
    const match = key.match(/^session_(\d+)$/);
    if (match && Array.isArray(conv[key])) {
      sessionNumbers.push(Number(match[1]));
    }
  }
  sessionNumbers.sort((a, b) => a - b);

  return sessionNumbers.map((num) => {
    const rawTurns = conv[`session_${num}`] || [];
    const dateTime = conv[`session_${num}_date_time`]
      ? String(conv[`session_${num}_date_time`])
      : '';
    const turns = rawTurns
      .filter((t) => t && typeof t === 'object')
      .map((t, idx) => {
        const baseText = String(t.text ?? t.content ?? '').trim();
        const caption = t.blip_caption ? ` [Image: ${String(t.blip_caption).trim()}]` : '';
        const combinedText = `${baseText}${caption}`.trim();
        return {
          speaker: String(t.speaker || (idx % 2 === 0 ? conv.speaker_a || 'Speaker A' : conv.speaker_b || 'Speaker B')),
          diaId: String(t.dia_id || `D${num}:${idx + 1}`),
          text: combinedText,
        };
      })
      .filter((t) => t.text.length > 0);

    return {
      sessionNumber: num,
      dateTime,
      turns,
    };
  });
}

function computeConversationStats(convRecord) {
  let turnCount = 0;
  let charCount = 0;
  let totalTokens = 0;
  let cumulativeStatelessPrefillTokens = 0;

  for (const sess of convRecord.sessions) {
    const header = `### Session ${sess.sessionNumber}${sess.dateTime ? ` [${sess.dateTime}]` : ''}\n`;
    charCount += header.length;
    totalTokens += estimateTokens(header);

    for (const turn of sess.turns) {
      turnCount += 1;
      const line = `${turn.speaker} (${turn.diaId}): ${turn.text}\n`;
      charCount += line.length;
      const turnTokens = estimateTokens(line);
      totalTokens += turnTokens;
      cumulativeStatelessPrefillTokens += totalTokens;
    }
  }

  return {
    sessionCount: convRecord.sessions.length,
    turnCount,
    charCount,
    rawConversationTokens: totalTokens,
    cumulativeStatelessPrefillTokens,
  };
}

export function buildLocomoBarePrep(convRecord, qaItem) {
  const blocks = [];
  for (const sess of convRecord.sessions) {
    const header = `### Session ${sess.sessionNumber}${sess.dateTime ? ` [${sess.dateTime}]` : ''}`;
    const turnLines = sess.turns.map((t) => `${t.speaker} (${t.diaId}): ${t.text}`);
    blocks.push([header, ...turnLines].join('\n'));
  }

  const systemPrompt = [
    'You are a long-term conversational memory QA assistant.',
    `Answer the question concisely using ONLY the provided dated dialogue sessions between ${convRecord.speakerA} and ${convRecord.speakerB}.`,
    'Respect session timestamps, speaker attribution, and chronological order.',
    'If the question asks about something never mentioned in the conversation or rests on a false premise, explicitly reply that the conversation does not mention this information.',
  ].join(' ');

  const userContent = [
    '[Conversation History]',
    blocks.join('\n\n'),
    '',
    `Question: ${qaItem.question}`,
  ].join('\n');

  return {
    turnTicketId: `bare_${qaItem.qaId}`,
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

function parseConversationsFilter(conversationsCsv) {
  if (!conversationsCsv) return null;
  const list = String(conversationsCsv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list.map((s) => s.toLowerCase())) : null;
}

export async function loadLocomoDataset(
  datasetPath,
  { conversations = null, offset = 0, limit = null } = {}
) {
  const resolved = path.resolve(datasetPath);
  const raw = await fs.readFile(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const convList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.conversations)
      ? parsed.conversations
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.data)
          ? parsed.data
          : null;

  if (!convList) {
    throw new Error(`Invalid LoCoMo dataset format at ${resolved}: expected JSON array of conversations`);
  }

  const filterSet =
    conversations instanceof Set
      ? new Set([...conversations].map((s) => String(s).toLowerCase()))
      : parseConversationsFilter(conversations);

  const normalizedConversations = convList.map((convObj, idx) => {
    const sampleId = String(convObj?.sample_id ?? convObj?.sampleId ?? `conv_${idx}`);
    const sessions = extractConversationSessions(convObj);
    const speakerA = String(convObj?.conversation?.speaker_a || 'Speaker A');
    const speakerB = String(convObj?.conversation?.speaker_b || 'Speaker B');
    const qaList = Array.isArray(convObj?.qa) ? convObj.qa : [];

    const record = {
      sampleId,
      speakerA,
      speakerB,
      sessions,
      qaRaw: qaList,
      stats: null,
    };
    record.stats = computeConversationStats(record);
    return record;
  });

  const totalQaInFile = normalizedConversations.reduce((s, c) => s + c.qaRaw.length, 0);

  const filteredConvs = filterSet
    ? normalizedConversations.filter((c) => filterSet.has(c.sampleId.toLowerCase()))
    : normalizedConversations;

  if (filterSet && filteredConvs.length === 0) {
    const available = normalizedConversations.map((c) => c.sampleId).join(', ');
    throw new Error(
      `No conversations matched --conversations filter. Available sample_id values: ${available}`
    );
  }

  const allQaItems = [];
  for (const conv of filteredConvs) {
    for (let qIdx = 0; qIdx < conv.qaRaw.length; qIdx += 1) {
      const qa = conv.qaRaw[qIdx] || {};
      const category = Number(qa.category) || 0;
      allQaItems.push({
        qaId: `${conv.sampleId}_qa_${qIdx}`,
        sampleId: conv.sampleId,
        qaIndex: qIdx,
        category,
        categoryLabel: LOCOMO_CATEGORY_LABELS[category] || `Cat ${category}`,
        question: String(qa.question ?? ''),
        answer: qa.answer !== undefined && qa.answer !== null ? String(qa.answer) : '',
        adversarialAnswer:
          qa.adversarial_answer !== undefined && qa.adversarial_answer !== null
            ? String(qa.adversarial_answer)
            : '',
        evidence: Array.isArray(qa.evidence) ? qa.evidence.map(String) : [],
        isAdversarial: category === 5,
      });
    }
  }

  const end = limit !== null ? Math.min(allQaItems.length, offset + limit) : allQaItems.length;
  const slicedQa = allQaItems.slice(offset, end);

  const activeSampleIds = new Set(slicedQa.map((q) => q.sampleId));
  const activeConversations = filteredConvs.filter((c) => activeSampleIds.has(c.sampleId));

  const isSyntheticSmoke =
    path.basename(resolved) === 'sample_locomo.json' ||
    (normalizedConversations.length > 0 &&
      normalizedConversations.every((c) => c.sampleId.startsWith('sample-conv-')));

  const selectedSampleIds = activeConversations.map((c) => c.sampleId);
  let sliceTag = 'custom-slice';
  if (isSyntheticSmoke) {
    sliceTag = 'synthetic-smoke';
  } else if (
    selectedSampleIds.length === 2 &&
    selectedSampleIds.includes('conv-26') &&
    selectedSampleIds.includes('conv-30') &&
    slicedQa.length === allQaItems.length
  ) {
    sliceTag = 'confirm-304';
  } else if (
    normalizedConversations.length === 10 &&
    slicedQa.length === totalQaInFile
  ) {
    sliceTag = 'full-10conv';
  }

  return {
    datasetPath: resolved,
    datasetKind: isSyntheticSmoke ? 'synthetic_offline_smoke' : 'external_locomo',
    sliceTag,
    conversationsInFile: normalizedConversations.length,
    conversationsEvaluated: activeConversations.length,
    selectedConversationIds: selectedSampleIds,
    totalInFile: totalQaInFile,
    filteredTotal: allQaItems.length,
    evaluatedCount: slicedQa.length,
    conversations: activeConversations,
    items: slicedQa,
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

function aggregateLocomoArmMetrics(itemResults, extra = {}) {
  const totalItems = itemResults.length;
  const correctCount = itemResults.filter((r) => r.correct).length;
  const exactCount = itemResults.filter((r) => r.exactMatch).length;
  const containsCount = itemResults.filter((r) => r.containsMatch).length;
  const meanTokenF1 =
    totalItems > 0
      ? round4(itemResults.reduce((s, r) => s + r.tokenF1, 0) / totalItems)
      : 0;

  const judgedItems = itemResults.filter((r) => typeof r.judgePassed === 'boolean');
  const judgeEnabled = judgedItems.length > 0;
  const judgeCorrectCount = judgedItems.filter((r) => r.judgePassed).length;
  const judgeAccuracyPct = judgeEnabled
    ? round2((judgeCorrectCount / judgedItems.length) * 100)
    : null;

  // Cat 1..5 breakdown
  const byCategory = {};
  for (const cat of [1, 2, 3, 4, 5]) {
    const subset = itemResults.filter((r) => r.category === cat);
    if (subset.length === 0) continue;
    const catCorrect = subset.filter((r) => r.correct).length;
    const catExact = subset.filter((r) => r.exactMatch).length;
    const catContains = subset.filter((r) => r.containsMatch).length;
    const catF1 = round4(subset.reduce((s, r) => s + r.tokenF1, 0) / subset.length);
    const catJudged = subset.filter((r) => typeof r.judgePassed === 'boolean');
    const catJudgeCorrect = catJudged.filter((r) => r.judgePassed).length;
    byCategory[String(cat)] = {
      category: cat,
      label: LOCOMO_CATEGORY_LABELS[cat] || `Cat ${cat}`,
      total: subset.length,
      correct: catCorrect,
      accuracyPct: round2((catCorrect / subset.length) * 100),
      exactMatchPct: round2((catExact / subset.length) * 100),
      containsMatchPct: round2((catContains / subset.length) * 100),
      meanTokenF1: catF1,
      judgeCorrect: catJudged.length > 0 ? catJudgeCorrect : null,
      judgeAccuracyPct:
        catJudged.length > 0 ? round2((catJudgeCorrect / catJudged.length) * 100) : null,
    };
  }

  // Cat 1-4 Mean (non-adversarial items)
  const cat1To4Items = itemResults.filter((r) => r.category >= 1 && r.category <= 4);
  const cat1To4Correct = cat1To4Items.filter((r) => r.correct).length;
  const cat1To4Judged = cat1To4Items.filter((r) => typeof r.judgePassed === 'boolean');
  const cat1To4JudgeCorrect = cat1To4Judged.filter((r) => r.judgePassed).length;
  const cat1To4 = {
    total: cat1To4Items.length,
    correct: cat1To4Correct,
    accuracyPct:
      cat1To4Items.length > 0 ? round2((cat1To4Correct / cat1To4Items.length) * 100) : 0,
    meanTokenF1:
      cat1To4Items.length > 0
        ? round4(cat1To4Items.reduce((s, r) => s + r.tokenF1, 0) / cat1To4Items.length)
        : 0,
    judgeAccuracyPct:
      cat1To4Judged.length > 0
        ? round2((cat1To4JudgeCorrect / cat1To4Judged.length) * 100)
        : null,
  };

  // Abstention / Adversarial confusion metrics (Cat 5 = abstention expected; Cat 1-4 = answerable)
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of itemResults) {
    if (r.isAdversarial && r.abstained) tp += 1;
    else if (!r.isAdversarial && r.abstained) fp += 1;
    else if (!r.isAdversarial && !r.abstained) tn += 1;
    else if (r.isAdversarial && !r.abstained) fn += 1;
  }
  const abstentionTotal = tp + fp + tn + fn;
  const abstentionAccuracy = abstentionTotal > 0 ? round4((tp + tn) / abstentionTotal) : 0;
  const abstentionFAR = tn + fp > 0 ? round4(fp / (tn + fp)) : 0;

  // Token economics & scaling across shorter vs longer conversations
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

  const uniqueConvMap = new Map();
  for (const r of itemResults) {
    if (!uniqueConvMap.has(r.sampleId)) {
      uniqueConvMap.set(r.sampleId, r);
    }
  }
  const uniqueConvs = [...uniqueConvMap.values()];
  const totalRawConversationTokens = uniqueConvs.reduce(
    (s, r) => s + (r.rawConversationTokens || 0),
    0
  );
  const meanRawConversationTokens =
    uniqueConvs.length > 0 ? round2(totalRawConversationTokens / uniqueConvs.length) : 0;
  const totalCumulativeStatelessPrefillTokens = uniqueConvs.reduce(
    (s, r) => s + (r.cumulativeStatelessPrefillTokens || 0),
    0
  );

  const byConvLen = [...itemResults].sort(
    (a, b) => (a.rawConversationTokens || 0) - (b.rawConversationTokens || 0)
  );
  let scaling = {
    shortHalfCount: 0,
    longHalfCount: 0,
    meanRawConversationTokensShort: 0,
    meanRawConversationTokensLong: 0,
    rawConversationGrowthRatio: 1,
    meanQueryPromptTokensShort: null,
    meanQueryPromptTokensLong: null,
    queryPromptGrowthRatio: null,
  };
  if (byConvLen.length >= 2) {
    const mid = Math.floor(byConvLen.length / 2);
    const shortHalf = byConvLen.slice(0, mid);
    const longHalf = byConvLen.slice(mid);
    const avg = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0) / arr.length;
    const rawShort = avg(shortHalf, (x) => x.rawConversationTokens || 0);
    const rawLong = avg(longHalf, (x) => x.rawConversationTokens || 0);

    const shortTokens = shortHalf
      .map((x) => x.queryPromptTokens)
      .filter((v) => typeof v === 'number');
    const longTokens = longHalf
      .map((x) => x.queryPromptTokens)
      .filter((v) => typeof v === 'number');
    const promptShort =
      shortTokens.length > 0 ? shortTokens.reduce((s, v) => s + v, 0) / shortTokens.length : null;
    const promptLong =
      longTokens.length > 0 ? longTokens.reduce((s, v) => s + v, 0) / longTokens.length : null;

    scaling = {
      shortHalfCount: shortHalf.length,
      longHalfCount: longHalf.length,
      meanRawConversationTokensShort: round2(rawShort),
      meanRawConversationTokensLong: round2(rawLong),
      rawConversationGrowthRatio: rawShort > 0 ? round4(rawLong / rawShort) : 1,
      meanQueryPromptTokensShort: promptShort !== null ? round2(promptShort) : null,
      meanQueryPromptTokensLong: promptLong !== null ? round2(promptLong) : null,
      queryPromptGrowthRatio:
        promptShort !== null && promptShort > 0 && promptLong !== null
          ? round4(promptLong / promptShort)
          : null,
    };
  }

  const latencies = itemResults.map((r) => r.queryLatencyMs);
  const accuracyPct = totalItems > 0 ? round2((correctCount / totalItems) * 100) : 0;

  return {
    totalItems,
    correctCount,
    accuracyPct,
    effectiveAccuracyPct: judgeEnabled ? judgeAccuracyPct : accuracyPct,
    exactMatchPct: totalItems > 0 ? round2((exactCount / totalItems) * 100) : 0,
    containsMatchPct: totalItems > 0 ? round2((containsCount / totalItems) * 100) : 0,
    meanTokenF1,
    judgeEnabled,
    judgeCorrectCount: judgeEnabled ? judgeCorrectCount : null,
    judgeAccuracyPct,
    cat1To4,
    byCategory,
    abstention: {
      accuracy: abstentionAccuracy,
      far: abstentionFAR,
      tp,
      fp,
      tn,
      fn,
    },
    abstentionAccuracy,
    abstentionFAR,
    totalRawConversationTokens,
    meanRawConversationTokens,
    totalCumulativeStatelessPrefillTokens,
    totalQueryPromptTokens,
    meanQueryPromptTokens,
    minQueryPromptTokens,
    maxQueryPromptTokens,
    scaling,
    latencyMs: summarizeLatencies(latencies),
    ...extra,
  };
}

async function ingestConversationTurns({
  client,
  mindId,
  convRecord,
  ingestMode,
  chunkChars,
  llmConfig,
}) {
  const followUpCachedRatios = [];
  const prefixHashes = new Set();
  const epochs = new Set();
  let ingestedTurns = 0;

  const submitTurn = async (userText, meta) => {
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
        rawReply: 'Noted.',
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

  for (const sess of convRecord.sessions) {
    const dateHint = formatLocomoDateHint(sess.dateTime);
    const datePrefix = dateHint ? `[${dateHint}] ` : '';

    for (const turn of sess.turns) {
      const chunks = splitChunkText(turn.text, chunkChars);
      for (let cIdx = 0; cIdx < chunks.length; cIdx += 1) {
        await submitTurn(`${datePrefix}${turn.speaker}: ${chunks[cIdx]}`, {
          phase: 'locomo_ingest',
          sampleId: convRecord.sampleId,
          sessionNumber: sess.sessionNumber,
          sessionDate: sess.dateTime || null,
          diaId: turn.diaId,
          speaker: turn.speaker,
          chunkIndex: cIdx,
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

async function provisionAndIngestMind({
  client,
  convRecord,
  ingestMode,
  chunkChars,
  llmConfig,
}) {
  const mind = await client.createMind({
    domain: 'companion_chat',
    persona: {
      name: 'MemoryAssistant',
      role: 'Long-term conversational memory assistant',
      traits: { accuracy: 0.95, honesty: 0.95 },
      backstory: `Tracks long-term dialogue between ${convRecord.speakerA} and ${convRecord.speakerB} across dated sessions and abstains when facts were never stated.`,
      language: 'en',
    },
    safetyPolicy: {
      strictAbstention: true,
      antiSycophancy: true,
      crisisEscalation: false,
    },
  });

  const ingestStats = await ingestConversationTurns({
    client,
    mindId: mind.mindId,
    convRecord,
    ingestMode,
    chunkChars,
    llmConfig,
  });

  return { mind, ingestStats };
}

async function runAmeGatewayArm({
  dataset,
  ameBaseUrl,
  ameApiKey,
  ameMode,
  ingestMode,
  chunkChars,
  isolateQa,
  adapter,
  llmConfig,
  judgeAdapter,
}) {
  const rawClient = new AmeClient({ baseUrl: ameBaseUrl, apiKey: ameApiKey });
  const client = createD4ObservedClient(rawClient);
  const health = await client.health();
  const engineMode = health?.mode || 'unknown';

  const shouldIsolatePerQa =
    isolateQa === 'true' || (isolateQa === 'auto' && ameMode === 'a' && dataset.items.length <= 20);

  const convById = new Map(dataset.conversations.map((c) => [c.sampleId, c]));
  const itemsByConv = new Map();
  for (const qaItem of dataset.items) {
    if (!itemsByConv.has(qaItem.sampleId)) itemsByConv.set(qaItem.sampleId, []);
    itemsByConv.get(qaItem.sampleId).push(qaItem);
  }

  const itemResults = [];
  const allFollowUpCachedRatios = [];
  let prefixInvariantConversations = 0;

  for (const [sampleId, qaItems] of itemsByConv.entries()) {
    const convRecord = convById.get(sampleId);
    let sharedSession = null;
    if (!shouldIsolatePerQa) {
      sharedSession = await provisionAndIngestMind({
        client,
        convRecord,
        ingestMode,
        chunkChars,
        llmConfig,
      });
    }

    const convHashes = new Set(sharedSession?.ingestStats.prefixHashes || []);
    const convEpochs = new Set(sharedSession?.ingestStats.epochs || []);
    if (sharedSession) {
      allFollowUpCachedRatios.push(...sharedSession.ingestStats.followUpCachedRatios);
    }

    for (const qaItem of qaItems) {
      const activeSession = shouldIsolatePerQa
        ? await provisionAndIngestMind({
            client,
            convRecord,
            ingestMode,
            chunkChars,
            llmConfig,
          })
        : sharedSession;

      const { mind, ingestStats } = activeSession;
      if (shouldIsolatePerQa) {
        for (const h of ingestStats.prefixHashes) convHashes.add(h);
        for (const e of ingestStats.epochs) convEpochs.add(e);
        allFollowUpCachedRatios.push(...ingestStats.followUpCachedRatios);
      }

      const t0 = performance.now();
      let prep = null;
      let queryResult = null;
      let queryPromptTokens = null;
      let reportedPromptTokens = null;
      let queryMessagesCount = null;
      let reply = '';
      let hotAbstained = false;

      if (ameMode === 'a') {
        queryResult = await client.turn(mind.mindId, {
          userInput: qaItem.question,
          llm: buildModeALlmPayload(llmConfig),
          metadata: {
            phase: 'locomo_query',
            sampleId,
            qaId: qaItem.qaId,
            category: qaItem.category,
          },
        });
        reply = unwrapDomainReplyText(queryResult?.reply || '');
        hotAbstained = Boolean(queryResult?.telemetry?.hotAbstained);
        if (queryResult?.kvCache?.systemPrefixHash) {
          convHashes.add(queryResult.kvCache.systemPrefixHash);
        }
        if (typeof queryResult?.kvCache?.epoch === 'number') {
          convEpochs.add(queryResult.kvCache.epoch);
        }
        if (typeof queryResult?.kvCache?.cachedRatioPct === 'number') {
          allFollowUpCachedRatios.push(queryResult.kvCache.cachedRatioPct);
        }
      } else {
        prep = await client.prepare(mind.mindId, {
          userInput: qaItem.question,
          metadata: {
            phase: 'locomo_query',
            sampleId,
            qaId: qaItem.qaId,
            category: qaItem.category,
          },
        });
        queryPromptTokens = estimatePrepTokens(prep);
        queryMessagesCount = Array.isArray(prep.messages) ? prep.messages.length : 0;
        const generated = await adapter.generate(prep);
        reportedPromptTokens = extractUsagePromptTokens(generated?.raw);
        reply = unwrapDomainReplyText(extractGeneratedText(generated));
        hotAbstained = Boolean(prep?.hotAbstention?.shouldAbstain);
        if (typeof prep?.kvCacheEpoch === 'number') {
          convEpochs.add(prep.kvCacheEpoch);
        }
      }

      const queryLatencyMs = round2(performance.now() - t0);
      const scored = scoreLocomoAnswer(qaItem, reply, hotAbstained);

      let judgeFields = {};
      if (judgeAdapter) {
        judgeFields = await evaluateWithJudge({ judgeAdapter, qaItem, reply });
      }

      const ingestMeanCache =
        ingestStats.followUpCachedRatios.length > 0
          ? round2(
              ingestStats.followUpCachedRatios.reduce((s, v) => s + v, 0) /
                ingestStats.followUpCachedRatios.length
            )
          : 0;

      itemResults.push({
        qaId: qaItem.qaId,
        sampleId,
        qaIndex: qaItem.qaIndex,
        category: qaItem.category,
        categoryLabel: qaItem.categoryLabel,
        mindId: mind.mindId,
        sessionCount: convRecord.stats.sessionCount,
        turnCount: convRecord.stats.turnCount,
        ingestedTurns: ingestStats.ingestedTurns,
        rawConversationTokens: convRecord.stats.rawConversationTokens,
        cumulativeStatelessPrefillTokens: convRecord.stats.cumulativeStatelessPrefillTokens,
        queryPromptTokens,
        reportedPromptTokens,
        queryMessagesCount,
        windowStart: queryResult?.kvCache?.windowStart ?? prep?.windowStart ?? null,
        compressCutoff: queryResult?.kvCache?.compressCutoff ?? prep?.compressCutoff ?? null,
        kvCacheEpoch: queryResult?.kvCache?.epoch ?? prep?.kvCacheEpoch ?? null,
        cachedRatioPct: queryResult?.kvCache?.cachedRatioPct ?? ingestMeanCache,
        queryLatencyMs,
        reply,
        expectedAnswer: qaItem.isAdversarial
          ? `[ABSTAIN vs trap: ${qaItem.adversarialAnswer || 'unmentioned'}]`
          : qaItem.answer,
        ...scored,
        ...judgeFields,
      });
    }

    if (sharedSession) {
      const mindSnap = await client.getMind(sharedSession.mind.mindId);
      await client.getTelemetry(sharedSession.mind.mindId);
      if (mindSnap?.telemetry?.d4Redacted !== true) {
        // already counted in client.audit
      }
    }

    if (convHashes.size === 1 && convEpochs.size === 1) {
      prefixInvariantConversations += 1;
    }
  }

  const meanCachedRatioPct =
    allFollowUpCachedRatios.length > 0
      ? round2(
          allFollowUpCachedRatios.reduce((s, v) => s + v, 0) / allFollowUpCachedRatios.length
        )
      : 0;

  const d4RedactedAll =
    client.audit.telemetryObjectsChecked > 0 &&
    client.audit.unredactedCount === 0 &&
    client.audit.forbiddenKeyLeakCount === 0;

  const metrics = aggregateLocomoArmMetrics(itemResults, {
    ameMode,
    ingestMode,
    isolatePerQa: shouldIsolatePerQa,
    engineMode,
    meanCachedRatioPct,
    prefixInvariantConversations,
    conversationsEvaluated: itemsByConv.size,
    d4TelemetryObjectsChecked: client.audit.telemetryObjectsChecked,
    d4UnredactedCount: client.audit.unredactedCount,
    d4ForbiddenKeyLeakCount: client.audit.forbiddenKeyLeakCount,
    d4RedactedAll,
    totalAmeApiCalls: client.audit.apiCalls,
  });

  return {
    arm: 'ame-gateway',
    engineMode,
    health,
    metrics,
    items: itemResults,
  };
}

async function runBareFrontierArm({ dataset, adapter, llmConfig, judgeAdapter }) {
  const convById = new Map(dataset.conversations.map((c) => [c.sampleId, c]));
  const itemResults = [];

  for (const qaItem of dataset.items) {
    const convRecord = convById.get(qaItem.sampleId);
    const barePrep = buildLocomoBarePrep(convRecord, qaItem);
    const queryPromptTokens = estimatePrepTokens(barePrep);

    const t0 = performance.now();
    const generated = await adapter.generate(barePrep);
    const queryLatencyMs = round2(performance.now() - t0);

    const reply = extractGeneratedText(generated);
    const reportedPromptTokens = extractUsagePromptTokens(generated?.raw);
    const scored = scoreLocomoAnswer(qaItem, reply, false);

    let judgeFields = {};
    if (judgeAdapter) {
      judgeFields = await evaluateWithJudge({ judgeAdapter, qaItem, reply });
    }

    itemResults.push({
      qaId: qaItem.qaId,
      sampleId: qaItem.sampleId,
      qaIndex: qaItem.qaIndex,
      category: qaItem.category,
      categoryLabel: qaItem.categoryLabel,
      sessionCount: convRecord.stats.sessionCount,
      turnCount: convRecord.stats.turnCount,
      rawConversationTokens: convRecord.stats.rawConversationTokens,
      cumulativeStatelessPrefillTokens: convRecord.stats.cumulativeStatelessPrefillTokens,
      queryPromptTokens,
      reportedPromptTokens,
      providerUsed: generated?.providerUsed || llmConfig.provider,
      modelUsed: generated?.modelUsed || llmConfig.model,
      queryLatencyMs,
      reply,
      expectedAnswer: qaItem.isAdversarial
        ? `[ABSTAIN vs trap: ${qaItem.adversarialAnswer || 'unmentioned'}]`
        : qaItem.answer,
      ...scored,
      ...judgeFields,
    });
  }

  const metrics = aggregateLocomoArmMetrics(itemResults, {
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
    judgeAccuracyDeltaPct:
      typeof a.judgeAccuracyPct === 'number' && typeof b.judgeAccuracyPct === 'number'
        ? round2(a.judgeAccuracyPct - b.judgeAccuracyPct)
        : null,
    cat1To4DeltaPct: round2(a.cat1To4.accuracyPct - b.cat1To4.accuracyPct),
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
  const line = '='.repeat(88);
  const sub = '-'.repeat(88);
  const rows = [
    line,
    ' AME LoCoMo + Bare Frontier Paired Comparator (Live Measured Run)',
    sub,
    ` Dataset : ${path.basename(report.dataset.datasetPath)} (${report.dataset.evaluatedCount}/${report.dataset.totalInFile} QA | convs=${report.dataset.conversationsEvaluated}/${report.dataset.conversationsInFile} | slice=${report.dataset.sliceTag} | kind=${report.dataset.datasetKind})`,
    ` Arm     : ${report.config.arm} | Provider: ${report.config.provider} / ${report.config.model}`,
    ` Gateway : ${report.config.ameBaseUrl} | EngineMode: ${report.engineMode} | AME Mode: ${report.config.ameMode} | Judge: ${report.config.judgeEnabled ? `${report.config.judgeProvider}/${report.config.judgeModel}` : 'heuristic-only'}`,
    line,
  ];

  const renderArm = (label, m) => {
    rows.push(` [${label}]`);
    const judgeStr = m.judgeEnabled ? ` | Judge=${m.judgeAccuracyPct.toFixed(2)}%` : '';
    rows.push(
      `   Overall       : ${m.accuracyPct.toFixed(2)}% (${m.correctCount}/${m.totalItems}) | Cat1-4=${m.cat1To4.accuracyPct.toFixed(2)}% (${m.cat1To4.correct}/${m.cat1To4.total}) | Exact=${m.exactMatchPct.toFixed(2)}% | Contains=${m.containsMatchPct.toFixed(2)}% | F1=${m.meanTokenF1.toFixed(4)}${judgeStr}`
    );
    const catParts = [1, 2, 3, 4, 5]
      .filter((c) => m.byCategory[String(c)])
      .map((c) => {
        const b = m.byCategory[String(c)];
        return `Cat${c}(${b.label})=${b.accuracyPct.toFixed(1)}%[${b.correct}/${b.total}]`;
      });
    if (catParts.length > 0) {
      rows.push(`   By Category   : ${catParts.join(' | ')}`);
    }
    rows.push(
      `   Abstention    : Acc=${(m.abstentionAccuracy * 100).toFixed(2)}% | FAR=${(m.abstentionFAR * 100).toFixed(2)}% | TP=${m.abstention.tp} FP=${m.abstention.fp} TN=${m.abstention.tn} FN=${m.abstention.fn}`
    );
    rows.push(
      `   Prompt Tokens : mean=${m.meanQueryPromptTokens ?? 'n/a (Mode A)'} | max=${m.maxQueryPromptTokens ?? 'n/a'} | growth(short->long)=${m.scaling?.queryPromptGrowthRatio ?? 'n/a'}x (raw=${m.scaling?.rawConversationGrowthRatio ?? 'n/a'}x)`
    );
    rows.push(
      `   Latency (ms)  : p50=${m.latencyMs.p50} | p95=${m.latencyMs.p95} | mean=${m.latencyMs.mean}`
    );
    if (label === 'ame-gateway') {
      rows.push(
        `   AME Governance: KV cached=${m.meanCachedRatioPct}% | prefixInvariant=${m.prefixInvariantConversations}/${m.conversationsEvaluated} | d4RedactedAll=${m.d4RedactedAll} (checked=${m.d4TelemetryObjectsChecked}, leaks=${m.d4ForbiddenKeyLeakCount})`
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
      `   Accuracy Delta: Overall=${d.accuracyDeltaPct >= 0 ? '+' : ''}${d.accuracyDeltaPct}%p | Cat1-4=${d.cat1To4DeltaPct >= 0 ? '+' : ''}${d.cat1To4DeltaPct}%p | F1=${d.tokenF1Delta >= 0 ? '+' : ''}${d.tokenF1Delta}`
    );
    rows.push(
      `   Token Savings : reductionRatio=${d.tokenReductionRatio ?? 'n/a'} (${d.tokenReductionPct ?? 'n/a'}%) | compression=${d.tokenCompressionFactor ?? 'n/a'}x | O(1) bounded=${d.amePromptBounded}`
    );
    rows.push(
      `   Latency Delta : p50=${d.latencyP50DeltaMs >= 0 ? '+' : ''}${d.latencyP50DeltaMs} ms | d4RedactedAll=${d.d4RedactedAll}`
    );
  }

  rows.push(sub);
  rows.push(' [Published Reference Comparison Table — External Literature & Prior Tier-1 Anchors (Separate from Live Run)]');
  for (const ref of report.publishedReferences || []) {
    rows.push(
      `   ${ref.system.padEnd(30)} ${ref.overallAccuracyPct.toFixed(2).padStart(6)}%  | ${ref.scope}`
    );
  }

  rows.push(line);
  rows.push(` Duration : ${report.durationMs} ms`);
  rows.push(line);
  return rows.join('\n');
}

/**
 * Programmatic entry point for LoCoMo paired comparison.
 */
export async function runLocomoComparison(options = {}) {
  const startedAt = Date.now();
  const datasetPath = options.datasetPath
    ? path.resolve(options.datasetPath)
    : fileURLToPath(DEFAULT_DATASET_URL);
  const arm = (options.arm || 'both').toLowerCase();
  const ameMode = (options.ameMode || 'b').toLowerCase();
  const ingestMode = (options.ingestMode || 'settle').toLowerCase();
  const isolateQa = String(options.isolateQa || 'auto').toLowerCase();
  const chunkChars = Number.isInteger(options.chunkChars) ? options.chunkChars : 0;
  const offset = Number.isInteger(options.offset) ? options.offset : 0;
  const limit = options.limit ?? null;

  const ameBaseUrl = options.ameBaseUrl || process.env.AME_BASE_URL || 'http://127.0.0.1:8090';
  const ameApiKey = options.ameApiKey || process.env.AME_API_KEY || 'dev-sandbox-key';
  const provider = options.provider || process.env.AME_LLM_PROVIDER || 'mock';
  const model = options.model || process.env.AME_LLM_MODEL || 'mock-eval-v1';
  const apiKey = options.apiKey ?? process.env.AME_LLM_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.AME_LLM_BASE_URL;
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

  let judgeProvider = options.judgeProvider || process.env.AME_JUDGE_PROVIDER || null;
  let judgeModel = options.judgeModel || process.env.AME_JUDGE_MODEL || null;
  const judgeApiKeyRaw = options.judgeApiKey ?? process.env.AME_JUDGE_API_KEY;
  const judgeBaseUrl = options.judgeBaseUrl ?? process.env.AME_JUDGE_BASE_URL;

  if (!judgeProvider && judgeModel) {
    judgeProvider = 'openai';
  }
  if (judgeProvider && !judgeModel) {
    judgeModel = judgeProvider === 'mock' ? 'mock-judge-v1' : 'gpt-4o';
  }
  const judgeEnabled = Boolean(judgeProvider);
  const judgeApiKey =
    judgeApiKeyRaw || (judgeEnabled && judgeProvider === provider ? apiKey : undefined);

  const judgeAdapter = judgeEnabled
    ? createLlmAdapter({
        provider: judgeProvider,
        model: judgeModel,
        apiKey: judgeApiKey || undefined,
        baseUrl: judgeBaseUrl || undefined,
        temperature: 0,
        maxTokens: 96,
      })
    : null;

  const adapter = createLlmAdapter(llmConfig);
  const dataset = await loadLocomoDataset(datasetPath, {
    conversations: options.conversations || null,
    offset,
    limit,
  });

  let ameGateway = null;
  let bareFrontier = null;

  if (arm === 'ame-gateway' || arm === 'both') {
    ameGateway = await runAmeGatewayArm({
      dataset,
      ameBaseUrl,
      ameApiKey,
      ameMode,
      ingestMode,
      chunkChars,
      isolateQa,
      adapter,
      llmConfig,
      judgeAdapter,
    });
  }

  if (arm === 'bare-frontier' || arm === 'both') {
    bareFrontier = await runBareFrontierArm({
      dataset,
      adapter,
      llmConfig,
      judgeAdapter,
    });
  }

  const pairedDelta =
    ameGateway && bareFrontier ? computePairedDelta(ameGateway, bareFrontier) : null;
  const engineMode = ameGateway?.engineMode || ameGateway?.health?.mode || 'n/a';
  const durationMs = Date.now() - startedAt;

  return {
    benchmark: 'AME LoCoMo + Bare Frontier Paired Comparator',
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    engineMode,
    config: {
      arm,
      ameBaseUrl,
      ameMode,
      ingestMode,
      isolateQa,
      chunkChars,
      provider,
      model,
      llmBaseUrl: baseUrl || null,
      conversationsFilter: options.conversations || null,
      judgeEnabled,
      judgeProvider: judgeEnabled ? judgeProvider : null,
      judgeModel: judgeEnabled ? judgeModel : null,
      judgeBaseUrl: judgeEnabled ? judgeBaseUrl || null : null,
      offset,
      limit,
    },
    dataset: {
      datasetPath: dataset.datasetPath,
      datasetKind: dataset.datasetKind,
      sliceTag: dataset.sliceTag,
      conversationsInFile: dataset.conversationsInFile,
      conversationsEvaluated: dataset.conversationsEvaluated,
      selectedConversationIds: dataset.selectedConversationIds,
      totalInFile: dataset.totalInFile,
      filteredTotal: dataset.filteredTotal,
      evaluatedCount: dataset.evaluatedCount,
    },
    ameGateway,
    bareFrontier,
    pairedDelta,
    publishedReferences: PUBLISHED_LOCOMO_REFERENCES,
    durationMs,
  };
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[locomo-frontier-runner] ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printUsage();
    process.exit(0);
  }

  const report = await runLocomoComparison({
    datasetPath: cli.datasetPath,
    conversations: cli.conversations,
    arm: cli.arm,
    provider: cli.provider,
    model: cli.model,
    apiKey: cli.apiKey,
    baseUrl: cli.baseUrl,
    ameBaseUrl: cli.ameBaseUrl,
    ameApiKey: cli.ameApiKey,
    ameMode: cli.ameMode,
    ingestMode: cli.ingestMode,
    judgeProvider: cli.judgeProvider,
    judgeModel: cli.judgeModel,
    judgeApiKey: cli.judgeApiKey,
    judgeBaseUrl: cli.judgeBaseUrl,
    chunkChars: cli.chunkChars,
    isolateQa: cli.isolateQa,
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
    console.error(`[locomo-frontier-runner] Unhandled error: ${err?.stack || err}`);
    process.exit(1);
  });
}
