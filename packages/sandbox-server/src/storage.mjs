/**
 * Pluggable persistent storage layer for @ame/sandbox-server.
 *
 * Modes:
 *   - "memory": Pure in-memory Map store (default, fast for unit tests)
 *   - "file": Atomic write-temp-and-rename JSON persistence preserving Minds,
 *             memories, somatic markers, KV cache epochs, and D3 revocations
 *             (revokedMemoryIds + excludedDerivativeIds -> 0 resurrection)
 *   - "postgres-redis": Repository hooks & DDL alignment with deploy/init.sql
 *                       (requires injected { pg, redis } driver adapters)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VALID_STORAGE_MODES = Object.freeze(['memory', 'file', 'postgres-redis']);

/**
 * Canonical DDL metadata aligned 1:1 with `deploy/init.sql`.
 */
export const POSTGRES_DDL_REF = Object.freeze({
  schemaFile: 'deploy/init.sql',
  extension: 'vector',
  embeddingDimension: 1024,
  tables: Object.freeze({
    ame_minds: Object.freeze({
      primaryKey: 'mind_id',
      columns: Object.freeze([
        'mind_id',
        'domain',
        'persona_name',
        'persona_json',
        'custom_schema_json',
        'safety_policy_json',
        'turn_count',
        'revocation_epoch',
        'kv_cache_epoch',
        'window_start',
        'compress_cutoff',
        'homeostasis',
        'caution_score',
        'positive_score',
        'free_energy',
        'fep_mode',
        'hot_abstained',
        'last_system_prefix_hash',
        'last_kv_epoch',
        'last_estimated_prefix_cache_pct',
        'created_at',
        'updated_at',
      ]),
    }),
    ame_memories: Object.freeze({
      primaryKey: 'memory_id',
      foreignKey: 'mind_id -> ame_minds(mind_id)',
      vectorColumn: 'embedding vector(1024)',
      columns: Object.freeze([
        'memory_id',
        'mind_id',
        'summary',
        'content',
        'assistant_summary',
        'salience',
        'turn_index',
        'tags',
        'derived_from_memory_ids',
        'embedding',
        'revoked_at',
        'created_at',
      ]),
    }),
    ame_turn_log: Object.freeze({
      primaryKey: 'turn_log_id',
      foreignKey: 'mind_id -> ame_minds(mind_id)',
      columns: Object.freeze([
        'turn_log_id',
        'mind_id',
        'turn_index',
        'role',
        'memory_id',
        'derived_from_memory_ids',
        'content',
        'provider_used',
        'model_used',
        'fep_mode',
        'free_energy',
        'hot_abstained',
        'kv_cache_epoch',
        'created_at',
      ]),
    }),
    ame_revocation_audit: Object.freeze({
      primaryKey: 'audit_receipt_id',
      foreignKey: 'mind_id -> ame_minds(mind_id)',
      columns: Object.freeze([
        'audit_receipt_id',
        'mind_id',
        'memory_id',
        'revocation_epoch',
        'excluded_derivative_ids',
        'residual_leak_check',
        'revoked_at',
      ]),
    }),
  }),
  redisKeys: Object.freeze({
    revocationEpoch: 'ame:mind:{mindId}:revocation_epoch',
    kvCacheEpoch: 'ame:mind:{mindId}:kv_epoch',
    revokedMemorySet: 'ame:mind:{mindId}:revoked_memories',
    excludedDerivativeSet: 'ame:mind:{mindId}:excluded_derivatives',
    turnTicket: 'ame:ticket:{turnTicketId}',
  }),
});

/**
 * Parameterized SQL templates & Redis epoch operations aligned with `deploy/init.sql`.
 */
