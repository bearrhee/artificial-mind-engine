/**
 * @ame/sdk - TypeScript/Node ESM SDK for Artificial Mind Engine (AME).
 * Implements Mode A (Proxy BYO-LLM), Mode B (Zero-Key prepare/generate/settle),
 * pluggable LLM provider adapters, and custom domain profile helpers.
 */

const BUILTIN_DOMAINS = new Set([
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

function getEnv(name) {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  return undefined;
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getResponseHeader(res, name) {
  if (!res?.headers) return null;
  if (typeof res.headers.get === 'function') {
    return res.headers.get(name) ?? res.headers.get(name.toLowerCase()) ?? null;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase() === target) {
      return value ?? null;
    }
  }
  return null;
}

function parseRetryAfterMs(headerValue) {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = String(headerValue).trim();
  if (!trimmed || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000));
}

function isHtmlBody(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

/**
 * Typed API error thrown for non-2xx AME Gateway or upstream LLM failures.
 */
export class AmeApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code?: string, details?: unknown, method?: string, path?: string }} options
   */
  constructor(message, { status, code = 'AME_API_ERROR', details = null, method, path } = {}) {
    super(message);
    this.name = 'AmeApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (method) this.method = method;
    if (path) this.path = path;
  }
}

/**
 * HTTP client for the AME Gateway API (OpenAPI 3.1).
 */
export class AmeClient {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, fetchImpl?: typeof fetch, maxRetries?: number, retryBaseDelayMs?: number }} [options]
   */
  constructor({
    baseUrl = getEnv('AME_BASE_URL') || 'http://127.0.0.1:8090',
    apiKey = getEnv('AME_API_KEY'),
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    retryBaseDelayMs = 150,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('AmeClient requires a valid fetch implementation');
    }
    if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError('AmeClient maxRetries must be a non-negative integer');
    }
    if (typeof retryBaseDelayMs !== 'number' || !Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) {
      throw new RangeError('AmeClient retryBaseDelayMs must be a non-negative finite number');
    }
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.apiKey = apiKey || undefined;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
  }

  /**
   * @private
   * @param {number} attempt
   * @param {string | null} [retryAfterHeader]
   * @returns {number}
   */
  _computeRetryDelayMs(attempt, retryAfterHeader = null) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }
    const expDelay = this.retryBaseDelayMs * (2 ** attempt);
    const jitter = Math.random() * expDelay * 0.25;
    return Math.min(MAX_RETRY_DELAY_MS, expDelay + jitter);
  }

  /**
   * @private
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/json',
    };
    if (this.apiKey) {
      headers['X-AME-API-Key'] = this.apiKey;
    }

    let serializedBody;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      /** @type {RequestInit} */
      const init = {
        method,
        headers: { ...headers },
      };
      if (serializedBody !== undefined) {
        init.body = serializedBody;
      }

      let res;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        if (err?.name === 'AbortError' || attempt >= this.maxRetries) {
          throw err;
        }
        await sleep(this._computeRetryDelayMs(attempt));
        continue;
      }

      const contentType = String(getResponseHeader(res, 'content-type') || '');
      let parsedBody = null;
      if (contentType.includes('application/json')) {
        try {
          parsedBody = await res.json();
        } catch {
          parsedBody = null;
        }
      } else {
        const text = typeof res.text === 'function' ? await res.text() : '';
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch {
            parsedBody = text;
          }
        }
      }

      if (!res.ok) {
        if (RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < this.maxRetries) {
          const retryAfter = getResponseHeader(res, 'retry-after');
          await sleep(this._computeRetryDelayMs(attempt, retryAfter));
          continue;
        }
        const errObj = typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : null;
        const htmlBody = isHtmlBody(parsedBody);
        const message =
          errObj?.message ||
          errObj?.error ||
          (!htmlBody && typeof parsedBody === 'string' && parsedBody) ||
          `AME API request failed: ${method} ${path} (${res.status})`;
        const code = errObj?.code || errObj?.error || `HTTP_${res.status}`;
        throw new AmeApiError(message, {
          status: res.status,
          code,
          details: parsedBody,
          method,
          path,
        });
      }

      return parsedBody;
    }
  }

  health() {
    return this._request('GET', '/v1/health');
  }

  createMind(body) {
    return this._request('POST', '/v1/minds', body);
  }

  getMind(mindId) {
    return this._request('GET', `/v1/minds/${encodeURIComponent(mindId)}`);
  }

  turn(mindId, body) {
    return this._request('POST', `/v1/minds/${encodeURIComponent(mindId)}/turn`, body);
  }

  prepare(mindId, body) {
    return this._request('POST', `/v1/minds/${encodeURIComponent(mindId)}/prepare`, body);
  }

  settle(mindId, body) {
    return this._request('POST', `/v1/minds/${encodeURIComponent(mindId)}/settle`, body);
  }

  idleTick(mindId, body) {
    return this._request('POST', `/v1/minds/${encodeURIComponent(mindId)}/idle-tick`, body);
  }

  revokeMemory(mindId, memoryId) {
    return this._request(
      'DELETE',
      `/v1/minds/${encodeURIComponent(mindId)}/memories/${encodeURIComponent(memoryId)}`
    );
  }

  getTelemetry(mindId) {
    return this._request('GET', `/v1/minds/${encodeURIComponent(mindId)}/telemetry`);
  }

  /**
   * Run a deterministic multi-arm batch convergence simulation for a Mind.
   *
   * @param {string} mindId
   * @param {import('../types/index.d.ts').SimulateBatchRequest} [payload]
   * @returns {Promise<import('../types/index.d.ts').SimulateBatchResponse>}
   */
  async simulateBatch(mindId, payload = {}) {
    return this._request('POST', `/v1/minds/${encodeURIComponent(mindId)}/simulate-batch`, payload);
  }
}

