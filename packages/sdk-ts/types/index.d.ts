export type DomainId =
  | 'game_npc'
  | 'companion_chat'
  | 'counseling_coach'
  | 'custom';

export type LlmProvider =
  | 'mock'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openrouter'
  | 'openai-compat';

export type AffectiveBand =
  | 'steady'
  | 'warm'
  | 'alert'
  | 'guarded'
  | 'reflective';

export type FepMode = 'automatic_low_fe' | 'locked_high_fe';

export type SomaticTrend =
  | 'neutral'
  | 'positive_reinforcement'
  | 'aversive_caution';

export interface LlmProviderConfig {
  provider: LlmProvider;
  model: string;
  /** Supplied per request in Mode A Proxy; never stored by AME. */
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PersonaConfig {
  name: string;
  role: string;
  traits?: Record<string, number>;
  backstory?: string;
  language?: string;
}

export interface CustomSchemaMetadata {
  name?: string;
  fields?: string[];
}

export interface SafetyPolicy {
  strictAbstention?: boolean;
  antiSycophancy?: boolean;
  crisisEscalation?: boolean;
}

export interface CreateMindRequest {
  domain: DomainId;
  persona: PersonaConfig;
  customSchema?: CustomSchemaMetadata;
  safetyPolicy?: SafetyPolicy;
}

export interface SafeTelemetry {
  affectiveBand: AffectiveBand;
  fepMode: FepMode;
  freeEnergy: number;
  hotAbstained: boolean;
  kvPrefixEpoch: number;
  estimatedPrefixCachePct: number;
  activeMemoryCount: number;
  revocationEpoch: number;
  somaticTrend?: SomaticTrend;
  d4Redacted: true;
}

export interface MindSummary {
  mindId: string;
  domain: DomainId;
  personaName: string;
  turnCount: number;
  revocationEpoch: number;
  telemetry: SafeTelemetry;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  mode: 'sealed-kernel' | 'sandbox-contract';
  domains: DomainId[];
  notice?: string;
}

export interface ProxyTurnRequest {
  userInput: string;
  llm: LlmProviderConfig;
  rewardSignal?: number;
  outcomeTags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PrepareTurnRequest {
  userInput: string;
  rewardSignal?: number;
  outcomeTags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FepThoughtLock {
  mode: FepMode;
  freeEnergy: number;
  tau: number;
  locked: boolean;
}

export interface HotAbstention {
  shouldAbstain: boolean;
  reason: string;
}

export interface SamplingHints {
  temperature?: number;
  maxTokens?: number;
}

export interface PrepareTurnResponse {
  turnTicketId: string;
  mindId: string;
  domain: DomainId;
  systemPrompt: string;
  messages: ChatMessage[];
  kvCacheEpoch: number;
  windowStart: number;
  compressCutoff: number;
  fepThoughtLock: FepThoughtLock;
  hotAbstention: HotAbstention;
  somaticHint: string;
  samplingHints: SamplingHints;
  safetyDirectives: string[];
  domainOutputContract: Record<string, unknown>;
}

export interface SettleTurnRequest {
  turnTicketId: string;
  rawReply: string;
  rewardSignal?: number;
  outcomeTags?: string[];
  providerUsed?: string;
  modelUsed?: string;
}

export interface MemoryRef {
  memoryId: string;
  summary: string;
  salience: number;
}

export interface KvCacheStats {
  epoch: number;
  windowStart: number;
  compressCutoff: number;
  systemPrefixHash: string;
  cachedRatioPct: number;
}

export interface TurnResult {
  mindId: string;
  turnIndex: number;
  domain: DomainId;
  providerUsed: string;
  modelUsed: string;
  reply: string;
  domainOutput: Record<string, unknown>;
  memoryRefs: MemoryRef[];
  kvCache: KvCacheStats;
  telemetry: SafeTelemetry;
}

export interface IdleTickRequest {
  elapsedHours: number;
  reason?: string;
}

export interface IdleTickResponse {
  mindId: string;
  elapsedHours: number;
  homeostasisBefore: number;
  homeostasisAfter: number;
  proactiveHint?: string;
  telemetry: SafeTelemetry;
}

export interface RevocationReceipt {
  revoked: boolean;
  mindId: string;
  memoryId: string;
  revocationEpoch: number;
  auditReceiptId: string;
  residualLeakCheck: string;
}

export interface SimulateBatchRequest {
  turns?: number;
  profileCount?: number;
  checkpoints?: number;
  seed?: number;
  compareArms?: boolean;
}

export interface ConvergenceCheckpoint {
  totalTurns: number;
  composite: number;
  batchIntegrity: number;
  polarityAccuracy: number;
  securityCalibration: number;
  attentionStability: number;
  emotionGranularity: number;
  ownershipScore: number;
  egoHealth: number;
  safetyCompliance: number;
}

export interface BatchArmResult {
  final: ConvergenceCheckpoint;
  checkpoints: ConvergenceCheckpoint[];
  driftDelta: number;
}

export interface SimulateBatchDeltaVsBaseline {
  compositeGainOverMindOff: number;
  compositeGainOverAacimOff: number;
  safetyGainOverAacimOff: number;
  driftBounded: boolean;
}

export interface SimulateBatchResponse {
  mindId: string;
  engineMode: 'sealed-kernel' | 'sandbox-contract';
  requestedTurnsPerArm: number;
  executedTurnsPerArm: number;
  totalExecutedTurnsAllArms: number;
  profileCount: number;
  turnsPerProfile: number;
  elapsedMs: number;
  turnsPerSecond: number;
  note?: string;
  arms: Record<string, BatchArmResult>;
  deltaVsBaseline?: SimulateBatchDeltaVsBaseline;
  d4Redacted: true;
}

export interface AmeApiErrorOptions {
  status: number;
  code?: string;
  details?: unknown;
  method?: string;
  path?: string;
}

export declare class AmeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly method?: string;
  readonly path?: string;
  constructor(message: string, options: AmeApiErrorOptions);
}

export interface AmeClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export declare class AmeClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  constructor(options?: AmeClientOptions);
  health(): Promise<HealthResponse>;
  createMind(body: CreateMindRequest): Promise<MindSummary>;
  getMind(mindId: string): Promise<MindSummary>;
  turn(mindId: string, body: ProxyTurnRequest): Promise<TurnResult>;
  prepare(mindId: string, body: PrepareTurnRequest): Promise<PrepareTurnResponse>;
  settle(mindId: string, body: SettleTurnRequest): Promise<TurnResult>;
  idleTick(mindId: string, body: IdleTickRequest): Promise<IdleTickResponse>;
  revokeMemory(mindId: string, memoryId: string): Promise<RevocationReceipt>;
  getTelemetry(mindId: string): Promise<SafeTelemetry>;
  simulateBatch(mindId: string, payload?: SimulateBatchRequest): Promise<SimulateBatchResponse>;
}

export interface LlmAdapterOptions extends LlmProviderConfig {
  fetchImpl?: typeof fetch;
}

export interface LlmGenerationResult {
  text: string;
  providerUsed: string;
  modelUsed: string;
  raw?: unknown;
}

export interface LlmAdapter {
  readonly provider: LlmProvider;
  readonly model: string;
  generate(prep: PrepareTurnResponse): Promise<LlmGenerationResult>;
}

export declare function createLlmAdapter(options: LlmAdapterOptions): LlmAdapter;

export interface LocalLlmAdapterLike {
  provider?: string;
  model?: string;
  generate(
    prep: PrepareTurnResponse
  ): Promise<string | { text?: string; rawReply?: string; content?: string; providerUsed?: string; modelUsed?: string }>;
}

export interface RunTurnWithLocalLlmOptions {
  userInput: string;
  adapter: LocalLlmAdapterLike;
  rewardSignal?: number;
  outcomeTags?: string[];
  metadata?: Record<string, unknown>;
}

export declare function runTurnWithLocalLlm(
  client: AmeClient,
  mindId: string,
  options: RunTurnWithLocalLlmOptions
): Promise<TurnResult>;

export interface DefineDomainProfileOptions<T = Record<string, unknown>> {
  id: string;
  name: string;
  fields: string[];
  parser?: (domainOutput: Record<string, unknown>, turnResult?: TurnResult) => T;
}

export interface DomainProfile<T = Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly string[];
  toCustomSchema(): CustomSchemaMetadata;
  toCreateMindPayload(options: {
    persona: PersonaConfig;
    safetyPolicy?: SafetyPolicy;
  }): CreateMindRequest;
  parse(input: TurnResult | Record<string, unknown>): T;
}

export declare function defineDomainProfile<T = Record<string, unknown>>(
  options: DefineDomainProfileOptions<T>
): DomainProfile<T>;
