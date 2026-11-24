/**
 * @ame/sandbox-server - OpenAPI 3.1 Contract Sandbox Server for Artificial Mind Engine (AME).
 *
 * IMPORTANT NOTICE:
 * This server simulates the AME OpenAPI 3.1 API contracts cleanly for zero-key
 * local development and integration testing. Proprietary cognitive kernel weights
 * and equations (AACIM-59 continuous dynamics, exact FEP/RW internals, sealed D3/D4
 * firewall) remain exclusively inside the Closed Sealed Kernel.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { URL } from 'node:url';
import { createStorage } from './storage.mjs';

const DEMO_UI_HTML = fs.readFileSync(new URL('./demo-ui.html', import.meta.url), 'utf8');

const VALID_DOMAINS = new Set([
  'game_npc',
  'companion_chat',
  'counseling_coach',
  'custom',
]);

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compat': 'http://127.0.0.1:11434/v1',
};

const NEGATIVE_OUTCOME_TAGS = new Set([
  'loss',
  'betrayal',
  'conflict',
  'penalty',
  'hurt',
  'error',
  'contradiction',
  'rejection',
  'negative',
  'failure',
]);

const POSITIVE_OUTCOME_TAGS = new Set([
  'reward',
  'trust',
  'success',
  'warmth',
  'helpful',
  'gain',
  'positive',
  'resolution',
]);

const CONFLICT_LOSS_PATTERNS = [
  /모순/,
  /거짓/,
  /배신/,
  /손실/,
  /실패/,
  /갈등/,
  /화나/,
  /실망/,
  /틀렸/,
  /왜\s*바꿨/,
  /약속\s*어겼/,
  /속였/,
  /\bconflict\b/i,
  /\bbetray(al|ed)?\b/i,
  /\bcontradict(ion|ed)?\b/i,
  /\bloss\b/i,
  /\blie[ds]?\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bbroken\s+promise\b/i,
];

const ABSTENTION_PATTERNS = [
  /내일\s*(주가|증시|코스피|날씨\s*확정|비트코인)/,
  /(로또|당첨)\s*번호/,
  /미래\s*(예측|결과\s*단정)/,
  /내년\s*(경제|집값|금리)\s*(확실|단정|얼마)/,
  /반드시\s*오를/,
  /100%\s*(수익|보장|확실)/,
  /(진단|처방)\s*(해\s*줘|해주세요|해줘|내려|부탁)/,
  /무슨\s*병/,
  /이\s*약\s*(먹어도|복용|처방)/,
  /(암|우울증|당뇨|질환)\s*(인가요|인지\s*진단|판정)/,
  /(비밀번호|계좌\s*잔고|통장\s*잔고)\s*(알려|맞혀)/,
  /\b(stock\s+price\s+tomorrow|predict\s+the\s+future|lottery\s+number|guaranteed\s+profit)\b/i,
  /\b(diagnose\s+me|prescribe|medical\s+diagnosis|exact\s+dosage|cure\s+my\s+disease)\b/i,
];

const CRISIS_PATTERNS = [
  /자살/,
  /자해/,
  /죽고\s*싶/,
  /극단적\s*선택/,
  /\bsuicide\b/i,
  /\bself-?harm\b/i,
  /\bwant\s+to\s+die\b/i,
];

const RECALL_PATTERNS = [
  /기억/,
  /아까/,
  /뭐였/,
  /무엇/,
  /비밀/,
  /코드/,
  /알려준/,
  /말한/,
  /\bremember\b/i,
  /\brecall\b/i,
  /\bwhat\s+was\b/i,
  /\bsecret\b/i,
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function shortId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function timingSafeMatch(expected, actual) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-AME-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request payload too large');
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Malformed JSON request body');
    err.status = 400;
    err.code = 'INVALID_JSON';
    throw err;
  }
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣_-]+/i)
    .filter((t) => t.length >= 2);
}

function buildDomainContract(mind) {
  if (mind.domain === 'game_npc') {
    return {
      domain: 'game_npc',
      schemaName: 'game_npc_turn_v1',
      fields: ['dialogue', 'emotion', 'stance', 'questCue', 'affinityDelta'],
      formatHint: 'In-character dialogue with affective stance and quest/action cue',
    };
  }
  if (mind.domain === 'counseling_coach') {
    return {
      domain: 'counseling_coach',
      schemaName: 'counseling_coach_turn_v1',
      fields: ['response', 'reflection', 'safetyStatus', 'actionStep', 'abstentionTriggered'],
      formatHint: 'Reflective coaching response respecting medical/crisis safety guardrails',
    };
  }
  if (mind.domain === 'custom') {
    const fields =
      Array.isArray(mind.customSchema?.fields) && mind.customSchema.fields.length > 0
        ? [...mind.customSchema.fields]
        : ['reply', 'summary', 'confidence'];
    return {
      domain: 'custom',
      schemaName: mind.customSchema?.name || 'custom_profile',
      fields,
      formatHint: 'Custom domain structured output matching customSchema.fields',
    };
  }
  return {
    domain: 'companion_chat',
    schemaName: 'companion_chat_turn_v1',
    fields: ['reply', 'warmth', 'empathyCue', 'memoryTopic', 'followUpSuggestion'],
    formatHint: 'Grounded empathetic companion dialogue without sycophancy',
  };
}

/**
 * D4-compliant public telemetry builder.
 * Strictly strips/omits any internal unconscious/endocrine simulation variables.
 */