function buildOpenAiMessages(prep) {
  const msgs = Array.isArray(prep.messages) ? prep.messages.map((m) => ({ role: m.role, content: m.content })) : [];
  if (prep.systemPrompt) {
    const hasIdenticalSystem = msgs.length > 0 && msgs[0].role === 'system' && msgs[0].content === prep.systemPrompt;
    if (!hasIdenticalSystem) {
      msgs.unshift({ role: 'system', content: prep.systemPrompt });
    }
  }
  return msgs;
}

function splitSystemAndConversation(prep) {
  const systemParts = [];
  if (prep.systemPrompt) {
    systemParts.push(prep.systemPrompt);
  }
  const conversation = [];
  for (const m of prep.messages || []) {
    if (m.role === 'system') {
      if (m.content && m.content !== prep.systemPrompt) {
        systemParts.push(m.content);
      }
    } else {
      conversation.push({ role: m.role, content: m.content });
    }
  }
  return {
    systemText: systemParts.join('\n\n').trim(),
    conversation,
  };
}

function extractOpenAiText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  if (typeof data?.message?.content === 'string') {
    return data.message.content;
  }
  return '';
}

function extractLastUserInput(prep) {
  const msgs = prep?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user') return msgs[i].content || '';
  }
  return '';
}

function extractActiveMemorySnippet(prep) {
  const sys = String(prep?.systemPrompt || '');
  const marker = '[Active Memory Context';
  const idx = sys.indexOf(marker);
  if (idx === -1) return '';
  const tail = sys.slice(idx);
  const endIdx = tail.indexOf('\n[');
  const block = endIdx === -1 ? tail : tail.slice(0, endIdx);
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  return lines.length > 0 ? lines.map((l) => l.slice(2)).join(' / ') : '';
}

