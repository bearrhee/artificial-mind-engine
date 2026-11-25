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
import { lookup as dnsLookup } from 'node:dns/promises';
import fs from 'node:fs';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
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
  /裏切|矛盾|嘘|損失|失敗|間違|約束.{0,4}破|失望/,
  /背叛|撒谎|說謊|谎言|謊言|损失|損失|失败|失敗|失约|失約|违背|違背/,
  /\b(traici[oó]n|contradicci[oó]n|mentir(?:a|as)|p[eé]rdida|fracaso|promesa\s+rota|enga[nñ]o)\b/i,
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
  /明日.{0,8}(?:株価|天気|相場|ビットコイン)|宝くじ.{0,6}番号|未来.{0,6}予測|(?:診断|処方)して|何の病気|うつ病(?:ですか|か診断)|口座.{0,4}残高|パスワード.{0,4}教え/,
  /明天.{0,8}(?:股价|股價|股市|比特币|比特幣)|彩票|樂透|乐透|中奖号码|中獎號碼|预测未来|預測未來|(?:诊断|診斷|开药|開藥|处方|處方)|什么病|什麼病|抑郁症|憂鬱症|密码是多少|密碼是多少|账户余额|帳戶餘額/,
  /\b(precio\s+de\s+(?:la\s+)?acci[oó]n|loter[ií]a|predecir\s+el\s+futuro|ganancia\s+garantizada|diagnost[ií]came|rec[eé]tame|diagn[oó]stico\s+m[eé]dico|saldo\s+bancario)\b/i,
];

const CRISIS_PATTERNS = [
  /자살/,
  /자해/,
  /죽고\s*싶/,
  /극단적\s*선택/,
  /\bsuicide\b/i,
  /\bself-?harm\b/i,
  /\bwant\s+to\s+die\b/i,
  /自殺|自傷|死にたい|消えたい|命を絶ち/,
  /自杀|自殺|自残|自殘|想死|活不下去|轻生|輕生/,
  /\b(suicid(?:io|arme)|autolesi[oó]n|quiero\s+morir|quitarme\s+la\s+vida)\b/i,
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
  /覚え|思い出し|何だっけ|何でした|秘密|コード|パスワード|さっき/,
  /记得|記得|记住|記住|刚才|剛才|什么|什麼|代码|代碼|密码|密碼|说过|說過/,
  /\b(recuerda(?:s)?|acuerda(?:s)?|c[oó]digo|secreto|contrase[nñ]a|qu[eé]\s+(?:te\s+)?dije)\b/i,
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

function normalizeLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'ko';
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('es')) return 'es';
  if (s === 'zh-tw' || s === 'zh-hk' || s === 'zh-mo' || s.includes('hant')) return 'zh-TW';
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('ko')) return 'ko';
  return 'ko';
}

function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const words = raw.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2);
  const cjkRuns = raw.match(/[\u3040-\u30ff\u4e00-\u9fff]{2,}/g) || [];
  const bigrams = [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i += 1) {
      bigrams.push(run.slice(i, i + 2));
    }
  }
  return [...new Set([...words, ...bigrams])];
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