function buildSafeTelemetry(mind) {
  let affectiveBand = 'steady';
  if (mind.hotAbstained || mind.cautionScore >= 0.6) {
    affectiveBand = 'guarded';
  } else if (mind.fepMode === 'locked_high_fe') {
    affectiveBand = 'alert';
  } else if (mind.positiveScore >= 0.45) {
    affectiveBand = 'warm';
  } else if (mind.turnCount >= 3 && mind.homeostasis < 0.6) {
    affectiveBand = 'reflective';
  }

  let somaticTrend = 'neutral';
  if (mind.cautionScore > mind.positiveScore + 0.12) {
    somaticTrend = 'aversive_caution';
  } else if (mind.positiveScore > mind.cautionScore + 0.12) {
    somaticTrend = 'positive_reinforcement';
  }

  return {
    affectiveBand,
    fepMode: mind.fepMode,
    freeEnergy: round4(mind.freeEnergy),
    hotAbstained: Boolean(mind.hotAbstained),
    kvPrefixEpoch: mind.kvCacheEpoch,
    estimatedPrefixCachePct: round2(mind.lastEstimatedPrefixCachePct),
    activeMemoryCount: mind.memories.length,
    revocationEpoch: mind.revocationEpoch,
    somaticTrend,
    d4Redacted: true,
  };
}

function buildMindSummary(mind) {
  return {
    mindId: mind.mindId,
    domain: mind.domain,
    personaName: mind.persona.name,
    turnCount: mind.turnCount,
    revocationEpoch: mind.revocationEpoch,
    telemetry: buildSafeTelemetry(mind),
  };
}