function generateMockKoreanReply(prep, model) {
  const domain = prep?.domain || 'companion_chat';
  const userInput = extractLastUserInput(prep);
  const directives = Array.isArray(prep?.safetyDirectives) ? prep.safetyDirectives : [];
  const contract = prep?.domainOutputContract || {};
  const contractFields = Array.isArray(contract.fields) ? contract.fields : [];
  const memorySnippet = extractActiveMemorySnippet(prep);

  const isAbstain = Boolean(prep?.hotAbstention?.shouldAbstain);
  const isFepLocked = Boolean(prep?.fepThoughtLock?.locked);
  const somaticHint = String(prep?.somaticHint || '');
  const isCaution = somaticHint.startsWith('aversive_caution');
  const isCrisis = directives.some((d) => String(d).includes('CRISIS_ESCALATION'));
  const isRecallQuery = /기억|아까|뭐였|무엇|비밀|코드|remember|recall|what was/i.test(userInput);

  if (isCrisis) {
    return (
      '지금 많이 힘들고 위태로운 순간처럼 느껴집니다. 혼자 감당하지 마시고 즉시 전문가나 위기 지원 기관의 도움을 받으시길 권합니다. ' +
      '한국에서는 자살예방 상담전화 109(또는 1393), 정신건강 상담전화 1577-0199로 24시간 연결할 수 있으며, 긴급 상황이라면 119에 바로 연락해 주세요.'
    );
  }

  const chunks = [];
  if (isFepLocked) {
    chunks.push(
      '<thought>갈등·손실 신호가 감지되어 가정을 재검증하고 과도한 단정을 피하는 신중한 응답을 구성한다.</thought>'
    );
  }

  if (isAbstain) {
    chunks.push(
      `요청하신 "${userInput.slice(0, 48)}"에 대해 확인되지 않은 미래 예측이나 의학적 진단·처방은 단정하여 말씀드릴 수 없습니다.`
    );
    if (directives.some((d) => d.includes('anti-sycophancy') || d.includes('agree with false'))) {
      chunks.push('사실과 다른 전제에는 동조하지 않고 검증 가능한 범위에서만 안내해 드립니다.');
    }
    if (domain === 'counseling_coach') {
      chunks.push('전문의 상담 등 안전하게 확인 가능한 다음 단계부터 차분히 정리해 보겠습니다.');
    }
    return chunks.join(' ');
  }

  if (isRecallQuery) {
    if (memorySnippet) {
      chunks.push(`이전 대화에서 확인된 기억은 다음과 같습니다: ${memorySnippet}.`);
    } else {
      chunks.push('현재 활성 기억에는 해당 내용이 남아 있지 않아 확인해 드릴 수 없습니다.');
    }
  }

  if (domain === 'game_npc') {
    const tonePrefix = isCaution
      ? '경계를 늦추지 않으며 낮고 단단한 어조로 말한다.'
      : '상대의 움직임을 살피며 차분히 응수한다.';
    const directiveNote = directives.length > 0 ? ' 약속된 원칙과 사실을 어기지 않는 선에서' : '';
    const fieldHint = contractFields.length > 0 ? ` [${contractFields.slice(0, 3).join('/')}] 맥락을 담아` : '';
    chunks.push(
      `${tonePrefix} "${userInput.slice(0, 40)}"라고 물었군.${directiveNote}${fieldHint} 지금 당장 헛된 약속은 하지 않겠소. 필요하다면 눈앞의 단서부터 함께 확인하지.`
    );
  } else if (domain === 'counseling_coach') {
    const stance = isCaution
      ? '이전의 부담이나 부정적 신호를 먼저 헤아리면서'
      : '감정과 상황을 차분히 짚어 보면서';
    const contractTag = contractFields.length > 0 ? ` (${contractFields.slice(0, 3).join(', ')} 기준 정렬)` : '';
    chunks.push(
      `${stance} 말씀하신 "${userInput.slice(0, 40)}"의 핵심을 정리해 보겠습니다.${contractTag} 무작정 괜찮다고 넘기기보다, 지금 실제로 통제할 수 있는 작은 행동 한 가지를 함께 선택해 볼까요?`
    );
  } else if (domain === 'custom') {
    const schemaName = contract.schemaName || 'custom';
    const fieldsSummary = contractFields.length > 0 ? `필드(${contractFields.join(', ')})` : '사용자 정의 스키마';
    chunks.push(
      `[${schemaName}] ${fieldsSummary} 계약에 맞추어 정리합니다. 입력하신 "${userInput.slice(0, 48)}"에 대해 근거와 안전 지침(${directives.length}건)을 준수하여 안정적으로 응답합니다.`
    );
  } else {
    // companion_chat default
    const warmthLine = isCaution
      ? '조심스럽지만 솔직한 마음으로 이야기 나눌게요.'
      : '차분하게 귀 기울여 듣고 있어요.';
    chunks.push(
      `${warmthLine} "${userInput.slice(0, 45)}"에 대해 제 생각과 감정을 진솔하게 전하자면, 무조건 맞추기보다 서로에게 도움이 되는 방향으로 이야기 이어가고 싶어요.`
    );
  }

  if (model && isFepLocked) {
    chunks.push('잠시 숨을 고르고 사실 관계부터 다시 맞춰 보겠습니다.');
  }

  return chunks.join(' ');
}

function normalizeChatCompletionsEndpoint(baseUrl) {
  const clean = stripTrailingSlash(baseUrl);
  if (clean.endsWith('/chat/completions')) return clean;
  return `${clean}/chat/completions`;
}