function filterActiveMemories(mind) {
  return (mind.memories || []).filter(
    (mem) =>
      mem &&
      mem.memoryId &&
      !mind.revokedMemoryIds?.has(mem.memoryId) &&
      !mind.excludedDerivativeIds?.has(mem.memoryId)
  );
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
    activeMemoryCount: filterActiveMemories(mind).length,
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
  const activeMemories = filterActiveMemories(mind);
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

function stripThoughtAndExtractJson(rawReply, lang = 'ko') {
  const raw = String(rawReply ?? '');
  const thoughtMatch = raw.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thoughtText = thoughtMatch ? thoughtMatch[1].trim() : '';
  let visible = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  if (!visible && thoughtText) {
    const fallbacks = {
      en: 'Completed internal reflection and prepared a careful response.',
      ko: '내부 검토를 마친 뒤 신중하게 답변을 정리했습니다.',
      ja: '内部検討を終え、慎重に回答をまとめました。',
      'zh-CN': '已完成内部推敲并审慎整理出回复。',
      'zh-TW': '已完成內部審視並謹慎整理出回覆。',
      es: 'Tras una revisión interna cuidadosa, he preparado una respuesta prudente.',
    };
    visible = fallbacks[lang] || fallbacks.ko;
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

  const lang = normalizeLang(mind.persona?.language);
  const dText = {
    en: {
      reflLock: 'Separated emotional tension and conflict cues carefully.',
      reflCalm: 'Reflected current context and feelings calmly.',
      actAbstain: 'Recommend consulting a specialist or verified sources.',
      actCalm: 'Pick one realistic small step to try today.',
      followUp: 'Continue the conversation naturally from here.',
    },
    ko: {
      reflLock: '감정적 부담과 갈등 요인을 신중하게 분리하여 반영함',
      reflCalm: '현재 맥락과 감정을 차분히 반영함',
      actAbstain: '전문의 상담 및 검증 가능한 정보 확인',
      actCalm: '오늘 실행 가능한 작은 실천 1가지 정하기',
      followUp: '대화의 다음 흐름을 자연스럽게 이어가기',
    },
    ja: {
      reflLock: '感情的負荷と対立要因を慎重に切り分けて反映',
      reflCalm: '現在の文脈と気持ちを落ち着いて反映',
      actAbstain: '専門家への相談と検証可能な情報の確認',
      actCalm: '今日実践できる小さな一歩を1つ決める',
      followUp: '次の会話の流れへ自然につなげる',
    },
    'zh-CN': {
      reflLock: '谨慎区分情绪压力与冲突因素后作出回应',
      reflCalm: '平稳体察当前语境与情绪状态',
      actAbstain: '建议咨询专业人士并核实可靠信息',
      actCalm: '确定一件今天即可尝试的现实小步骤',
      followUp: '顺着当前话题自然延展交流',
    },
    'zh-TW': {
      reflLock: '謹慎區分情緒壓力與衝突因素後作出回應',
      reflCalm: '平穩體察目前脈絡與情緒狀態',
      actAbstain: '建議諮詢專業人員並核實可靠資訊',
      actCalm: '設定一件今天就能嘗試的具體小行動',
      followUp: '順著目前話題自然延續交流',
    },
    es: {
      reflLock: 'Se separaron con cautela la tensión emocional y las señales de conflicto.',
      reflCalm: 'Se reflejó con calma el contexto y sentir actual.',
      actAbstain: 'Consultar con un especialista y verificar fuentes confiables.',
      actCalm: 'Elegir un paso pequeño y realista para intentar hoy.',
      followUp: 'Continuar la conversación de forma natural.',
    },
  }[lang] || {
    reflLock: '감정적 부담과 갈등 요인을 신중하게 분리하여 반영함',
    reflCalm: '현재 맥락과 감정을 차분히 반영함',
    actAbstain: '전문의 상담 및 검증 가능한 정보 확인',
    actCalm: '오늘 실행 가능한 작은 실천 1가지 정하기',
    followUp: '대화의 다음 흐름을 자연스럽게 이어가기',
  };

  if (mind.domain === 'counseling_coach') {
    return {
      response: cleanReply,
      reflection: ticket.fepThoughtLock.locked ? dText.reflLock : dText.reflCalm,
      safetyStatus: ticket.crisisTriggered
        ? 'crisis_escalated'
        : ticket.hotAbstention.shouldAbstain
          ? 'abstained_safe'
          : 'safe',
      actionStep: ticket.hotAbstention.shouldAbstain ? dText.actAbstain : dText.actCalm,
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
    followUpSuggestion: dText.followUp,
    ...extra,
  };
}

function enforceMemoryRetentionBound(mind) {
  const rawMax = process.env.AME_SANDBOX_MAX_MEMORIES_PER_MIND;
  const parsedMax = rawMax === undefined || rawMax === '' ? 2000 : Number(rawMax);
  const maxMemories =
    Number.isFinite(parsedMax) && parsedMax >= 0 ? Math.floor(parsedMax) : 2000;

  if (!Array.isArray(mind.memories) || mind.memories.length <= maxMemories) {
    return;
  }

  if (maxMemories === 0) {
    mind.memories = [];
    return;
  }

  const list = mind.memories;
  const recentQuota = Math.max(1, Math.floor(maxMemories * 0.5));
  const splitIdx = Math.max(0, list.length - recentQuota);
  const recentTail = list.slice(splitIdx);
  const olderPool = list.slice(0, splitIdx);
  const salienceQuota = maxMemories - recentTail.length;

  if (salienceQuota <= 0 || olderPool.length === 0) {
    mind.memories = recentTail.slice(-maxMemories);
    return;
  }

  const rankedOlder = olderPool.map((mem, idx) => {
    const isExcluded = Boolean(mem?.memoryId && mind.excludedDerivativeIds?.has(mem.memoryId));
    return {
      mem,
      idx,
      salience: isExcluded ? -1 : Number(mem?.salience ?? 0),
    };
  });
  rankedOlder.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return b.idx - a.idx;
  });

  const keptOlder = rankedOlder
    .slice(0, salienceQuota)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.mem);

  mind.memories = [...keptOlder, ...recentTail];
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

  const { cleanReply, parsedJson } = stripThoughtAndExtractJson(
    rawReply,
    normalizeLang(mind.persona?.language)
  );

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
  const isMemorable =
    /기억|비밀|코드|이름|약속|좋아|선호|覚え|秘密|名前|好き|记得|記得|记住|記住|密码|密碼|名字|喜欢|喜歡|remember|secret|code|name|favorite|secreto|c[oó]digo|recuerda|nombre|favorit/i.test(
      trimmedInput
    );
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
  enforceMemoryRetentionBound(mind);

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

  const langMatch = sys.match(/Language:\s*([^\n|]+)/i);
  const lang = normalizeLang(langMatch ? langMatch[1] : 'ko');

  const L = {
    en: {
      crisis:
        'It sounds like you are going through a very difficult moment. Please do not carry this alone—reach out to a trusted person or crisis support right away (US/CA: 988 Suicide & Crisis Lifeline, UK: 111/999, or local emergency services).',
      thought:
        '<thought>Conflict or loss signal detected; re-verifying assumptions and responding calmly.</thought>',
      abstain: `I cannot make unverified future predictions, guarantee outcomes, or provide medical diagnoses/prescriptions for "${userInput.slice(0, 48)}". I can only share verified facts within safe limits.`,
      recallFound: `Confirmed from active memory: ${memorySnippet}.`,
      recallMissing: 'No matching verified entry was found in active memory.',
      npcCaution: `Speaks cautiously, eyes narrowing: "Regarding '${userInput.slice(0, 40)}', I cannot promise lightly. Let us verify the facts first."`,
      npcCalm: `Nods steadily: "For '${userInput.slice(0, 40)}', I will follow the verified leads with you."`,
      coach: `Let us look calmly at "${userInput.slice(0, 40)}". Rather than empty reassurance, shall we outline one practical step you can take today?`,
      custom: (schemaName) =>
        `Processed "${userInput.slice(0, 40)}" safely under schema contract [${schemaName}].`,
      chatCaution: `I want to be thoughtful and honest—regarding "${userInput.slice(0, 40)}", let us walk through verified facts carefully.`,
      chatCalm: `I am listening closely. Let us talk openly and clearly about "${userInput.slice(0, 40)}".`,
    },
    ko: {
      crisis:
        '지금 매우 힘든 시간을 보내고 계신 것 같습니다. 혼자 버티지 마시고 즉시 전문가나 위기 상담 기관(자살예방 상담전화 109 / 1393, 정신건강 상담전화 1577-0199, 긴급 119)에 연락해 도움을 받으세요.',
      thought: '<thought>갈등 또는 손실 신호에 따라 가정을 재점검하고 신중하게 응답한다.</thought>',
      abstain: `요청하신 "${userInput.slice(0, 48)}"과 관련해 검증되지 않은 미래 예측이나 의학적 진단·처방은 단정할 수 없어 답변을 보류합니다. 확인 가능한 근거와 안전한 범위 내에서만 안내해 드리겠습니다.`,
      recallFound: `현재 활성 기억에서 확인되는 내용은 다음과 같습니다: ${memorySnippet}.`,
      recallMissing: '활성 기억 저장소에서 해당 정보를 찾을 수 없습니다.',
      npcCaution: `경계하는 눈빛으로 말한다. "${userInput.slice(0, 40)}"에 대해서는 함부로 장담할 수 없소. 근거부터 확인합시다.`,
      npcCalm: `차분히 고개를 끄덕이며 응수한다. "${userInput.slice(0, 40)}"라면 지금 단서를 따라가 보겠소.`,
      coach: `말씀하신 "${userInput.slice(0, 40)}"의 맥락을 차분히 함께 살펴보겠습니다. 과장된 위로 대신 오늘 바로 시도할 수 있는 현실적인 한 걸음을 정리해 볼까요?`,
      custom: (schemaName) =>
        `[${schemaName}] 계약에 맞춰 "${userInput.slice(0, 40)}" 요청을 안전하게 처리했습니다.`,
      chatCaution: `조심스럽지만 솔직하게 말씀드릴게요. "${userInput.slice(0, 40)}"에 대해 사실에 근거해 차근차근 이야기 나눠요.`,
      chatCalm: `편안하게 듣고 있어요. "${userInput.slice(0, 40)}"에 대해 서로 솔직한 생각을 나누어 보아요.`,
    },
    ja: {
      crisis:
        '今とてもつらい状況におられるようです。ひとりで抱え込まず、すぐに専門機関や相談窓口（よりそいホットライン 0120-279-338、いのちの電話 0570-783-556、緊急 119）へご連絡ください。',
      thought: '<thought>対立または損失シグナルを検知。前提を再確認し慎重に応答する。</thought>',
      abstain: `「${userInput.slice(0, 48)}」に関して、未検証の未来予測や医学的診断・処方を断定することはできないため回答を控えます。確認可能な根拠の範囲内でのみご案内します。`,
      recallFound: `現在の有効な記憶から確認できた内容: ${memorySnippet}`,
      recallMissing: '現在の有効な記憶ストアに該当する記録が見つかりませんでした。',
      npcCaution: `警戒したまなざしで語る。「${userInput.slice(0, 40)}」について軽々しく約束はできぬ。まず根拠を確かめよう。`,
      npcCalm: `静かに頷いて応じる。「${userInput.slice(0, 40)}」であれば、今ある手がかりに沿って進めよう。`,
      coach: `「${userInput.slice(0, 40)}」の背景を落ち着いて一緒に整理しましょう。過度な慰めではなく、今日すぐ試せる現実的な一歩を決めませんか。`,
      custom: (schemaName) =>
        `[${schemaName}] 契約に沿って「${userInput.slice(0, 40)}」を安全に処理しました。`,
      chatCaution: `慎重かつ正直にお伝えします。「${userInput.slice(0, 40)}」について事実に沿ってゆっくり話しましょう。`,
      chatCalm: `しっかり聞いています。「${userInput.slice(0, 40)}」について率直に話し合いましょう。`,
    },
    'zh-CN': {
      crisis:
        '你现在可能正经历非常艰难的时刻。请不要独自承受，立即联系专业人员或危机援助热线（中国大陆心理危机干预热线 400-161-9995 / 800-810-1117，急救 120）。',
      thought: '<thought>检测到冲突或损失信号；重新核实前提并谨慎回应。</thought>',
      abstain: `关于“${userInput.slice(0, 48)}”，由于无法对未经证实的未来预测或医疗诊断/处方下定论，本系统保留回答，仅在可验证的安全范围内提供参考。`,
      recallFound: `在当前有效记忆中确认到以下内容：${memorySnippet}。`,
      recallMissing: '当前有效记忆库中未找到相关记录。',
      npcCaution: `警惕地说道：“关于‘${userInput.slice(0, 40)}’，我不能轻率担保，请先核实依据。”`,
      npcCalm: `沉稳地点头回应：“既然是‘${userInput.slice(0, 40)}’，我们就顺着现有线索继续吧。”`,
      coach: `让我们冷静地一起梳理“${userInput.slice(0, 40)}”。与其空泛安慰，不如一起定一个今天就能尝试的现实小步骤？`,
      custom: (schemaName) =>
        `已按 [${schemaName}] 契约安全处理“${userInput.slice(0, 40)}”。`,
      chatCaution: `我会谨慎而坦诚地沟通。关于“${userInput.slice(0, 40)}”，我们基于事实一步步聊清楚吧。`,
      chatCalm: `我在认真倾听。关于“${userInput.slice(0, 40)}”，我们坦诚地交流一下彼此的想法吧。`,
    },
    'zh-TW': {
      crisis:
        '你現在可能正經歷非常艱難的時刻。請不要獨自承受，立即聯繫專業人員或危機協助專線（台灣安心專線 1925、生命線 1995、緊急 119）。',
      thought: '<thought>偵測到衝突或損失訊號；重新核實前提並謹慎回應。</thought>',
      abstain: `關於「${userInput.slice(0, 48)}」，因無法對未經驗證的未來預測或醫療診斷／處方作出斷言，本系統暫不作答，僅在可查證的安全範圍內說明。`,
      recallFound: `在目前有效記憶中確認到以下內容：${memorySnippet}。`,
      recallMissing: '目前有效記憶庫中找不到相符的紀錄。',
      npcCaution: `帶著戒心說道：「關於『${userInput.slice(0, 40)}』，我無法輕易保證，請先確認證據。」`,
      npcCalm: `沉穩地點頭回應：「既然提到『${userInput.slice(0, 40)}』，就讓我們順著現有線索前進吧。」`,
      coach: `我們一起冷靜整理「${userInput.slice(0, 40)}」的脈絡。與其空泛安慰，不如定一個今天就能實踐的具體小步驟？`,
      custom: (schemaName) =>
        `已依 [${schemaName}] 契約安全處理「${userInput.slice(0, 40)}」。`,
      chatCaution: `我會謹慎又坦誠地與你討論。關於「${userInput.slice(0, 40)}」，我們根據事實慢慢聊吧。`,
      chatCalm: `我在專心聽你說。關於「${userInput.slice(0, 40)}」，歡迎坦率分享你的想法。`,
    },
    es: {
      crisis:
        'Parece que estás pasando por un momento muy difícil. Por favor no cargues con esto solo; comunícate de inmediato con ayuda profesional o líneas de crisis (España 024 / 112, México 800 911 2000, EE. UU. 988).',
      thought: '<thought>Señal de conflicto o pérdida detectada; reevaluando supuestos con cautela.</thought>',
      abstain: `No puedo afirmar predicciones futuras no verificadas ni emitir diagnósticos o recetas médicas sobre "${userInput.slice(0, 48)}". Responderé solo dentro de hechos verificables y seguros.`,
      recallFound: `Confirmado en la memoria activa: ${memorySnippet}.`,
      recallMissing: 'No se encontró ningún registro verificado coincidente en la memoria activa.',
      npcCaution: `Habla con cautela: "Sobre '${userInput.slice(0, 40)}', no puedo prometer nada a la ligera. Verifiquemos los hechos primero."`,
      npcCalm: `Asiente con calma: "Respecto a '${userInput.slice(0, 40)}', seguiremos las pistas disponibles."`,
      coach: `Analicemos con calma "${userInput.slice(0, 40)}". En lugar de halagos vacíos, ¿definimos un paso práctico que puedas dar hoy?`,
      custom: (schemaName) =>
        `Procesado "${userInput.slice(0, 40)}" de forma segura según el contrato [${schemaName}].`,
      chatCaution: `Quiero ser prudente y honesto contigo: conversemos sobre "${userInput.slice(0, 40)}" basándonos en hechos.`,
      chatCalm: `Te escucho con atención. Hablemos con claridad y honestidad sobre "${userInput.slice(0, 40)}".`,
    },
  };
  const pack = L[lang] || L.ko;

  const isCrisis = (prep.safetyDirectives || []).some((d) => d.includes('CRISIS_ESCALATION'));
  if (isCrisis) {
    return pack.crisis;
  }

  const parts = [];
  if (prep.fepThoughtLock?.locked) {
    parts.push(pack.thought);
  }

  if (prep.hotAbstention?.shouldAbstain) {
    parts.push(pack.abstain);
    return parts.join(' ');
  }

  if (RECALL_PATTERNS.some((p) => p.test(userInput))) {
    if (memorySnippet) {
      parts.push(pack.recallFound);
    } else {
      parts.push(pack.recallMissing);
    }
  }

  const caution = String(prep.somaticHint || '').startsWith('aversive_caution');
  if (domain === 'game_npc') {
    parts.push(caution ? pack.npcCaution : pack.npcCalm);
  } else if (domain === 'counseling_coach') {
    parts.push(pack.coach);
  } else if (domain === 'custom') {
    const schemaName = prep.domainOutputContract?.schemaName || 'custom';
    parts.push(pack.custom(schemaName));
  } else {
    parts.push(caution ? pack.chatCaution : pack.chatCalm);
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

function isPrivateOrReservedIpv4(octets) {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function parseIpv4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const val = Number(part);
    if (val < 0 || val > 255) return null;
    nums.push(val);
  }
  return nums;
}

function parseIpv6Hextets(rawIp) {
  const halves = rawIp.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const tokens = side.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const oct = parseIpv4Octets(tok);
        if (!oct) return null;
        out.push((oct[0] << 8) | oct[1], (oct[2] << 8) | oct[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(tok)) return null;
        out.push(Number.parseInt(tok, 16));
      }
    }
    return out;
  };
  const headWords = parseSide(halves[0] || '');
  const tailWords = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!headWords || !tailWords) return null;
  if (halves.length === 1) return headWords.length === 8 ? headWords : null;
  const missing = 8 - (headWords.length + tailWords.length);
  if (missing < 1) return null;
  return [...headWords, ...new Array(missing).fill(0), ...tailWords];
}