export const POSTGRES_REDIS_SQL = Object.freeze({
  upsertMind: `
    INSERT INTO ame_minds (
      mind_id, domain, persona_name, persona_json, custom_schema_json, safety_policy_json,
      turn_count, revocation_epoch, kv_cache_epoch, window_start, compress_cutoff,
      homeostasis, caution_score, positive_score, free_energy, fep_mode, hot_abstained,
      last_system_prefix_hash, last_kv_epoch, last_estimated_prefix_cache_pct,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17,
      $18, $19, $20,
      COALESCE($21::timestamptz, NOW()), NOW()
    )
    ON CONFLICT (mind_id) DO UPDATE SET
      domain = EXCLUDED.domain,
      persona_name = EXCLUDED.persona_name,
      persona_json = EXCLUDED.persona_json,
      custom_schema_json = EXCLUDED.custom_schema_json,
      safety_policy_json = EXCLUDED.safety_policy_json,
      turn_count = EXCLUDED.turn_count,
      revocation_epoch = EXCLUDED.revocation_epoch,
      kv_cache_epoch = EXCLUDED.kv_cache_epoch,
      window_start = EXCLUDED.window_start,
      compress_cutoff = EXCLUDED.compress_cutoff,
      homeostasis = EXCLUDED.homeostasis,
      caution_score = EXCLUDED.caution_score,
      positive_score = EXCLUDED.positive_score,
      free_energy = EXCLUDED.free_energy,
      fep_mode = EXCLUDED.fep_mode,
      hot_abstained = EXCLUDED.hot_abstained,
      last_system_prefix_hash = EXCLUDED.last_system_prefix_hash,
      last_kv_epoch = EXCLUDED.last_kv_epoch,
      last_estimated_prefix_cache_pct = EXCLUDED.last_estimated_prefix_cache_pct,
      updated_at = NOW();
  `.trim(),
  selectMindById: `SELECT * FROM ame_minds WHERE mind_id = $1;`,
  listMinds: `SELECT * FROM ame_minds ORDER BY updated_at DESC;`,
  upsertMemory: `
    INSERT INTO ame_memories (
      memory_id, mind_id, summary, content, assistant_summary,
      salience, turn_index, tags, derived_from_memory_ids, created_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8::text[], $9::text[], COALESCE($10::timestamptz, NOW())
    )
    ON CONFLICT (memory_id) DO UPDATE SET
      summary = EXCLUDED.summary,
      assistant_summary = EXCLUDED.assistant_summary,
      salience = EXCLUDED.salience,
      tags = EXCLUDED.tags,
      derived_from_memory_ids = EXCLUDED.derived_from_memory_ids;
  `.trim(),
  selectActiveMemories: `
    SELECT * FROM ame_memories
    WHERE mind_id = $1 AND revoked_at IS NULL
    ORDER BY turn_index ASC, created_at ASC;
  `.trim(),
  insertTurnLog: `
    INSERT INTO ame_turn_log (
      turn_log_id, mind_id, turn_index, role, memory_id, derived_from_memory_ids,
      content, provider_used, model_used, fep_mode, free_energy, hot_abstained,
      kv_cache_epoch, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::text[],
      $7, $8, $9, $10, $11, $12,
      $13, COALESCE($14::timestamptz, NOW())
    )
    ON CONFLICT (turn_log_id) DO NOTHING;
  `.trim(),
  revokeDeleteMemory: `
    DELETE FROM ame_memories
    WHERE mind_id = $1 AND memory_id = $2;
  `.trim(),
  revokeRedactedDerivativeMemories: `
    UPDATE ame_memories
    SET assistant_summary = '[derivative redacted]',
        derived_from_memory_ids = array_remove(derived_from_memory_ids, $2)
    WHERE mind_id = $1 AND $2 = ANY(derived_from_memory_ids)
    RETURNING memory_id;
  `.trim(),
  revokeDeleteTurnLogs: `
    DELETE FROM ame_turn_log
    WHERE mind_id = $1 AND (memory_id = $2 OR $2 = ANY(derived_from_memory_ids));
  `.trim(),
  insertRevocationAudit: `
    INSERT INTO ame_revocation_audit (
      audit_receipt_id, mind_id, memory_id, revocation_epoch,
      excluded_derivative_ids, residual_leak_check, revoked_at
    ) VALUES (
      $1, $2, $3, $4,
      $5::text[], $6, COALESCE($7::timestamptz, NOW())
    )
    ON CONFLICT (audit_receipt_id) DO NOTHING;
  `.trim(),
  selectRevocationAudits: `
    SELECT * FROM ame_revocation_audit
    WHERE ($1::text IS NULL OR mind_id = $1)
    ORDER BY revoked_at DESC;
  `.trim(),
});

function cloneJsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toSet(input) {
  if (input instanceof Set) return new Set(input);
  if (Array.isArray(input)) return new Set(input.map(String));
  return new Set();
}

function toMap(input) {
  if (input instanceof Map) return new Map(input);
  if (Array.isArray(input)) return new Map(input);
  if (input && typeof input === 'object') return new Map(Object.entries(input));
  return new Map();
}

/**
 * Enforce D3 zero-resurrection invariants on a Mind record so revoked memories
 * and excluded derivative entries can never re-enter active memories or history.
 */
export function enforceD3Invariants(mind) {
  if (!mind) return mind;
  const revokedSet = toSet(mind.revokedMemoryIds);
  const excludedSet = toSet(mind.excludedDerivativeIds);

  mind.revokedMemoryIds = revokedSet;
  mind.excludedDerivativeIds = excludedSet;

  if (Array.isArray(mind.memories)) {
    mind.memories = mind.memories
      .filter((mem) => mem && mem.memoryId && !revokedSet.has(mem.memoryId))
      .map((mem) => {
        const derived = Array.isArray(mem.derivedFromMemoryIds)
          ? mem.derivedFromMemoryIds.filter((id) => !revokedSet.has(id))
          : [];
        const hasRevokedLineage =
          Array.isArray(mem.derivedFromMemoryIds) &&
          mem.derivedFromMemoryIds.some((id) => revokedSet.has(id));
        if (hasRevokedLineage || excludedSet.has(mem.memoryId)) {
          excludedSet.add(mem.memoryId);
          return {
            ...mem,
            assistantSummary: '[derivative redacted]',
            derivedFromMemoryIds: derived,
          };
        }
        return {
          ...mem,
          derivedFromMemoryIds: derived,
        };
      });
  } else {
    mind.memories = [];
  }

  if (Array.isArray(mind.history)) {
    mind.history = mind.history.filter((entry) => {
      if (!entry) return false;
      if (entry.memoryId && (revokedSet.has(entry.memoryId) || excludedSet.has(entry.memoryId))) {
        return false;
      }
      if (
        Array.isArray(entry.derivedFromMemoryIds) &&
        entry.derivedFromMemoryIds.some((id) => revokedSet.has(id) || excludedSet.has(id))
      ) {
        return false;
      }
      return true;
    });
  } else {
    mind.history = [];
  }

  return mind;
}

/**
 * Convert a live Mind runtime object into a plain JSON-safe record.
 * Deliberately excludes any transient LLM credentials (`apiKey`) if ever attached.
 */