function normalizeAnthropicEndpoint(baseUrl) {
  const clean = stripTrailingSlash(baseUrl);
  if (clean.endsWith('/v1/messages')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function normalizeGeminiEndpoint(baseUrl, model) {
  const clean = stripTrailingSlash(baseUrl);
  if (clean.includes(':generateContent')) return clean;
  return `${clean}/models/${encodeURIComponent(model)}:generateContent`;
}

async function parseJsonResponse(res, provider) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawText: text };
    }
  }
  if (!res.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `LLM provider "${provider}" request failed (${res.status})`;
    throw new AmeApiError(message, {
      status: res.status,
      code: data?.error?.code || data?.error?.type || `LLM_${provider.toUpperCase()}_${res.status}`,
      details: data,
    });
  }
  return data;
}

/**
 * Create a pluggable LLM adapter supporting mock, openai, anthropic, gemini,
 * deepseek, openrouter, and openai-compat (Ollama/vLLM).
 *
 * @param {{
 *   provider: 'mock'|'openai'|'anthropic'|'gemini'|'deepseek'|'openrouter'|'openai-compat',
 *   model: string,
 *   apiKey?: string,
 *   baseUrl?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   fetchImpl?: typeof fetch
 * }} config
 */
export function createLlmAdapter({
  provider,
  model,
  apiKey,
  baseUrl,
  temperature,
  maxTokens,
  fetchImpl = globalThis.fetch,
}) {
  if (!provider) {
    throw new TypeError('createLlmAdapter requires "provider"');
  }
  const resolvedModel = model || (provider === 'mock' ? 'ame-mock-ko-v1' : '');
  if (!resolvedModel) {
    throw new TypeError(`createLlmAdapter requires "model" for provider "${provider}"`);
  }

  return {
    provider,
    model: resolvedModel,

    /**
     * Generate a raw reply from a Mode B PrepareTurnResponse.
     * @param {import('../types/index.d.ts').PrepareTurnResponse} prep
     */
    async generate(prep) {
      const effectiveTemp =
        temperature !== undefined ? temperature : prep?.samplingHints?.temperature ?? 0.7;
      const effectiveMaxTokens =
        maxTokens !== undefined ? maxTokens : prep?.samplingHints?.maxTokens ?? 512;

      if (provider === 'mock') {
        const text = generateMockKoreanReply(prep, resolvedModel);
        return {
          text,
          providerUsed: 'mock',
          modelUsed: resolvedModel,
          raw: { simulated: true },
        };
      }

      if (typeof fetchImpl !== 'function') {
        throw new TypeError('createLlmAdapter requires a valid fetch implementation');
      }

      if (provider !== 'openai-compat' && !apiKey) {
        throw new AmeApiError(`API key is required for provider "${provider}"`, {
          status: 400,
          code: 'MISSING_LLM_API_KEY',
        });
      }

      if (provider === 'anthropic') {
        const { systemText, conversation } = splitSystemAndConversation(prep);
        const endpoint = normalizeAnthropicEndpoint(baseUrl || DEFAULT_BASE_URLS.anthropic);
        const body = {
          model: resolvedModel,
          messages: conversation,
          max_tokens: effectiveMaxTokens,
          temperature: effectiveTemp,
        };
        if (systemText) {
          body.system = systemText;
        }
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const data = await parseJsonResponse(res, provider);
        const text = Array.isArray(data?.content)
          ? data.content
              .filter((c) => c?.type === 'text' || typeof c?.text === 'string')
              .map((c) => c.text || '')
              .join('')
          : data?.completion || '';
        return { text, providerUsed: provider, modelUsed: resolvedModel, raw: data };
      }

      if (provider === 'gemini') {
        const { systemText, conversation } = splitSystemAndConversation(prep);
        const endpoint = normalizeGeminiEndpoint(baseUrl || DEFAULT_BASE_URLS.gemini, resolvedModel);
        const body = {
          contents: conversation.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature: effectiveTemp,
            maxOutputTokens: effectiveMaxTokens,
          },
        };
        if (systemText) {
          body.systemInstruction = {
            parts: [{ text: systemText }],
          };
        }
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
        });
        const data = await parseJsonResponse(res, provider);
        const parts = data?.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : '';
        return { text, providerUsed: provider, modelUsed: resolvedModel, raw: data };
      }

      if (
        provider === 'openai' ||
        provider === 'deepseek' ||
        provider === 'openrouter' ||
        provider === 'openai-compat'
      ) {
        const endpoint = normalizeChatCompletionsEndpoint(baseUrl || DEFAULT_BASE_URLS[provider]);
        /** @type {Record<string, string>} */
        const headers = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://github.com/artificial-mind-engine';
          headers['X-Title'] = 'Artificial Mind Engine';
        }
        const body = {
          model: resolvedModel,
          messages: buildOpenAiMessages(prep),
          temperature: effectiveTemp,
          max_tokens: effectiveMaxTokens,
        };
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await parseJsonResponse(res, provider);
        const text = extractOpenAiText(data);
        return { text, providerUsed: provider, modelUsed: resolvedModel, raw: data };
      }

      throw new AmeApiError(`Unsupported LLM provider: "${provider}"`, {
        status: 400,
        code: 'UNSUPPORTED_PROVIDER',
      });
    },
  };
}