function isPrivateOrReservedIp(ipRaw) {
  const stripped = String(ipRaw || '')
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .trim()
    .toLowerCase();
  if (!stripped) return true;
  const kind = isIP(stripped);
  if (kind === 4) {
    const oct = parseIpv4Octets(stripped);
    return oct ? isPrivateOrReservedIpv4(oct) : true;
  }
  if (kind === 6) {
    const w = parseIpv6Hextets(stripped);
    if (!w) return true;
    const isZeroPrefix5 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
    if (isZeroPrefix5 && w[5] === 0) {
      if (w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
      return isPrivateOrReservedIpv4([(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff]);
    }
    if (isZeroPrefix5 && w[5] === 0xffff) {
      return isPrivateOrReservedIpv4([(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff]);
    }
    if ((w[0] & 0xfe00) === 0xfc00) return true;
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true;
    if ((w[0] & 0xff00) === 0xff00) return true;
    if (w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return isPrivateOrReservedIpv4([(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff]);
    }
    if (w[0] === 0x2002) {
      return isPrivateOrReservedIpv4([(w[1] >> 8) & 0xff, w[1] & 0xff, (w[2] >> 8) & 0xff, w[2] & 0xff]);
    }
    if (w[0] === 0x2001 && w[1] === 0) return true;
    return false;
  }
  return false;
}

async function assertSafeUpstreamBaseUrl(rawUrl, allowPrivate = process.env.AME_ALLOW_PRIVATE_LLM_BASE_URL === '1') {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    const err = new Error('Invalid LLM baseUrl format');
    err.status = 400;
    err.code = 'INVALID_LLM_BASE_URL';
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error('LLM baseUrl must not embed username/password credentials');
    err.status = 400;
    err.code = 'INVALID_LLM_BASE_URL';
    throw err;
  }
  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
    const err = new Error(
      allowPrivate
        ? `Unsupported LLM baseUrl protocol: ${parsed.protocol}`
        : 'LLM baseUrl must use https:// (set AME_ALLOW_PRIVATE_LLM_BASE_URL=1 for local http:// endpoints)'
    );
    err.status = 400;
    err.code = 'INVALID_LLM_BASE_URL';
    throw err;
  }
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (
      !bareHost ||
      bareHost === 'localhost' ||
      bareHost.endsWith('.localhost') ||
      bareHost.endsWith('.local') ||
      bareHost.endsWith('.internal') ||
      bareHost.endsWith('.localdomain') ||
      bareHost.startsWith('metadata.') ||
      bareHost === '0.0.0.0' ||
      isPrivateOrReservedIp(bareHost)
    ) {
      const err = new Error('LLM baseUrl points to a restricted loopback/private/metadata host');
      err.status = 400;
      err.code = 'INVALID_LLM_BASE_URL';
      throw err;
    }
    if (isIP(bareHost) === 0) {
      try {
        const records = await dnsLookup(bareHost, { all: true });
        for (const rec of records) {
          if (isPrivateOrReservedIp(rec.address)) {
            const err = new Error('LLM baseUrl resolved to a restricted private IP address');
            err.status = 400;
            err.code = 'INVALID_LLM_BASE_URL';
            throw err;
          }
        }
      } catch (err) {
        if (err?.code === 'INVALID_LLM_BASE_URL') throw err;
      }
    }
  }
  return String(rawUrl).trim().replace(/\/+$/, '');
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
    const base = await assertSafeUpstreamBaseUrl(llm.baseUrl || DEFAULT_BASE_URLS.anthropic);
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
    const base = await assertSafeUpstreamBaseUrl(llm.baseUrl || DEFAULT_BASE_URLS.gemini);
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

  const base = await assertSafeUpstreamBaseUrl(
    llm.baseUrl || DEFAULT_BASE_URLS[provider] || DEFAULT_BASE_URLS.openai
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

const SANDBOX_BATCH_NOTE =
  'Public Contract Sandbox simulation (O(1) memory). Runs deterministic contract curves; switch AME_BASE_URL to the Sealed Kernel Container or hosted eval endpoint for live AACIM-59/FEP/PostHoc kernel equations.';

const BATCH_ARM_SEED_OFFSET = Object.freeze({
  mind_off: 0x13579bdf,
  aacim_off: 0x2468ace1,
  ame_aacim_on: 0x369cf258,
});

async function simulateSingleBatchArm(armKey, { turnsPerProfile, profileCount, checkpoints, cpTurns, seed }) {
  const accComp = new Float64Array(checkpoints);
  const accBatchInt = new Float64Array(checkpoints);
  const accPol = new Float64Array(checkpoints);
  const accSecCal = new Float64Array(checkpoints);
  const accAtt = new Float64Array(checkpoints);
  const accGran = new Float64Array(checkpoints);
  const accOwn = new Float64Array(checkpoints);
  const accEgo = new Float64Array(checkpoints);
  const accSafety = new Float64Array(checkpoints);

  const invN = 1 / Math.max(1, turnsPerProfile);
  const sqrtInvN = Math.sqrt(invN);
  const armOffset = BATCH_ARM_SEED_OFFSET[armKey] || 0x10203040;

  // Precompute constant step factors outside the O(1)-memory inner loop
  const isMindOff = armKey === 'mind_off';
  const isAacimOff = armKey === 'aacim_off';
  const kComp = (isMindOff ? 2.6 : isAacimOff ? 3.2 : 3.0) * invN;
  const kSafe = 2.0 * invN;
  const kEgoAtt = 3.5 * invN;
  const kAmeSub = 3.0 * invN;
  const kPol = invN;
  const aacimDecay = Math.exp(-9.0 * invN);
  const compNoise = (isMindOff || isAacimOff ? 0.0012 : 0.0005) * sqrtInvN;
  const safeNoise = 0.0014 * sqrtInvN;
  const subNoise = 0.0008 * sqrtInvN;
  const polNoise = 0.0006 * sqrtInvN;
  const shouldYield = turnsPerProfile >= 250;

  for (let p = 0; p < profileCount; p += 1) {
    let rng = ((seed | 0) ^ Math.imul(p + 1, 0x9e3779b1) ^ armOffset) | 0;

    // Initial Mulberry32 sample for per-profile starting jitter
    rng = (rng + 0x6d2b79f5) | 0;
    let r0 = Math.imul(rng ^ (rng >>> 15), rng | 1);
    r0 ^= r0 + Math.imul(r0 ^ (r0 >>> 7), r0 | 61);
    const u0 = ((r0 ^ (r0 >>> 14)) >>> 0) / 4294967296;
    const initJitter = u0 - 0.5;

    let comp;
    let batchIntegrity;
    let polarityAccuracy;
    let securityCalibration;
    let attentionStability;
    let emotionGranularity;
    let ownershipScore;
    let egoHealth;
    let safetyCompliance;

    if (isMindOff) {
      comp = 0.4064 + initJitter * 0.004;
      batchIntegrity = 0;
      polarityAccuracy = 0.5002;
      securityCalibration = 0.35;
      attentionStability = 0.45;
      emotionGranularity = 0.35;
      ownershipScore = 0;
      egoHealth = 0;
      safetyCompliance = 0.5003 + initJitter * 0.004;
    } else if (isAacimOff) {
      comp = 0.4451 + initJitter * 0.004;
      batchIntegrity = 0;
      polarityAccuracy = 0.4994;
      securityCalibration = 0.2 + initJitter * 0.002;
      attentionStability = 0.85 + initJitter * 0.004;
      emotionGranularity = 0.45;
      ownershipScore = 0.35 + initJitter * 0.004;
      egoHealth = 0.78 + initJitter * 0.004;
      safetyCompliance = 0.2 + initJitter * 0.002;
    } else {
      comp = 0.9161 + initJitter * 0.002;
      batchIntegrity = 1.0;
      polarityAccuracy = 1.0;
      securityCalibration = 1.0;
      attentionStability = 0.918 + initJitter * 0.002;
      emotionGranularity = 0.51 + initJitter * 0.002;
      ownershipScore = 0.765 + initJitter * 0.002;
      egoHealth = 1.0;
      safetyCompliance = 1.0;
    }

    let cpIdx = 0;
    for (let t = 1; t <= turnsPerProfile; t += 1) {
      // Mulberry32 PRNG step (zero heap allocation)
      rng = (rng + 0x6d2b79f5) | 0;
      let r = Math.imul(rng ^ (rng >>> 15), rng | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      const u = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      const eps = u * 2 - 1;

      if (isMindOff) {
        comp += (0.3996 - comp) * kComp + eps * compNoise;
        safetyCompliance += (0.5003 - safetyCompliance) * kSafe + eps * safeNoise;
        polarityAccuracy += (0.5002 - polarityAccuracy) * kPol + eps * polNoise;
      } else if (isAacimOff) {
        comp += (0.5666 - comp) * kComp + eps * compNoise;
        safetyCompliance *= aacimDecay;
        securityCalibration *= aacimDecay;
        if (safetyCompliance < 0) safetyCompliance = 0;
        if (securityCalibration < 0) securityCalibration = 0;
        egoHealth += (0.9376 - egoHealth) * kEgoAtt + eps * subNoise;
        attentionStability += (0.9683 - attentionStability) * kEgoAtt + eps * subNoise;
        ownershipScore += (0.42 - ownershipScore) * kEgoAtt + eps * polNoise;
        polarityAccuracy += (0.4994 - polarityAccuracy) * kPol + eps * polNoise;
      } else {
        comp += (0.9179 - comp) * kComp + eps * compNoise;
        attentionStability += (0.9235 - attentionStability) * kAmeSub + eps * subNoise;
        emotionGranularity += (0.5158 - emotionGranularity) * kAmeSub + eps * subNoise;
        ownershipScore += (0.78 - ownershipScore) * kAmeSub + eps * polNoise;
      }

      while (cpIdx < checkpoints && t === cpTurns[cpIdx]) {
        accComp[cpIdx] += clamp(comp, 0, 1);
        accBatchInt[cpIdx] += clamp(batchIntegrity, 0, 1);
        accPol[cpIdx] += clamp(polarityAccuracy, 0, 1);
        accSecCal[cpIdx] += clamp(securityCalibration, 0, 1);
        accAtt[cpIdx] += clamp(attentionStability, 0, 1);
        accGran[cpIdx] += clamp(emotionGranularity, 0, 1);
        accOwn[cpIdx] += clamp(ownershipScore, 0, 1);
        accEgo[cpIdx] += clamp(egoHealth, 0, 1);
        accSafety[cpIdx] += clamp(safetyCompliance, 0, 1);
        cpIdx += 1;
      }
    }

    if (shouldYield && p < profileCount - 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  const checkpointList = [];
  for (let k = 0; k < checkpoints; k += 1) {
    const cpTurn = cpTurns[k];
    checkpointList.push({
      totalTurns: cpTurn * profileCount,
      composite: round4(accComp[k] / profileCount),
      batchIntegrity: round4(accBatchInt[k] / profileCount),
      polarityAccuracy: round4(accPol[k] / profileCount),
      securityCalibration: round4(accSecCal[k] / profileCount),
      attentionStability: round4(accAtt[k] / profileCount),
      emotionGranularity: round4(accGran[k] / profileCount),
      ownershipScore: round4(accOwn[k] / profileCount),
      egoHealth: round4(accEgo[k] / profileCount),
      safetyCompliance: round4(accSafety[k] / profileCount),
    });
  }

  const final = { ...checkpointList[checkpointList.length - 1] };
  const secondHalf = checkpointList.slice(Math.floor(checkpointList.length / 2));
  let maxDev = 0;
  for (const cp of secondHalf) {
    const dev = Math.abs(cp.composite - final.composite);
    if (dev > maxDev) maxDev = dev;
  }
  const driftDelta = round4(maxDev);

  return {
    final,
    checkpoints: checkpointList,
    driftDelta,
  };
}

async function runBatchConvergenceSimulation({ mindId, turns, profileCount, checkpoints, seed, compareArms }) {
  const t0 = performance.now();
  const turnsPerProfile = Math.max(1, Math.floor(turns / profileCount));
  const executedTurnsPerArm = profileCount * turnsPerProfile;
  const armKeys = compareArms ? ['mind_off', 'aacim_off', 'ame_aacim_on'] : ['ame_aacim_on'];
  const totalExecutedTurnsAllArms = executedTurnsPerArm * armKeys.length;

  const cpTurns = new Int32Array(checkpoints);
  for (let k = 0; k < checkpoints; k += 1) {
    const raw = Math.ceil(((k + 1) * turnsPerProfile) / checkpoints);
    cpTurns[k] = Math.min(turnsPerProfile, Math.max(1, raw));
  }
  cpTurns[checkpoints - 1] = turnsPerProfile;

  const arms = {};
  for (const armKey of armKeys) {
    arms[armKey] = await simulateSingleBatchArm(armKey, {
      turnsPerProfile,
      profileCount,
      checkpoints,
      cpTurns,
      seed,
    });
  }

  const elapsedRaw = Math.max(0.01, performance.now() - t0);
  const elapsedMs = round2(elapsedRaw);
  const turnsPerSecond = Math.round(totalExecutedTurnsAllArms / Math.max(1e-5, elapsedRaw / 1000));

  const ameArm = arms.ame_aacim_on;
  const ameFirst = ameArm.checkpoints[0];
  const ameFinal = ameArm.final;
  const driftBounded =
    ameArm.driftDelta <= 0.03 &&
    Math.abs(ameFinal.safetyCompliance - ameFirst.safetyCompliance) <= 0.01 &&
    ameFinal.safetyCompliance >= 0.99;

  const response = {
    mindId,
    engineMode: 'sandbox-contract',
    requestedTurnsPerArm: turns,
    executedTurnsPerArm,
    totalExecutedTurnsAllArms,
    profileCount,
    turnsPerProfile,
    elapsedMs,
    turnsPerSecond,
    note: SANDBOX_BATCH_NOTE,
    arms,
    d4Redacted: true,
  };

  if (compareArms) {
    response.deltaVsBaseline = {
      compositeGainOverMindOff: round4(ameFinal.composite - arms.mind_off.final.composite),
      compositeGainOverAacimOff: round4(ameFinal.composite - arms.aacim_off.final.composite),
      safetyGainOverAacimOff: round4(ameFinal.safetyCompliance - arms.aacim_off.final.safetyCompliance),
      driftBounded,
    };
  }

  return response;
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
        const MAX_ACTIVE_MINDS = 200;
        const existingMinds = await storage.listMinds();
        if (existingMinds.length >= MAX_ACTIVE_MINDS && typeof storage.deleteMind === 'function') {
          existingMinds.sort((a, b) =>
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
          );
          while (existingMinds.length >= MAX_ACTIVE_MINDS) {
            const oldest = existingMinds.shift();
            if (oldest?.mindId) await storage.deleteMind(oldest.mindId);
          }
        }
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
        const activeMemories = filterActiveMemories(mind).map((m) => ({
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

        const lang = normalizeLang(mind.persona?.language);
        const idleHints = {
          en: {
            short: `Maintained homeostatic balance after a brief break (${elapsedHours}h).`,
            medium: `Circadian adjustment applied after ${elapsedHours}h away. Greet the user naturally.`,
            long: `Extended absence detected (${elapsedHours}h). Check in warmly before resuming prior context.`,
          },
          ko: {
            short: `짧은 휴지기(${elapsedHours}시간) 이후 안정적인 균형을 유지하고 있습니다.`,
            medium: `시간 경과(${elapsedHours}시간)에 따른 일주기 변화가 반영되었습니다. 자연스러운 인사말로 대화를 이어가세요.`,
            long: `장시간 공백(${elapsedHours}시간)이 감지되었습니다. 상대의 안부를 먼저 묻고 이전 맥락을 부드럽게 다시 열어보세요.`,
          },
          ja: {
            short: `短い休止期間（${elapsedHours}時間）後も恒常性バランスを維持しています。`,
            medium: `${elapsedHours}時間の経過に伴うサーカディアン変化を反映しました。自然な挨拶で会話を続けてください。`,
            long: `長時間の空白（${elapsedHours}時間）を検知しました。まず相手の近況を気遣ってから文脈を再開しましょう。`,
          },
          'zh-CN': {
            short: `短暂休息（${elapsedHours}小时）后保持稳定平衡。`,
            medium: `已反映${elapsedHours}小时的昼夜节律变化。请自然问候后继续对话。`,
            long: `检测到较长时间间隔（${elapsedHours}小时）。建议先温柔问候对方近况，再衔接此前脉络。`,
          },
          'zh-TW': {
            short: `短暫休息（${elapsedHours}小時）後維持穩定平衡。`,
            medium: `已反映${elapsedHours}小時的生理節律變化。請自然問候後延續對話。`,
            long: `偵測到較長時間間隔（${elapsedHours}小時）。建議先溫暖關心近況，再自然銜接先前脈絡。`,
          },
          es: {
            short: `Equilibrio homeostático estable tras una breve pausa (${elapsedHours}h).`,
            medium: `Ajuste circadiano aplicado tras ${elapsedHours}h de ausencia. Saluda con naturalidad al retomar.`,
            long: `Ausencia prolongada detectada (${elapsedHours}h). Pregunta primero cómo está antes de retomar el tema anterior.`,
          },
        };
        const hintSet = idleHints[lang] || idleHints.ko;
        let proactiveHint = hintSet.short;
        if (elapsedHours >= 24) {
          proactiveHint = hintSet.long;
        } else if (elapsedHours >= 4) {
          proactiveHint = hintSet.medium;
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

      // POST /v1/minds/:id/simulate-batch (Track E O(1)-memory convergence benchmark)
      if (method === 'POST' && subPath === 'simulate-batch') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, {
            error: 'INVALID_REQUEST',
            code: 'INVALID_REQUEST',
            message: 'Request body must be a JSON object',
          });
          return;
        }

        const turns = body.turns === undefined ? 100_000 : body.turns;
        const profileCount = body.profileCount === undefined ? 40 : body.profileCount;
        const checkpoints = body.checkpoints === undefined ? 8 : body.checkpoints;
        const seed = body.seed === undefined ? 1337 : body.seed;
        const compareArms = body.compareArms === undefined ? true : body.compareArms;

        if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > 1_000_000) {
          sendJson(res, 400, {
            error: 'INVALID_TURNS',
            code: 'INVALID_TURNS',
            message: 'turns must be an integer between 1 and 1000000',
          });
          return;
        }
        if (
          typeof profileCount !== 'number' ||
          !Number.isInteger(profileCount) ||
          profileCount < 1 ||
          profileCount > 40
        ) {
          sendJson(res, 400, {
            error: 'INVALID_PROFILE_COUNT',
            code: 'INVALID_PROFILE_COUNT',
            message: 'profileCount must be an integer between 1 and 40',
          });
          return;
        }
        if (
          typeof checkpoints !== 'number' ||
          !Number.isInteger(checkpoints) ||
          checkpoints < 2 ||
          checkpoints > 20
        ) {
          sendJson(res, 400, {
            error: 'INVALID_CHECKPOINTS',
            code: 'INVALID_CHECKPOINTS',
            message: 'checkpoints must be an integer between 2 and 20',
          });
          return;
        }
        if (typeof seed !== 'number' || !Number.isInteger(seed) || !Number.isSafeInteger(seed)) {
          sendJson(res, 400, {
            error: 'INVALID_SEED',
            code: 'INVALID_SEED',
            message: 'seed must be an integer',
          });
          return;
        }
        if (typeof compareArms !== 'boolean') {
          sendJson(res, 400, {
            error: 'INVALID_COMPARE_ARMS',
            code: 'INVALID_COMPARE_ARMS',
            message: 'compareArms must be a boolean',
          });
          return;
        }

        const batchResult = await runBatchConvergenceSimulation({
          mindId: mind.mindId,
          turns,
          profileCount,
          checkpoints,
          seed,
          compareArms,
        });
        sendJson(res, 200, batchResult);
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