export function serializeMind(mind) {
  enforceD3Invariants(mind);
  const nowIso = new Date().toISOString();
  const pendingTickets = [];
  if (mind.pendingTickets instanceof Map) {
    for (const [ticketId, ticket] of mind.pendingTickets.entries()) {
      pendingTickets.push([ticketId, cloneJsonSafe(ticket)]);
    }
  } else if (Array.isArray(mind.pendingTickets)) {
    for (const entry of mind.pendingTickets) {
      if (Array.isArray(entry) && entry.length === 2) {
        pendingTickets.push([String(entry[0]), cloneJsonSafe(entry[1])]);
      }
    }
  }

  return {
    mindId: String(mind.mindId),
    domain: String(mind.domain),
    persona: cloneJsonSafe({
      name: String(mind.persona?.name || ''),
      role: String(mind.persona?.role || ''),
      traits: mind.persona?.traits || {},
      backstory: mind.persona?.backstory || '',
      language: mind.persona?.language || 'ko',
    }),
    customSchema: mind.customSchema ? cloneJsonSafe(mind.customSchema) : null,
    safetyPolicy: cloneJsonSafe({
      strictAbstention: mind.safetyPolicy?.strictAbstention ?? true,
      antiSycophancy: mind.safetyPolicy?.antiSycophancy ?? true,
      crisisEscalation: mind.safetyPolicy?.crisisEscalation ?? false,
    }),
    turnCount: Number(mind.turnCount || 0),
    revocationEpoch: Number(mind.revocationEpoch || 1),
    kvCacheEpoch: Number(mind.kvCacheEpoch || 1),
    windowStart: Number(mind.windowStart || 0),
    compressCutoff: Number(mind.compressCutoff || 0),
    homeostasis: Number(mind.homeostasis ?? 0.72),
    cautionScore: Number(mind.cautionScore ?? 0),
    positiveScore: Number(mind.positiveScore ?? 0),
    freeEnergy: Number(mind.freeEnergy ?? 0.22),
    fepMode: String(mind.fepMode || 'automatic_low_fe'),
    hotAbstained: Boolean(mind.hotAbstained),
    lastSystemPrefixHash: mind.lastSystemPrefixHash || null,
    lastKvEpoch: Number(mind.lastKvEpoch || 0),
    lastEstimatedPrefixCachePct: Number(mind.lastEstimatedPrefixCachePct || 0),
    memories: cloneJsonSafe(mind.memories || []),
    history: cloneJsonSafe(mind.history || []),
    pendingTickets,
    revokedMemoryIds: Array.from(mind.revokedMemoryIds),
    excludedDerivativeIds: Array.from(mind.excludedDerivativeIds),
    revocationAudits: cloneJsonSafe(mind.revocationAudits || []),
    createdAt: mind.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Hydrate a serialized Mind JSON record back into the runtime Mind object
 * (with Map/Set structures restored and D3 invariants enforced).
 */
export function hydrateMind(raw) {
  if (!raw || typeof raw !== 'object' || !raw.mindId) return null;
  const mind = {
    mindId: String(raw.mindId),
    domain: String(raw.domain || 'companion_chat'),
    persona: cloneJsonSafe({
      name: String(raw.persona?.name || ''),
      role: String(raw.persona?.role || ''),
      traits: raw.persona?.traits || {},
      backstory: raw.persona?.backstory || '',
      language: raw.persona?.language || 'ko',
    }),
    customSchema: raw.customSchema ? cloneJsonSafe(raw.customSchema) : null,
    safetyPolicy: cloneJsonSafe({
      strictAbstention: raw.safetyPolicy?.strictAbstention ?? true,
      antiSycophancy: raw.safetyPolicy?.antiSycophancy ?? true,
      crisisEscalation: raw.safetyPolicy?.crisisEscalation ?? false,
    }),
    turnCount: Number(raw.turnCount || 0),
    revocationEpoch: Number(raw.revocationEpoch || 1),
    kvCacheEpoch: Number(raw.kvCacheEpoch || 1),
    windowStart: Number(raw.windowStart || 0),
    compressCutoff: Number(raw.compressCutoff || 0),
    homeostasis: Number(raw.homeostasis ?? 0.72),
    cautionScore: Number(raw.cautionScore ?? 0),
    positiveScore: Number(raw.positiveScore ?? 0),
    freeEnergy: Number(raw.freeEnergy ?? 0.22),
    fepMode: String(raw.fepMode || 'automatic_low_fe'),
    hotAbstained: Boolean(raw.hotAbstained),
    lastSystemPrefixHash: raw.lastSystemPrefixHash || null,
    lastKvEpoch: Number(raw.lastKvEpoch || 0),
    lastEstimatedPrefixCachePct: Number(raw.lastEstimatedPrefixCachePct || 0),
    memories: cloneJsonSafe(Array.isArray(raw.memories) ? raw.memories : []),
    history: cloneJsonSafe(Array.isArray(raw.history) ? raw.history : []),
    pendingTickets: toMap(raw.pendingTickets),
    revokedMemoryIds: toSet(raw.revokedMemoryIds),
    excludedDerivativeIds: toSet(raw.excludedDerivativeIds),
    revocationAudits: cloneJsonSafe(Array.isArray(raw.revocationAudits) ? raw.revocationAudits : []),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
  return enforceD3Invariants(mind);
}

function writeJsonAtomicSync(filePath, payload) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  );
  const serialized = JSON.stringify(payload, null, 2);

  try {
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.renameSync(tmpPath, resolved);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'EACCES') {
          throw err;
        }
      }
    }
    if (lastErr) throw lastErr;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

