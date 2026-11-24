-- ==============================================================================
-- Artificial Mind Engine (AME) — PostgreSQL 17 + pgvector Reference Schema
-- ==============================================================================
-- Aligned with packages/sandbox-server/src/storage.mjs (POSTGRES_DDL_REF).
-- Supports persistent Mind state, vector-indexed memories, turn audit logs,
-- and D3 Triple Atomic Memory Revocation audit ledger.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ame_minds (
  mind_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK (domain IN ('game_npc', 'companion_chat', 'counseling_coach', 'custom')),
  persona_name TEXT NOT NULL,
  persona_json JSONB NOT NULL,
  custom_schema_json JSONB,
  safety_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  revocation_epoch INTEGER NOT NULL DEFAULT 1 CHECK (revocation_epoch >= 1),
  kv_cache_epoch INTEGER NOT NULL DEFAULT 1 CHECK (kv_cache_epoch >= 1),
  window_start INTEGER NOT NULL DEFAULT 0 CHECK (window_start >= 0),
  compress_cutoff INTEGER NOT NULL DEFAULT 0 CHECK (compress_cutoff >= 0),
  homeostasis DOUBLE PRECISION NOT NULL DEFAULT 0.72,
  caution_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  positive_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  free_energy DOUBLE PRECISION NOT NULL DEFAULT 0.22,
  fep_mode TEXT NOT NULL DEFAULT 'automatic_low_fe' CHECK (fep_mode IN ('automatic_low_fe', 'locked_high_fe')),
  hot_abstained BOOLEAN NOT NULL DEFAULT FALSE,
  last_system_prefix_hash TEXT,
  last_kv_epoch INTEGER NOT NULL DEFAULT 0,
  last_estimated_prefix_cache_pct DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ame_memories (
  memory_id TEXT PRIMARY KEY,
  mind_id TEXT NOT NULL REFERENCES ame_minds(mind_id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  assistant_summary TEXT NOT NULL DEFAULT '',
  salience DOUBLE PRECISION NOT NULL DEFAULT 0.42,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 1),
  tags TEXT[] NOT NULL DEFAULT '{}',
  derived_from_memory_ids TEXT[] NOT NULL DEFAULT '{}',
  embedding vector(1024),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ame_turn_log (
  turn_log_id TEXT PRIMARY KEY,
  mind_id TEXT NOT NULL REFERENCES ame_minds(mind_id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  memory_id TEXT,
  derived_from_memory_ids TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  provider_used TEXT,
  model_used TEXT,
  fep_mode TEXT CHECK (fep_mode IN ('automatic_low_fe', 'locked_high_fe')),
  free_energy DOUBLE PRECISION,
  hot_abstained BOOLEAN NOT NULL DEFAULT FALSE,
  kv_cache_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ame_revocation_audit (
  audit_receipt_id TEXT PRIMARY KEY,
  mind_id TEXT NOT NULL REFERENCES ame_minds(mind_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL CHECK (revocation_epoch >= 1),
  excluded_derivative_ids TEXT[] NOT NULL DEFAULT '{}',
  residual_leak_check TEXT NOT NULL DEFAULT '0.00%',
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for Mind lookup, D3 zero-resurrection active memory queries, and HNSW vector recall
CREATE INDEX IF NOT EXISTS idx_ame_minds_domain
  ON ame_minds (domain, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ame_memories_mind_active
  ON ame_memories (mind_id, turn_index DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ame_memories_derived
  ON ame_memories USING GIN (derived_from_memory_ids);

CREATE INDEX IF NOT EXISTS idx_ame_memories_embedding_hnsw
  ON ame_memories USING hnsw (embedding vector_cosine_ops)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ame_turn_log_mind_turn
  ON ame_turn_log (mind_id, turn_index ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_ame_turn_log_memory
  ON ame_turn_log (mind_id, memory_id);

CREATE INDEX IF NOT EXISTS idx_ame_turn_log_derived
  ON ame_turn_log USING GIN (derived_from_memory_ids);

CREATE INDEX IF NOT EXISTS idx_ame_revocation_audit_mind_epoch
  ON ame_revocation_audit (mind_id, revocation_epoch DESC);