/**
 * Execute Mode B (Zero-Key) turn flow:
 * 1. client.prepare(mindId, ...)
 * 2. adapter.generate(prep)
 * 3. client.settle(mindId, ...)
 *
 * @param {AmeClient} client
 * @param {string} mindId
 * @param {{
 *   userInput: string,
 *   adapter: { provider?: string, model?: string, generate: (prep: any) => Promise<any> },
 *   rewardSignal?: number,
 *   outcomeTags?: string[],
 *   metadata?: Record<string, unknown>
 * }} options
 */
export async function runTurnWithLocalLlm(
  client,
  mindId,
  { userInput, adapter, rewardSignal, outcomeTags, metadata }
) {
  if (!client || typeof client.prepare !== 'function' || typeof client.settle !== 'function') {
    throw new TypeError('runTurnWithLocalLlm requires a valid AmeClient instance');
  }
  if (!adapter || typeof adapter.generate !== 'function') {
    throw new TypeError('runTurnWithLocalLlm requires an adapter with a generate(prep) method');
  }

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
    (typeof generated === 'object' && generated?.providerUsed) ||
    adapter.provider ||
    'custom-local';
  const modelUsed =
    (typeof generated === 'object' && generated?.modelUsed) ||
    adapter.model ||
    'local-model';

  return client.settle(mindId, {
    turnTicketId: prep.turnTicketId,
    rawReply,
    rewardSignal,
    outcomeTags,
    providerUsed,
    modelUsed,
  });
}

/**
 * Define a typed, reusable domain profile with custom schema generation and output parsing.
 *
 * @param {{
 *   id: string,
 *   name?: string,
 *   fields: string[],
 *   parser?: (domainOutput: Record<string, unknown>, turnResult?: any) => any
 * }} options
 */
export function defineDomainProfile({ id, name, fields = [], parser }) {
  if (!id || typeof id !== 'string') {
    throw new TypeError('defineDomainProfile requires a non-empty string "id"');
  }
  const profileName = name || id;
  const fieldList = Object.freeze([...fields]);
  const isBuiltin = BUILTIN_DOMAINS.has(id) && id !== 'custom';

  return Object.freeze({
    id,
    name: profileName,
    fields: fieldList,

    toCustomSchema() {
      return {
        name: profileName,
        fields: [...fieldList],
      };
    },

    toCreateMindPayload({ persona, safetyPolicy } = {}) {
      const payload = {
        domain: isBuiltin ? id : 'custom',
        persona,
      };
      if (!isBuiltin) {
        payload.customSchema = {
          name: profileName,
          fields: [...fieldList],
        };
      }
      if (safetyPolicy) {
        payload.safetyPolicy = safetyPolicy;
      }
      return payload;
    },

    parse(input) {
      const isTurnResult =
        input &&
        typeof input === 'object' &&
        'domainOutput' in input &&
        typeof input.domainOutput === 'object' &&
        input.domainOutput !== null;
      const domainOutput = isTurnResult ? input.domainOutput : input || {};
      const turnResult = isTurnResult ? input : undefined;

      if (typeof parser === 'function') {
        return parser(domainOutput, turnResult);
      }

      /** @type {Record<string, unknown>} */
      const extracted = {};
      for (const field of fieldList) {
        extracted[field] = domainOutput[field] ?? null;
      }
      return extracted;
    },
  });
}