/**
 * Clean repository hooks mapping AME storage operations to PostgreSQL 17 + pgvector
 * (`deploy/init.sql`) and Redis epoch state.
 *
 * Accepts injected `{ pg, redis }` driver clients:
 *   - `pg.query(sql, params)`
 *   - `redis` supporting `set(key, val)` / `get(key)` / `sadd(key, ...members)` / `del(key)`
 */
export function createPostgresRedisHooks({ pg, redis } = {}) {
  function requireDrivers() {
    if (!pg || typeof pg.query !== 'function' || !redis) {
      const err = new Error(
        'postgres-redis storage mode requires injected { pg: { query }, redis } driver adapters aligned with deploy/init.sql'
      );
      err.status = 500;
      err.code = 'STORAGE_DRIVER_REQUIRED';
      throw err;
    }
  }

  return {
    ddlRef: POSTGRES_DDL_REF,
    sql: POSTGRES_REDIS_SQL,

    async load() {
      requireDrivers();
      const mindsRes = await pg.query(POSTGRES_REDIS_SQL.listMinds, []);
      const minds = [];
      for (const row of mindsRes?.rows || []) {
        const memRes = await pg.query(POSTGRES_REDIS_SQL.selectActiveMemories, [row.mind_id]);
        const auditRes = await pg.query(POSTGRES_REDIS_SQL.selectRevocationAudits, [row.mind_id]);
        const revokedIds = (auditRes?.rows || []).map((r) => r.memory_id);
        const excludedIds = (auditRes?.rows || []).flatMap((r) => r.excluded_derivative_ids || []);
        const hydrated = hydrateMind({
          mindId: row.mind_id,
          domain: row.domain,
          persona: row.persona_json,
          customSchema: row.custom_schema_json,
          safetyPolicy: row.safety_policy_json,
          turnCount: row.turn_count,
          revocationEpoch: row.revocation_epoch,
          kvCacheEpoch: row.kv_cache_epoch,
          windowStart: row.window_start,
          compressCutoff: row.compress_cutoff,
          homeostasis: row.homeostasis,
          cautionScore: row.caution_score,
          positiveScore: row.positive_score,
          freeEnergy: row.free_energy,
          fepMode: row.fep_mode,
          hotAbstained: row.hot_abstained,
          lastSystemPrefixHash: row.last_system_prefix_hash,
          lastKvEpoch: row.last_kv_epoch,
          lastEstimatedPrefixCachePct: row.last_estimated_prefix_cache_pct,
          memories: (memRes?.rows || []).map((m) => ({
            memoryId: m.memory_id,
            summary: m.summary,
            content: m.content,
            assistantSummary: m.assistant_summary,
            salience: m.salience,
            turnIndex: m.turn_index,
            tags: m.tags || [],
            derivedFromMemoryIds: m.derived_from_memory_ids || [],
            createdAt: m.created_at,
          })),
          revokedMemoryIds: revokedIds,
          excludedDerivativeIds: excludedIds,
          revocationAudits: auditRes?.rows || [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        if (hydrated) minds.push(hydrated);
      }
      return { minds, revocationAudits: [] };
    },

    async saveMind(mind) {
      requireDrivers();
      const s = serializeMind(mind);
      await pg.query(POSTGRES_REDIS_SQL.upsertMind, [
        s.mindId,
        s.domain,
        s.persona.name,
        JSON.stringify(s.persona),
        s.customSchema ? JSON.stringify(s.customSchema) : null,
        JSON.stringify(s.safetyPolicy),
        s.turnCount,
        s.revocationEpoch,
        s.kvCacheEpoch,
        s.windowStart,
        s.compressCutoff,
        s.homeostasis,
        s.cautionScore,
        s.positiveScore,
        s.freeEnergy,
        s.fepMode,
        s.hotAbstained,
        s.lastSystemPrefixHash,
        s.lastKvEpoch,
        s.lastEstimatedPrefixCachePct,
        s.createdAt,
      ]);

      for (const mem of s.memories) {
        await pg.query(POSTGRES_REDIS_SQL.upsertMemory, [
          mem.memoryId,
          s.mindId,
          mem.summary,
          mem.content,
          mem.assistantSummary || '',
          mem.salience,
          mem.turnIndex,
          mem.tags || [],
          mem.derivedFromMemoryIds || [],
          mem.createdAt ? new Date(mem.createdAt).toISOString() : null,
        ]);
      }

      if (typeof redis.set === 'function') {
        await redis.set(`ame:mind:${s.mindId}:revocation_epoch`, String(s.revocationEpoch));
        await redis.set(`ame:mind:${s.mindId}:kv_epoch`, String(s.kvCacheEpoch));
      }
      return s;
    },

    async getMind(mindId) {
      requireDrivers();
      const res = await pg.query(POSTGRES_REDIS_SQL.selectMindById, [mindId]);
      const row = res?.rows?.[0];
      if (!row) return undefined;
      const memRes = await pg.query(POSTGRES_REDIS_SQL.selectActiveMemories, [mindId]);
      const auditRes = await pg.query(POSTGRES_REDIS_SQL.selectRevocationAudits, [mindId]);
      return hydrateMind({
        mindId: row.mind_id,
        domain: row.domain,
        persona: row.persona_json,
        customSchema: row.custom_schema_json,
        safetyPolicy: row.safety_policy_json,
        turnCount: row.turn_count,
        revocationEpoch: row.revocation_epoch,
        kvCacheEpoch: row.kv_cache_epoch,
        windowStart: row.window_start,
        compressCutoff: row.compress_cutoff,
        homeostasis: row.homeostasis,
        cautionScore: row.caution_score,
        positiveScore: row.positive_score,
        freeEnergy: row.free_energy,
        fepMode: row.fep_mode,
        hotAbstained: row.hot_abstained,
        lastSystemPrefixHash: row.last_system_prefix_hash,
        lastKvEpoch: row.last_kv_epoch,
        lastEstimatedPrefixCachePct: row.last_estimated_prefix_cache_pct,
        memories: (memRes?.rows || []).map((m) => ({
          memoryId: m.memory_id,
          summary: m.summary,
          content: m.content,
          assistantSummary: m.assistant_summary,
          salience: m.salience,
          turnIndex: m.turn_index,
          tags: m.tags || [],
          derivedFromMemoryIds: m.derived_from_memory_ids || [],
          createdAt: m.created_at,
        })),
        revokedMemoryIds: (auditRes?.rows || []).map((r) => r.memory_id),
        excludedDerivativeIds: (auditRes?.rows || []).flatMap(
          (r) => r.excluded_derivative_ids || []
        ),
        revocationAudits: auditRes?.rows || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    },

    async deleteMemoryAndRevoke(mindId, memoryId, revocationRecord) {
      requireDrivers();
      await pg.query(POSTGRES_REDIS_SQL.revokeDeleteMemory, [mindId, memoryId]);
      const redactedRes = await pg.query(POSTGRES_REDIS_SQL.revokeRedactedDerivativeMemories, [
        mindId,
        memoryId,
      ]);
      await pg.query(POSTGRES_REDIS_SQL.revokeDeleteTurnLogs, [mindId, memoryId]);

      const derivedFromSql = (redactedRes?.rows || []).map((r) => r.memory_id);
      const excludedDerivativeIds = Array.from(
        new Set([...(revocationRecord?.excludedDerivativeIds || []), ...derivedFromSql])
      );

      const receipt = {
        auditReceiptId: revocationRecord?.auditReceiptId || `rcpt_${crypto.randomUUID().slice(0, 12)}`,
        mindId,
        memoryId,
        revocationEpoch: Number(revocationRecord?.revocationEpoch || 1),
        excludedDerivativeIds,
        residualLeakCheck: revocationRecord?.residualLeakCheck || '0.00%',
        revokedAt: revocationRecord?.revokedAt || new Date().toISOString(),
      };

      await pg.query(POSTGRES_REDIS_SQL.insertRevocationAudit, [
        receipt.auditReceiptId,
        mindId,
        memoryId,
        receipt.revocationEpoch,
        receipt.excludedDerivativeIds,
        receipt.residualLeakCheck,
        receipt.revokedAt,
      ]);

      if (typeof redis.set === 'function') {
        await redis.set(`ame:mind:${mindId}:revocation_epoch`, String(receipt.revocationEpoch));
      }
      if (typeof redis.sadd === 'function') {
        await redis.sadd(`ame:mind:${mindId}:revoked_memories`, memoryId);
        if (excludedDerivativeIds.length > 0) {
          await redis.sadd(`ame:mind:${mindId}:excluded_derivatives`, ...excludedDerivativeIds);
        }
      }
      return receipt;
    },

    async listMinds() {
      const { minds } = await this.load();
      return minds;
    },
  };
}

/**
 * Create a pluggable AME storage instance.
 *
 * @param {{
 *   mode?: 'memory' | 'file' | 'postgres-redis',
 *   filePath?: string,
 *   pg?: { query: Function },
 *   redis?: Record<string, Function>
 * }} [options]
 */
export function createStorage({
  mode = process.env.AME_STORAGE_MODE || 'memory',
  filePath = process.env.AME_STORAGE_PATH || './.ame-sandbox-state.json',
  pg,
  redis,
} = {}) {
  const normalizedMode = String(mode || 'memory').trim().toLowerCase();
  if (!VALID_STORAGE_MODES.includes(normalizedMode)) {
    throw new TypeError(
      `Unsupported AME storage mode "${mode}". Expected one of: ${VALID_STORAGE_MODES.join(', ')}`
    );
  }

  if (normalizedMode === 'postgres-redis') {
    const hooks = createPostgresRedisHooks({ pg, redis });
    if (!pg || !redis) {
      throw new Error(
        'AME_STORAGE_MODE=postgres-redis requires injected { pg, redis } driver adapters aligned with deploy/init.sql. Use "memory" or "file" for zero-dependency sandbox mode.'
      );
    }
    return {
      mode: 'postgres-redis',
      ddlRef: POSTGRES_DDL_REF,
      ...hooks,
      getRevocationAudits: async (mindId = null) => {
        const res = await pg.query(POSTGRES_REDIS_SQL.selectRevocationAudits, [mindId]);
        return res?.rows || [];
      },
    };
  }

  const resolvedFilePath = normalizedMode === 'file' ? path.resolve(filePath) : null;
  const minds = new Map();
  let revocationAudits = [];

  function flushToDiskIfFile() {
    if (normalizedMode !== 'file') return;
    const mindsPayload = {};
    for (const [id, mind] of minds.entries()) {
      mindsPayload[id] = serializeMind(mind);
    }
    writeJsonAtomicSync(resolvedFilePath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      minds: mindsPayload,
      revocationAudits: cloneJsonSafe(revocationAudits),
    });
  }

  function load() {
    if (normalizedMode === 'memory') {
      return {
        mode: 'memory',
        minds: Array.from(minds.values()),
        revocationAudits: cloneJsonSafe(revocationAudits),
      };
    }

    minds.clear();
    revocationAudits = [];

    if (!fs.existsSync(resolvedFilePath)) {
      return {
        mode: 'file',
        filePath: resolvedFilePath,
        minds: [],
        revocationAudits: [],
      };
    }

    const rawText = fs.readFileSync(resolvedFilePath, 'utf8').trim();
    if (!rawText) {
      return {
        mode: 'file',
        filePath: resolvedFilePath,
        minds: [],
        revocationAudits: [],
      };
    }

    const parsed = JSON.parse(rawText);
    const audits = Array.isArray(parsed?.revocationAudits) ? parsed.revocationAudits : [];
    revocationAudits = cloneJsonSafe(audits);

    const auditsByMind = new Map();
    for (const audit of revocationAudits) {
      if (!audit?.mindId) continue;
      if (!auditsByMind.has(audit.mindId)) auditsByMind.set(audit.mindId, []);
      auditsByMind.get(audit.mindId).push(audit);
    }

    const rawMinds = parsed?.minds && typeof parsed.minds === 'object' ? parsed.minds : {};
    for (const [mindId, rawMind] of Object.entries(rawMinds)) {
      const hydrated = hydrateMind(rawMind);
      if (!hydrated) continue;
      const mindAudits = auditsByMind.get(mindId) || [];
      for (const audit of mindAudits) {
        if (audit.memoryId) hydrated.revokedMemoryIds.add(audit.memoryId);
        if (Array.isArray(audit.excludedDerivativeIds)) {
          for (const dId of audit.excludedDerivativeIds) {
            hydrated.excludedDerivativeIds.add(dId);
          }
        }
      }
      enforceD3Invariants(hydrated);
      minds.set(mindId, hydrated);
    }

    return {
      mode: 'file',
      filePath: resolvedFilePath,
      minds: Array.from(minds.values()),
      revocationAudits: cloneJsonSafe(revocationAudits),
    };
  }

  function saveMind(mind) {
    if (!mind || !mind.mindId) {
      throw new TypeError('saveMind requires a Mind object with mindId');
    }
    if (!(mind.pendingTickets instanceof Map)) {
      mind.pendingTickets = toMap(mind.pendingTickets);
    }
    if (!(mind.revokedMemoryIds instanceof Set)) {
      mind.revokedMemoryIds = toSet(mind.revokedMemoryIds);
    }
    if (!(mind.excludedDerivativeIds instanceof Set)) {
      mind.excludedDerivativeIds = toSet(mind.excludedDerivativeIds);
    }
    if (!Array.isArray(mind.revocationAudits)) {
      mind.revocationAudits = [];
    }
    enforceD3Invariants(mind);
    mind.updatedAt = new Date().toISOString();
    minds.set(mind.mindId, mind);
    flushToDiskIfFile();
    return mind;
  }

  function getMind(mindId) {
    return minds.get(mindId);
  }

  function listMinds() {
    return Array.from(minds.values());
  }

  function deleteMemoryAndRevoke(mindId, memoryId, revocationRecord = {}) {
    const mind = minds.get(mindId);
    if (!mind) return null;

    if (!(mind.revokedMemoryIds instanceof Set)) {
      mind.revokedMemoryIds = toSet(mind.revokedMemoryIds);
    }
    if (!(mind.excludedDerivativeIds instanceof Set)) {
      mind.excludedDerivativeIds = toSet(mind.excludedDerivativeIds);
    }
    if (!Array.isArray(mind.revocationAudits)) {
      mind.revocationAudits = [];
    }

    mind.revokedMemoryIds.add(memoryId);
    if (Array.isArray(revocationRecord.excludedDerivativeIds)) {
      for (const dId of revocationRecord.excludedDerivativeIds) {
        mind.excludedDerivativeIds.add(dId);
      }
    }
    if (typeof revocationRecord.revocationEpoch === 'number') {
      mind.revocationEpoch = Math.max(mind.revocationEpoch || 1, revocationRecord.revocationEpoch);
    }

    enforceD3Invariants(mind);

    const record = {
      auditReceiptId:
        revocationRecord.auditReceiptId || `rcpt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      mindId,
      memoryId,
      revocationEpoch: mind.revocationEpoch,
      excludedDerivativeIds: Array.from(mind.excludedDerivativeIds),
      residualLeakCheck: revocationRecord.residualLeakCheck || '0.00%',
      revokedAt: revocationRecord.revokedAt || new Date().toISOString(),
    };

    mind.revocationAudits.push(record);
    revocationAudits.push(record);
    mind.updatedAt = record.revokedAt;

    flushToDiskIfFile();
    return record;
  }

  function getRevocationAudits(mindId = null) {
    if (!mindId) return cloneJsonSafe(revocationAudits);
    return cloneJsonSafe(revocationAudits.filter((r) => r.mindId === mindId));
  }

  return {
    mode: normalizedMode,
    filePath: resolvedFilePath,
    ddlRef: POSTGRES_DDL_REF,
    load,
    saveMind,
    getMind,
    listMinds,
    deleteMemoryAndRevoke,
    getRevocationAudits,
  };
}
