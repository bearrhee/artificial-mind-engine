# Companion Chat Example (`Sora`)

Demonstrates the **`companion_chat`** vertical using **Mode B (Zero-Key `prepare -> local LLM -> settle`)** via `createLlmAdapter(...)` and `runTurnWithLocalLlm(...)`, **KV-prefix epoch consistency**, **D2 overnight idle ticks**, and **multi-turn personal memory continuity**.

## What This Example Exercises

1. **Mode B Zero-Key Flow**:
   - The AME Gateway prepares prefix-stable prompts, FEP thought lock, and safety directives (`POST /v1/minds/{mindId}/prepare`).
   - Your client executes the LLM call locally via `createLlmAdapter(...)` (no LLM API keys are ever sent to the AME server).
   - The client settles the response back into somatic markers and episodic memory (`POST /v1/minds/{mindId}/settle`).
2. **Multi-Turn Personal Seeding & Continuity Recall (5 Turns)**:
   - **Turn 1**: Seeds user's dog `Mochi`.
   - **Turn 2**: Seeds favorite drink `roasted barley tea`.
   - **Turn 3**: Seeds long-term goal `Seoul Marathon`.
   - **Turn 4**: Evening wind-down check-in.
   - **Offline Gap (D2)**: `idleTick({ elapsedHours: 8, reason: 'overnight_gap' })`.
   - **Turn 5**: Morning continuity recall question verifying `memoryRefs.length > 0`.
3. **D1 KV-Cache Prefix Consistency**:
   - Tracks `kvCache.epoch`, `kvCache.windowStart`, `kvCache.compressCutoff`, `kvCache.systemPrefixHash`, `kvCache.cachedRatioPct`, and `telemetry.estimatedPrefixCachePct` across all turns.
   - Asserts that non-revoked turns maintain an identical `kvCache.epoch` and `systemPrefixHash`, and `telemetry.d4Redacted === true`.

```text
AME Gateway ──prepare──► Client Adapter (local Ollama/vLLM, OpenAI, or mock) ──settle──► AME Gateway
   ▲                                                                                          │
   └────────────────── Stable kvCache.epoch & systemPrefixHash across 5 turns ────────────────┘
```

## Quickstart (Zero-Key Sandbox Mode)

```bash
# Terminal 1: start the local AME sandbox server
npm run sandbox

# Terminal 2: run the Companion Chat vertical
npm run example:chat
# or directly:
node examples/companion-chat/run.mjs
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AME_BASE_URL` | `http://127.0.0.1:8090` | AME Gateway / Sandbox base URL |
| `AME_API_KEY` | `dev-sandbox-key` | Gateway API key (`X-AME-API-Key`) |
| `AME_LOCAL_LLM_URL` | _(unset)_ | OpenAI-compatible local URL (e.g., `http://127.0.0.1:11434/v1` for Ollama) |
| `AME_LOCAL_LLM_MODEL` | `local-model` | Model name for `AME_LOCAL_LLM_URL` |
| `OPENAI_API_KEY` | _(unset -> mock)_ | Enables local Mode B calls to OpenAI (`gpt-4o-mini` by default) |
| `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | _(unset -> mock)_ | Alternative Mode B provider keys if OpenAI / local URL are unset |