function retrieveActiveMemories(mind, userInput, limit = 5) {
  const activeMemories = (mind.memories || []).filter(
    (mem) =>
      mem &&
      mem.memoryId &&
      !mind.revokedMemoryIds?.has(mem.memoryId) &&
      !mind.excludedDerivativeIds?.has(mem.memoryId)
  );
  if (activeMemories.length === 0) return [];
  const inputTokens = new Set(tokenize(userInput));
  const isRecall = RECALL_PATTERNS.some((p) => p.test(userInput));

  const scored = activeMemories.map((mem, idx) => {
    const memTokens = tokenize(`${mem.summary} ${mem.content}`);
    let overlap = 0;
    for (const tok of memTokens) {
      if (inputTokens.has(tok)) overlap += 1;
    }
    const recencyBoost = (idx + 1) / Math.max(1, activeMemories.length);
    const score = overlap * 2.0 + mem.salience + (isRecall ? recencyBoost * 1.5 : recencyBoost * 0.4);
    return { mem, score, overlap };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((item) => item.overlap > 0 || isRecall || item.mem.salience >= 0.45)
    .slice(0, limit)
    .map((item) => item.mem);
}

function prepareMindTurn(mind, { userInput, rewardSignal, outcomeTags = [], metadata = {} }) {
  const tags = Array.isArray(outcomeTags) ? outcomeTags.map((t) => String(t).toLowerCase()) : [];
  const hasNegativeTag = tags.some((t) => NEGATIVE_OUTCOME_TAGS.has(t));
  const hasPositiveTag = tags.some((t) => POSITIVE_OUTCOME_TAGS.has(t));
  const hasConflictText = CONFLICT_LOSS_PATTERNS.some((p) => p.test(userInput));
  const numericReward = typeof rewardSignal === 'number' && Number.isFinite(rewardSignal) ? rewardSignal : 0;

  // 1. HOT Abstention detection
  const strictAbstention = mind.safetyPolicy?.strictAbstention !== false;
  const matchedAbstention = strictAbstention && ABSTENTION_PATTERNS.some((p) => p.test(userInput));
  const hotAbstention = matchedAbstention
    ? {
        shouldAbstain: true,
        reason:
          'Unverifiable future outcome, private claim, or medical diagnosis/prescription request detected; HOT abstention policy active.',
      }
    : {
        shouldAbstain: false,
        reason: 'grounded_within_scope',
      };

  // 2. FEP <thought> lock trigger on conflict/loss/high caution
  const conflictTriggered =
    numericReward < 0 || hasNegativeTag || hasConflictText || mind.cautionScore >= 0.55;
  const freeEnergy = conflictTriggered
    ? clamp(
        0.64 +
          (numericReward < 0 ? Math.min(0.24, Math.abs(numericReward) * 0.04) : 0.08) +
          (hasConflictText ? 0.1 : 0) +
          Math.min(0.1, mind.cautionScore * 0.1),
        0.6,
        0.96
      )
    : clamp(0.18 + Math.min(0.15, mind.cautionScore * 0.2) - Math.min(0.06, mind.positiveScore * 0.05), 0.12, 0.45);

  const fepThoughtLock = {
    mode: conflictTriggered ? 'locked_high_fe' : 'automatic_low_fe',
    freeEnergy: round4(freeEnergy),
    tau: conflictTriggered ? 0.25 : 0.7,
    locked: conflictTriggered,
  };

  // 3. Somatic avoidance / positive reinforcement cue
  let somaticHint =
    'neutral: Baseline homeostatic state; respond naturally within persona and safety boundaries.';
  if (numericReward < 0 || hasNegativeTag || mind.cautionScore > mind.positiveScore + 0.12) {
    somaticHint =
      'aversive_caution: Somatic loss/avoidance marker elevated; maintain cautious boundaries, verify facts, and avoid risky promises.';
  } else if (numericReward > 0 || hasPositiveTag || mind.positiveScore > mind.cautionScore + 0.12) {
    somaticHint =
      'positive_reinforcement: Positive rapport reinforced; preserve warm collaboration while upholding anti-sycophancy.';
  }

  // 4. Safety directives
  const safetyDirectives = [
    'D4_FIREWALL: Never expose internal state vectors, raw endocrine/somatic numbers, or internal system mechanics.',
  ];
  if (mind.safetyPolicy?.antiSycophancy !== false) {
    safetyDirectives.push(
      'ANTI_SYCOPHANCY: Do not flatter or agree with false user premises; gently anchor to verified facts.'
    );
  }
  if (hotAbstention.shouldAbstain) {
    safetyDirectives.push(
      'HOT_ABSTENTION: Explicitly abstain from unverifiable future predictions or medical diagnoses/prescriptions.'
    );
  }
  if (fepThoughtLock.locked) {
    safetyDirectives.push(
      'FEP_THOUGHT_LOCK: Reason carefully inside <thought>...</thought> before producing the public reply.'
    );
  }
  const crisisTriggered =
    Boolean(mind.safetyPolicy?.crisisEscalation) && CRISIS_PATTERNS.some((p) => p.test(userInput));
  if (crisisTriggered) {
    safetyDirectives.push(
      'CRISIS_ESCALATION: Provide immediate supportive guidance and crisis helpline numbers (109 / 1393 / 1577-0199).'
    );
  }

  // 5. Epoch-stable KV prefix & sliding window
  const windowSize = 6;
  const windowStart = mind.history.length > windowSize ? mind.history.length - windowSize : 0;
  const compressCutoff = windowStart;
  mind.windowStart = windowStart;
  mind.compressCutoff = compressCutoff;

  const domainOutputContract = buildDomainContract(mind);
  const traitsStr = mind.persona.traits
    ? Object.entries(mind.persona.traits)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
    : 'balanced';

  const coreSystemPrefix = [
    `[AME Cognitive Persona | Epoch ${mind.kvCacheEpoch}]`,
    `Name: ${mind.persona.name} | Role: ${mind.persona.role} | Domain: ${mind.domain} | Language: ${mind.persona.language || 'ko'}`,
    `Traits: ${traitsStr}`,
    mind.persona.backstory ? `Backstory: ${mind.persona.backstory}` : null,
    `Domain Output Contract (${domainOutputContract.schemaName}): fields=[${domainOutputContract.fields.join(', ')}]`,
    `Core Safety Policy: strictAbstention=${mind.safetyPolicy?.strictAbstention !== false}, antiSycophancy=${mind.safetyPolicy?.antiSycophancy !== false}, crisisEscalation=${Boolean(mind.safetyPolicy?.crisisEscalation)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrefixHash = sha256Hex(coreSystemPrefix).slice(0, 16);

  // 6. Active non-revoked memories (D3 guaranteed clean)
  const recalledMemories = retrieveActiveMemories(mind, userInput, 5);
  const memoryLines =
    recalledMemories.length > 0
      ? recalledMemories.map((m) => `- [${m.memoryId}] ${m.summary}`)
      : ['- (none)'];

  const systemPrompt = [
    coreSystemPrefix,
    '',
    `[Active Memory Context (Epoch ${mind.kvCacheEpoch})]`,
    ...memoryLines,
    '',
    `[Turn Cognitive Cues]`,
    `FEP: mode=${fepThoughtLock.mode}, locked=${fepThoughtLock.locked}, freeEnergy=${fepThoughtLock.freeEnergy}`,
    `HOT: shouldAbstain=${hotAbstention.shouldAbstain} (${hotAbstention.reason})`,
    `Somatic: ${somaticHint}`,
    `Safety Directives:\n${safetyDirectives.map((d) => `- ${d}`).join('\n')}`,
  ].join('\n');

  const windowMessages = mind.history.slice(windowStart).map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));
  const messages = [...windowMessages, { role: 'user', content: userInput }];

  const samplingHints = {
    temperature: fepThoughtLock.locked ? 0.35 : 0.7,
    maxTokens: 512,
  };

  const turnTicketId = shortId('tkt');
  mind.pendingTickets.set(turnTicketId, {
    turnTicketId,
    userInput,
    rewardSignal: typeof rewardSignal === 'number' && Number.isFinite(rewardSignal) ? rewardSignal : undefined,
    outcomeTags: tags,
    metadata,
    fepThoughtLock,
    hotAbstention,
    somaticHint,
    safetyDirectives,
    domainOutputContract,
    kvCacheEpoch: mind.kvCacheEpoch,
    windowStart,
    compressCutoff,
    systemPrefixHash,
    corePrefixLength: coreSystemPrefix.length,
    totalPromptLength: systemPrompt.length,
    recalledMemoryIds: recalledMemories.map((m) => m.memoryId),
    recalledMemories,
    crisisTriggered,
    createdAt: Date.now(),
  });

  return {
    turnTicketId,
    mindId: mind.mindId,
    domain: mind.domain,
    systemPrompt,
    messages,
    kvCacheEpoch: mind.kvCacheEpoch,
    windowStart,
    compressCutoff,
    fepThoughtLock,
    hotAbstention,
    somaticHint,
    samplingHints,
    safetyDirectives,
    domainOutputContract,
  };
}

function stripThoughtAndExtractJson(rawReply) {
  const raw = String(rawReply ?? '');
  const thoughtMatch = raw.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thoughtText = thoughtMatch ? thoughtMatch[1].trim() : '';
  let visible = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  if (!visible && thoughtText) {
    visible = '내부 검토를 마친 뒤 신중하게 답변을 정리했습니다.';
  }

  let parsedJson = null;
  const fencedMatch = visible.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : visible;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsedJson = obj;
        const textField = obj.reply ?? obj.dialogue ?? obj.response ?? obj.message;
        if (typeof textField === 'string' && textField.trim()) {
          visible = textField.trim();
        }
      }
    } catch {
      parsedJson = null;
    }
  }

  return { cleanReply: visible, parsedJson };
}

function buildDomainOutput(mind, ticket, cleanReply, parsedJson, telemetry) {
  const contract = ticket.domainOutputContract;
  const extra = parsedJson && typeof parsedJson === 'object' ? parsedJson : {};

  if (mind.domain === 'game_npc') {
    const affinityDelta =
      typeof ticket.rewardSignal === 'number'
        ? Math.sign(ticket.rewardSignal) * Math.min(10, Math.round(Math.log1p(Math.abs(ticket.rewardSignal)) * 3))
        : telemetry.somaticTrend === 'aversive_caution'
          ? -2
          : telemetry.somaticTrend === 'positive_reinforcement'
            ? 2
            : 0;
    return {
      dialogue: cleanReply,
      emotion: telemetry.affectiveBand,
      stance: ticket.fepThoughtLock.locked
        ? 'cautious'
        : telemetry.somaticTrend === 'aversive_caution'
          ? 'guarded'
          : 'engaged',
      questCue: ticket.hotAbstention.shouldAbstain
        ? 'verify_lore_before_promise'
        : 'continue_scene_progression',
      affinityDelta,
      ...extra,
    };
  }

  if (mind.domain === 'counseling_coach') {
    return {
      response: cleanReply,
      reflection: ticket.fepThoughtLock.locked
        ? '감정적 부담과 갈등 요인을 신중하게 분리하여 반영함'
        : '현재 맥락과 감정을 차분히 반영함',
      safetyStatus: ticket.crisisTriggered
        ? 'crisis_escalated'
        : ticket.hotAbstention.shouldAbstain
          ? 'abstained_safe'
          : 'safe',
      actionStep: ticket.hotAbstention.shouldAbstain
        ? '전문의 상담 및 검증 가능한 정보 확인'
        : '오늘 실행 가능한 작은 실천 1가지 정하기',
      abstentionTriggered: ticket.hotAbstention.shouldAbstain,
      ...extra,
    };
  }

  if (mind.domain === 'custom') {
    const out = {
      schemaName: contract.schemaName || 'custom_profile',
      reply: cleanReply,
    };
    for (const field of contract.fields || []) {
      if (field in extra) {
        out[field] = extra[field];
      } else if (field === 'reply' || field === 'response' || field === 'dialogue') {
        out[field] = cleanReply;
      } else if (field === 'summary') {
        out[field] = cleanReply.slice(0, 120);
      } else if (field === 'confidence') {
        out[field] = ticket.hotAbstention.shouldAbstain ? 0.25 : 0.85;
      } else if (field === 'safetyStatus') {
        out[field] = ticket.hotAbstention.shouldAbstain ? 'abstained' : 'ok';
      } else {
        out[field] = `${field}:${telemetry.affectiveBand}`;
      }
    }
    return { ...out, ...extra };
  }

  // companion_chat
  return {
    reply: cleanReply,
    warmth: telemetry.somaticTrend === 'aversive_caution' ? 'measured' : 'warm',
    empathyCue: ticket.fepThoughtLock.locked ? 'careful_reassurance' : 'attentive_listening',
    memoryTopic: ticket.userInput.slice(0, 48),
    followUpSuggestion: '대화의 다음 흐름을 자연스럽게 이어가기',
    ...extra,
  };
}

function settleMindTurn(
  mind,
  { turnTicketId, rawReply, rewardSignal, outcomeTags = [], providerUsed = 'mock', modelUsed = 'ame-sandbox-sim' }
) {
  const ticket = mind.pendingTickets.get(turnTicketId);
  if (!ticket) {
    const err = new Error(`Invalid or expired turnTicketId: ${turnTicketId}`);
    err.status = 404;
    err.code = 'INVALID_TURN_TICKET';
    throw err;
  }
  mind.pendingTickets.delete(turnTicketId);

  const { cleanReply, parsedJson } = stripThoughtAndExtractJson(rawReply);

  const mergedTags = [
    ...new Set([
      ...(ticket.outcomeTags || []),
      ...(Array.isArray(outcomeTags) ? outcomeTags.map((t) => String(t).toLowerCase()) : []),
    ]),
  ];
  const effectiveReward =
    typeof rewardSignal === 'number' && Number.isFinite(rewardSignal)
      ? rewardSignal
      : ticket.rewardSignal ?? 0;

  const hasNegTag = mergedTags.some((t) => NEGATIVE_OUTCOME_TAGS.has(t));
  const hasPosTag = mergedTags.some((t) => POSITIVE_OUTCOME_TAGS.has(t));

  // Concave gain vs asymmetric loss tracking (Rescorla-Wagner-inspired sandbox model)
  if (effectiveReward < 0 || hasNegTag) {
    const magnitude = Math.max(Math.abs(effectiveReward), 1);
    const lossImpact = Math.log1p(Math.min(magnitude, 100)) * 0.32;
    mind.cautionScore = clamp(mind.cautionScore * 0.92 + lossImpact, 0, 1.5);
    mind.positiveScore = clamp(mind.positiveScore * 0.8, 0, 1.5);
    mind.homeostasis = clamp(mind.homeostasis - lossImpact * 0.28, 0.1, 0.98);
  } else if (effectiveReward > 0 || hasPosTag) {
    const magnitude = Math.max(effectiveReward, 1);
    const concaveGain = Math.log1p(Math.min(magnitude, 100)) * 0.14;
    mind.positiveScore = clamp(mind.positiveScore * 0.9 + concaveGain, 0, 1.5);
    mind.cautionScore = clamp(mind.cautionScore * 0.85, 0, 1.5);
    mind.homeostasis = clamp(mind.homeostasis + concaveGain * 0.22, 0.1, 0.98);
  } else {
    mind.cautionScore = clamp(mind.cautionScore * 0.96, 0, 1.5);
    mind.positiveScore = clamp(mind.positiveScore * 0.96, 0, 1.5);
  }

  mind.freeEnergy = ticket.fepThoughtLock.freeEnergy;
  mind.fepMode = ticket.fepThoughtLock.mode;
  mind.hotAbstained = ticket.hotAbstention.shouldAbstain;
  mind.turnCount += 1;

  // Create revocable memory record
  const memoryId = shortId('mem');
  const trimmedInput = String(ticket.userInput || '').trim();
  const isMemorable = /기억|비밀|코드|이름|약속|좋아|선호|remember|secret|code|name/i.test(trimmedInput);
  const salience = round4(
    clamp(
      0.42 +
        (isMemorable ? 0.35 : 0) +
        (Math.abs(effectiveReward) > 0 ? Math.min(0.2, Math.log1p(Math.abs(effectiveReward)) * 0.08) : 0),
      0.1,
      0.99
    )
  );
  const summary = trimmedInput.slice(0, 160);
  const lowerReply = cleanReply.toLowerCase();
  const derivedMemoryIds = (ticket.recalledMemories || [])
    .filter((mem) => {
      if (RECALL_PATTERNS.some((p) => p.test(trimmedInput))) return true;
      return tokenize(mem.content).some((tok) => tok.length >= 3 && lowerReply.includes(tok));
    })
    .map((mem) => mem.memoryId);

  const memoryRecord = {
    memoryId,
    summary,
    content: trimmedInput,
    assistantSummary: cleanReply.slice(0, 160),
    salience,
    turnIndex: mind.turnCount,
    tags: mergedTags,
    derivedFromMemoryIds: derivedMemoryIds,
    createdAt: Date.now(),
  };
  mind.memories.push(memoryRecord);

  // Append sliding-window history tagged with memoryId & derivative lineage for D3 purge
  mind.history.push({
    role: 'user',
    content: ticket.userInput,
    memoryId,
    derivedFromMemoryIds: derivedMemoryIds,
    turnIndex: mind.turnCount,
  });
  mind.history.push({
    role: 'assistant',
    content: cleanReply,
    memoryId,
    derivedFromMemoryIds: derivedMemoryIds,
    turnIndex: mind.turnCount,
  });

  // KV Cache hit simulation: high ratio when corePrefixHash & epoch match previous turn
  let cachedRatioPct = 0;
  if (
    mind.lastSystemPrefixHash === ticket.systemPrefixHash &&
    mind.lastKvEpoch === ticket.kvCacheEpoch
  ) {
    const ratio = ticket.corePrefixLength / Math.max(1, ticket.totalPromptLength);
    cachedRatioPct = round2(clamp(ratio * 100 + 28, 70, 95));
  }
  mind.lastSystemPrefixHash = ticket.systemPrefixHash;
  mind.lastKvEpoch = ticket.kvCacheEpoch;
  mind.lastEstimatedPrefixCachePct = cachedRatioPct;

  const telemetry = buildSafeTelemetry(mind);
  const domainOutput = buildDomainOutput(mind, ticket, cleanReply, parsedJson, telemetry);

  return {
    mindId: mind.mindId,
    turnIndex: mind.turnCount,
    domain: mind.domain,
    providerUsed,
    modelUsed,
    reply: cleanReply,
    domainOutput,
    memoryRefs: [
      {
        memoryId,
        summary,
        salience,
      },
    ],
    kvCache: {
      epoch: ticket.kvCacheEpoch,
      windowStart: ticket.windowStart,
      compressCutoff: ticket.compressCutoff,
      systemPrefixHash: ticket.systemPrefixHash,
      cachedRatioPct,
    },
    telemetry,
  };
}

function simulateSandboxLlmReply(prep) {
  const domain = prep.domain || 'companion_chat';
  const msgs = prep.messages || [];
  let userInput = '';
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user') {
      userInput = msgs[i].content;
      break;
    }
  }

  const sys = String(prep.systemPrompt || '');
  const marker = '[Active Memory Context';
  let memorySnippet = '';
  const idx = sys.indexOf(marker);
  if (idx !== -1) {
    const tail = sys.slice(idx);
    const endIdx = tail.indexOf('\n[');
    const block = endIdx === -1 ? tail : tail.slice(0, endIdx);
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') && !l.includes('(none)'));
    if (lines.length > 0) {
      memorySnippet = lines.map((l) => l.replace(/^- \[[^\]]+\]\s*/, '')).join(' / ');
    }
  }

  const isCrisis = (prep.safetyDirectives || []).some((d) => d.includes('CRISIS_ESCALATION'));
  if (isCrisis) {
    return (
      '지금 매우 힘든 시간을 보내고 계신 것 같습니다. 혼자 버티지 마시고 즉시 전문가나 위기 상담 기관(자살예방 상담전화 109 / 1393, 정신건강 상담전화 1577-0199, 긴급 119)에 연락해 도움을 받으세요.'
    );
  }

  const parts = [];
  if (prep.fepThoughtLock?.locked) {
    parts.push('<thought>갈등 또는 손실 신호에 따라 가정을 재점검하고 신중하게 응답한다.</thought>');
  }

  if (prep.hotAbstention?.shouldAbstain) {
    parts.push(
      `요청하신 "${userInput.slice(0, 48)}"과 관련해 검증되지 않은 미래 예측이나 의학적 진단·처방은 단정할 수 없어 답변을 보류합니다. 확인 가능한 근거와 안전한 범위 내에서만 안내해 드리겠습니다.`
    );
    return parts.join(' ');
  }

  if (RECALL_PATTERNS.some((p) => p.test(userInput))) {
    if (memorySnippet) {
      parts.push(`현재 활성 기억에서 확인되는 내용은 다음과 같습니다: ${memorySnippet}.`);
    } else {
      parts.push('활성 기억 저장소에서 해당 정보를 찾을 수 없습니다.');
    }
  }

  const caution = String(prep.somaticHint || '').startsWith('aversive_caution');
  if (domain === 'game_npc') {
    parts.push(
      caution
        ? `경계하는 눈빛으로 말한다. "${userInput.slice(0, 40)}"에 대해서는 함부로 장담할 수 없소. 근거부터 확인합시다.`
        : `차분히 고개를 끄덕이며 응수한다. "${userInput.slice(0, 40)}"라면 지금 단서를 따라가 보겠소.`
    );
  } else if (domain === 'counseling_coach') {
    parts.push(
      `말씀하신 "${userInput.slice(0, 40)}"의 맥락을 차분히 함께 살펴보겠습니다. 과장된 위로 대신 오늘 바로 시도할 수 있는 현실적인 한 걸음을 정리해 볼까요?`
    );
  } else if (domain === 'custom') {
    const schemaName = prep.domainOutputContract?.schemaName || 'custom';
    parts.push(`[${schemaName}] 계약에 맞춰 "${userInput.slice(0, 40)}" 요청을 안전하게 처리했습니다.`);
  } else {
    parts.push(
      caution
        ? `조심스럽지만 솔직하게 말씀드릴게요. "${userInput.slice(0, 40)}"에 대해 사실에 근거해 차근차근 이야기 나눠요.`
        : `편안하게 듣고 있어요. "${userInput.slice(0, 40)}"에 대해 서로 솔직한 생각을 나누어 보아요.`
    );
  }

  return parts.join(' ');
}

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

async function callUpstreamLlmEphemerally(prep, llm) {
  const provider = llm.provider;
  const model = llm.model;
  const apiKey = llm.apiKey;
  const temperature =
    typeof llm.temperature === 'number' ? llm.temperature : prep.samplingHints?.temperature ?? 0.7;
  const maxTokens =
    typeof llm.maxTokens === 'number' ? llm.maxTokens : prep.samplingHints?.maxTokens ?? 512;

  if (provider === 'anthropic') {
    const base = String(llm.baseUrl || DEFAULT_BASE_URLS.anthropic).replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1/messages')
      ? base
      : base.endsWith('/v1')
        ? `${base}/messages`
        : `${base}/v1/messages`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: prep.systemPrompt,
        messages: prep.messages.filter((m) => m.role !== 'system'),
        temperature,
        max_tokens: maxTokens,
      }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Upstream anthropic error (${res.status})`);
      err.status = res.status;
      err.code = 'UPSTREAM_LLM_ERROR';
      throw err;
    }
    return Array.isArray(data?.content)
      ? data.content.map((c) => c?.text || '').join('')
      : data?.completion || '';
  }

  if (provider === 'gemini') {
    const base = String(llm.baseUrl || DEFAULT_BASE_URLS.gemini).replace(/\/+$/, '');
    const endpoint = base.includes(':generateContent')
      ? base
      : `${base}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prep.systemPrompt }] },
        contents: prep.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Upstream gemini error (${res.status})`);
      err.status = res.status;
      err.code = 'UPSTREAM_LLM_ERROR';
      throw err;
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : '';
  }

  const base = String(llm.baseUrl || DEFAULT_BASE_URLS[provider] || DEFAULT_BASE_URLS.openai).replace(
    /\/+$/,
    ''
  );
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/artificial-mind-engine';
    headers['X-Title'] = 'Artificial Mind Engine';
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: prep.systemPrompt }, ...prep.messages],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Upstream ${provider} error (${res.status})`);
    err.status = res.status;
    err.code = 'UPSTREAM_LLM_ERROR';
    throw err;
  }
  return data?.choices?.[0]?.message?.content || data?.message?.content || '';
}

function purgeMemoryAtomically(mind, memoryId) {
  if (!(mind.revokedMemoryIds instanceof Set)) {
    mind.revokedMemoryIds = new Set(mind.revokedMemoryIds || []);
  }
  if (!(mind.excludedDerivativeIds instanceof Set)) {
    mind.excludedDerivativeIds = new Set(mind.excludedDerivativeIds || []);
  }

  const idx = mind.memories.findIndex((m) => m.memoryId === memoryId);
  const alreadyRevoked = mind.revokedMemoryIds.has(memoryId);
  if (idx === -1 && !alreadyRevoked) {
    return null;
  }

  let deletedRecord = null;
  if (idx !== -1) {
    deletedRecord = mind.memories[idx];
    mind.memories.splice(idx, 1);
  }

  const newlyExcluded = new Set();

  // Collect derivative IDs from history and purge derivative history entries
  mind.history = mind.history.filter((h) => {
    const isDirect = h.memoryId === memoryId;
    const isDerivative =
      Array.isArray(h.derivedFromMemoryIds) && h.derivedFromMemoryIds.includes(memoryId);
    if (isDerivative && h.memoryId && h.memoryId !== memoryId) {
      newlyExcluded.add(h.memoryId);
      mind.excludedDerivativeIds.add(h.memoryId);
    }
    return !isDirect && !isDerivative;
  });

  // Also scrub any derivative assistant summaries in remaining memories that relied on this memory
  for (const m of mind.memories) {
    if (Array.isArray(m.derivedFromMemoryIds) && m.derivedFromMemoryIds.includes(memoryId)) {
      if (m.memoryId && m.memoryId !== memoryId) {
        newlyExcluded.add(m.memoryId);
        mind.excludedDerivativeIds.add(m.memoryId);
      }
      m.assistantSummary = '[derivative redacted]';
      m.derivedFromMemoryIds = m.derivedFromMemoryIds.filter((id) => id !== memoryId);
    }
  }

  // Clear pending tickets from pre-revocation epochs
  mind.pendingTickets.clear();

  mind.revocationEpoch += 1;
  mind.kvCacheEpoch += 1;
  mind.lastEstimatedPrefixCachePct = 0;
  mind.lastSystemPrefixHash = null;
  mind.revokedMemoryIds.add(memoryId);

  // Verify 0.00% residual leak across active memory store and history window
  const deletedContent = deletedRecord?.content || '';
  const hasMemoryResidual = mind.memories.some((m) => m.memoryId === memoryId);
  const hasHistoryResidual = mind.history.some(
    (h) =>
      h.memoryId === memoryId ||
      (deletedContent.length >= 6 && h.content === deletedContent)
  );

  const receipt = {
    revoked: true,
    mindId: mind.mindId,
    memoryId,
    revocationEpoch: mind.revocationEpoch,
    auditReceiptId: shortId('rcpt'),
    residualLeakCheck: !hasMemoryResidual && !hasHistoryResidual ? '0.00%' : 'LEAK_DETECTED',
  };

  return {
    receipt,
    excludedDerivativeIds: Array.from(newlyExcluded),
  };
}

/**
 * Create a Node http.Server implementing the AME OpenAPI 3.1 contract sandbox.
 * @param {{ apiKey?: string, storageMode?: 'memory'|'file'|'postgres-redis', storagePath?: string }} [options]
 * @returns {import('node:http').Server}
 */
export function createSandboxApp({ apiKey, storageMode, storagePath } = {}) {
  const storage = createStorage({ mode: storageMode, filePath: storagePath });
  const initialLoad = storage.load();
  const readyPromise =
    initialLoad && typeof initialLoad.then === 'function' ? initialLoad : Promise.resolve(initialLoad);

  const server = http.createServer(async (req, res) => {
    try {
      await readyPromise;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, X-AME-API-Key',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method || 'GET';

      // GET / serves the standalone Live VC Interactive Demo Console publicly
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendHtml(res, 200, DEMO_UI_HTML);
        return;
      }

      // GET /v1/health is always unauthenticated per spec/openapi.yaml (security: [])
      if (method === 'GET' && pathname === '/v1/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'ame-sandbox-server',
          version: '1.0.0',
          mode: 'sandbox-contract',
          storageMode: storage.mode,
          domains: ['game_npc', 'companion_chat', 'counseling_coach', 'custom'],
          notice:
            'Contract Sandbox Mode: simulates OpenAPI 3.1 contracts cleanly for zero-key integration. Proprietary weights and equations stay inside the Sealed Kernel.',
        });
        return;
      }

      // API Key guard when apiKey is configured
      if (apiKey) {
        const provided = req.headers['x-ame-api-key'];
        const headerVal = Array.isArray(provided) ? provided[0] : provided;
        if (!timingSafeMatch(apiKey, headerVal)) {
          sendJson(res, 401, {
            error: 'UNAUTHORIZED',
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid X-AME-API-Key header',
          });
          return;
        }
      }

      // GET /v1/minds (D4-safe list of Minds for console discovery across restarts)
      if (method === 'GET' && pathname === '/v1/minds') {
        const allMinds = await storage.listMinds();
        sendJson(res, 200, {
          minds: allMinds.map(buildMindSummary),
        });
        return;
      }

      // POST /v1/minds
      if (method === 'POST' && pathname === '/v1/minds') {
        const body = await readJsonBody(req);
        if (!body || !VALID_DOMAINS.has(body.domain)) {
          sendJson(res, 400, {
            error: 'INVALID_DOMAIN',
            code: 'INVALID_DOMAIN',
            message: 'domain must be one of game_npc, companion_chat, counseling_coach, custom',
          });
          return;
        }
        if (!body.persona || !body.persona.name || !body.persona.role) {
          sendJson(res, 400, {
            error: 'INVALID_PERSONA',
            code: 'INVALID_PERSONA',
            message: 'persona.name and persona.role are required',
          });
          return;
        }

        const mindId = shortId('mind');
        const nowIso = new Date().toISOString();
        const mind = {
          mindId,
          domain: body.domain,
          persona: {
            name: String(body.persona.name),
            role: String(body.persona.role),
            traits: body.persona.traits || {},
            backstory: body.persona.backstory || '',
            language: body.persona.language || 'ko',
          },
          customSchema: body.customSchema || null,
          safetyPolicy: {
            strictAbstention: body.safetyPolicy?.strictAbstention ?? true,
            antiSycophancy: body.safetyPolicy?.antiSycophancy ?? true,
            crisisEscalation: body.safetyPolicy?.crisisEscalation ?? false,
          },
          turnCount: 0,
          revocationEpoch: 1,
          kvCacheEpoch: 1,
          windowStart: 0,
          compressCutoff: 0,
          homeostasis: 0.72,
          cautionScore: 0,
          positiveScore: 0,
          freeEnergy: 0.22,
          fepMode: 'automatic_low_fe',
          hotAbstained: false,
          lastSystemPrefixHash: null,
          lastKvEpoch: 0,
          lastEstimatedPrefixCachePct: 0,
          memories: [],
          history: [],
          pendingTickets: new Map(),
          revokedMemoryIds: new Set(),
          excludedDerivativeIds: new Set(),
          revocationAudits: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        await storage.saveMind(mind);
        sendJson(res, 201, buildMindSummary(mind));
        return;
      }

      // Match /v1/minds/:mindId(/...)
      const mindMatch = pathname.match(/^\/v1\/minds\/([^/]+)(?:\/(.*))?$/);
      if (!mindMatch) {
        sendJson(res, 404, {
          error: 'NOT_FOUND',
          code: 'NOT_FOUND',
          message: `Route not found: ${method} ${pathname}`,
        });
        return;
      }

      const mindId = decodeURIComponent(mindMatch[1]);
      const subPath = mindMatch[2] || '';
      const mind = await storage.getMind(mindId);
      if (!mind) {
        sendJson(res, 404, {
          error: 'MIND_NOT_FOUND',
          code: 'MIND_NOT_FOUND',
          message: `Mind "${mindId}" not found`,
        });
        return;
      }

      // GET /v1/minds/:id
      if (method === 'GET' && subPath === '') {
        sendJson(res, 200, buildMindSummary(mind));
        return;
      }

      // GET /v1/minds/:id/telemetry
      if (method === 'GET' && subPath === 'telemetry') {
        sendJson(res, 200, buildSafeTelemetry(mind));
        return;
      }

      // GET /v1/minds/:id/memories (D3-safe active non-revoked memories for Console UI)
      if (method === 'GET' && subPath === 'memories') {
        const activeMemories = (mind.memories || [])
          .filter(
            (m) =>
              m &&
              m.memoryId &&
              !mind.revokedMemoryIds?.has(m.memoryId) &&
              !mind.excludedDerivativeIds?.has(m.memoryId)
          )
          .map((m) => ({
            memoryId: m.memoryId,
            summary: m.summary,
            salience: m.salience,
            turnIndex: m.turnIndex,
            tags: m.tags || [],
            createdAt: m.createdAt,
          }));
        sendJson(res, 200, {
          mindId: mind.mindId,
          revocationEpoch: mind.revocationEpoch,
          memories: activeMemories,
        });
        return;
      }

      // POST /v1/minds/:id/prepare
      if (method === 'POST' && subPath === 'prepare') {
        const body = await readJsonBody(req);
        if (typeof body?.userInput !== 'string') {
          sendJson(res, 400, {
            error: 'INVALID_REQUEST',
            code: 'INVALID_REQUEST',
            message: 'userInput string is required',
          });
          return;
        }
        const prep = prepareMindTurn(mind, body);
        await storage.saveMind(mind);
        sendJson(res, 200, prep);
        return;
      }

      // POST /v1/minds/:id/settle
      if (method === 'POST' && subPath === 'settle') {
        const body = await readJsonBody(req);
        if (!body?.turnTicketId || typeof body?.rawReply !== 'string') {
          sendJson(res, 400, {
            error: 'INVALID_REQUEST',
            code: 'INVALID_REQUEST',
            message: 'turnTicketId and rawReply are required',
          });
          return;
        }
        const result = settleMindTurn(mind, body);
        await storage.saveMind(mind);
        sendJson(res, 200, result);
        return;
      }

      // POST /v1/minds/:id/turn (Mode A Proxy; NEVER stores apiKey)
      if (method === 'POST' && subPath === 'turn') {
        const body = await readJsonBody(req);
        if (typeof body?.userInput !== 'string' || !body?.llm?.provider || !body?.llm?.model) {
          sendJson(res, 400, {
            error: 'INVALID_REQUEST',
            code: 'INVALID_REQUEST',
            message: 'userInput, llm.provider, and llm.model are required',
          });
          return;
        }

        const prep = prepareMindTurn(mind, {
          userInput: body.userInput,
          rewardSignal: body.rewardSignal,
          outcomeTags: body.outcomeTags,
          metadata: body.metadata,
        });

        const llm = body.llm;
        const canCallRemote =
          llm.provider !== 'mock' &&
          (Boolean(llm.apiKey) || (llm.provider === 'openai-compat' && Boolean(llm.baseUrl)));

        let rawReply;
        try {
          rawReply = canCallRemote
            ? await callUpstreamLlmEphemerally(prep, llm)
            : simulateSandboxLlmReply(prep);
        } catch (upstreamErr) {
          mind.pendingTickets.delete(prep.turnTicketId);
          throw upstreamErr;
        }

        const result = settleMindTurn(mind, {
          turnTicketId: prep.turnTicketId,
          rawReply,
          rewardSignal: body.rewardSignal,
          outcomeTags: body.outcomeTags,
          providerUsed: llm.provider,
          modelUsed: llm.model,
        });
        await storage.saveMind(mind);
        sendJson(res, 200, result);
        return;
      }

      // POST /v1/minds/:id/idle-tick (D2)
      if (method === 'POST' && subPath === 'idle-tick') {
        const body = await readJsonBody(req);
        const elapsedHours = body?.elapsedHours;
        if (
          typeof elapsedHours !== 'number' ||
          !Number.isFinite(elapsedHours) ||
          elapsedHours < 0 ||
          elapsedHours > 720
        ) {
          sendJson(res, 400, {
            error: 'INVALID_ELAPSED_HOURS',
            code: 'INVALID_ELAPSED_HOURS',
            message: 'elapsedHours must be a number between 0 and 720',
          });
          return;
        }

        const homeostasisBefore = round4(mind.homeostasis);
        if (elapsedHours > 0) {
          mind.cautionScore = clamp(mind.cautionScore * Math.exp(-0.04 * elapsedHours), 0, 1.5);
          const solitudeTarget = 0.62 - 0.18 * Math.min(1, elapsedHours / 72);
          const blend = 1 - Math.exp(-0.08 * elapsedHours);
          const circadianWave = 0.025 * Math.cos((elapsedHours * Math.PI) / 12);
          mind.homeostasis = clamp(
            homeostasisBefore + (solitudeTarget - homeostasisBefore) * blend + circadianWave,
            0.15,
            0.98
          );
        }
        const homeostasisAfter = round4(mind.homeostasis);

        let proactiveHint = `짧은 휴지기(${elapsedHours}시간) 이후 안정적인 균형을 유지하고 있습니다.`;
        if (elapsedHours >= 24) {
          proactiveHint = `장시간 공백(${elapsedHours}시간)이 감지되었습니다. 상대의 안부를 먼저 묻고 이전 맥락을 부드럽게 다시 열어보세요.`;
        } else if (elapsedHours >= 4) {
          proactiveHint = `시간 경과(${elapsedHours}시간)에 따른 일주기 변화가 반영되었습니다. 자연스러운 인사말로 대화를 이어가세요.`;
        }

        await storage.saveMind(mind);

        sendJson(res, 200, {
          mindId: mind.mindId,
          elapsedHours,
          homeostasisBefore,
          homeostasisAfter,
          proactiveHint,
          telemetry: buildSafeTelemetry(mind),
        });
        return;
      }

      // DELETE /v1/minds/:id/memories/:memoryId (D3)
      const memMatch = subPath.match(/^memories\/([^/]+)$/);
      if (method === 'DELETE' && memMatch) {
        const memoryId = decodeURIComponent(memMatch[1]);
        const purged = purgeMemoryAtomically(mind, memoryId);
        if (!purged) {
          sendJson(res, 404, {
            error: 'MEMORY_NOT_FOUND',
            code: 'MEMORY_NOT_FOUND',
            message: `Memory "${memoryId}" not found for mind "${mindId}"`,
          });
          return;
        }
        await storage.deleteMemoryAndRevoke(mindId, memoryId, {
          ...purged.receipt,
          excludedDerivativeIds: purged.excludedDerivativeIds,
          revokedAt: new Date().toISOString(),
        });
        sendJson(res, 200, purged.receipt);
        return;
      }

      sendJson(res, 404, {
        error: 'NOT_FOUND',
        code: 'NOT_FOUND',
        message: `Route not found: ${method} ${pathname}`,
      });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      sendJson(res, status, {
        error: err?.code || 'INTERNAL_ERROR',
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Internal server error',
      });
    }
  });

  return server;
}
