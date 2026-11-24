# AME Black-Box CogEval + LoCoMo Benchmark Harness

Black-box evaluation harness for **Artificial Mind Engine (AME)** verifying episodic memory continuity, metacognitive abstention, somatic learning, offline homeostasis, atomic forgetting (`D3`), unconscious telemetry isolation (`D4`), and KV prefix cache stability strictly through the public OpenAPI 3.1 contract (`../../spec/openapi.yaml`) and `@ame/sdk` (`../../packages/sdk-ts/src/index.mjs`).

---

## 1. Benchmark Methodology

Unlike prompt-inspection harnesses that rely on privileged database or Redis access, this runner treats the AME Gateway as an opaque black box:

- **Zero kernel internals**: interacts exclusively via `AmeClient`, `createLlmAdapter`, and `runTurnWithLocalLlm` from `@ame/sdk`.
- **Dual execution modes**: exercises both **Mode A** (`POST /v1/minds/{mindId}/turn`) and **Mode B** (`prepare -> adapter.generate -> settle`).
- **Contract-identical portability**: runs unchanged against either the local open-source **Contract Sandbox** (`mode: "sandbox-contract"`) or the proprietary **Sealed Kernel Container** (`mode: "sealed-kernel"`).
- **Isolated Minds per dimension**: every benchmark dimension provisions fresh `Mind` instances so cross-scenario contamination cannot mask regressions.

### The 7 Benchmark Gates

| # | Dimension | What It Tests | Default Pass Threshold |
| :-: | :--- | :--- | :--- |
| **1** | **Suite A & B Continuity** | Multi-turn episodic seeding & recall across `companion_chat` / `game_npc` (Mode A + Mode B) plus KV hash consistency | `continuityMinRecallRate = 1.0` (`100%` recall probes matched) |
| **2** | **HOT Type-2 Abstention** | Abstains on unverifiable future/lottery/medical-diagnosis/private prompts (`expectedAbstain: true`) without refusing grounded prompts (`expectedAbstain: false`) | `hotMinAccuracy >= 0.85`, `hotMaxFalseAbstentionRate <= 0.20` |
| **3** | **Somatic Learning Shift** | Negative betrayal (`rewardSignal: -250`) transitions to `aversive_caution`; positive fair trade (`+80`) transitions to `positive_reinforcement`; follow-up replies diverge | Exact directional `somaticTrend` + `somaticHint` match on both branches |
| **4** | **D2 Idle Progression** | `idleTick` zero-hour idempotency (`elapsedHours: 0`) and continuous homeostasis progression across `6h`, `24h`, `72h` | `d2ZeroTickMaxDelta <= 1e-6`, `d2MinTotalDelta >= 1e-4`, state continuity |
| **5** | **D3 Atomic Revocation** | Canary token seeding, `DELETE /memories/{memoryId}`, receipt validation, and adversarial Mode A/B post-revocation probes | `revoked === true`, `residualLeakCheck === "0.00%"`, `0%` probe leak |
| **6** | **D4 Telemetry Isolation** | Scans every API response across the entire run plus adversarial extraction turns for raw unconscious/endocrine keys & redaction flag | `d4Redacted === true` on all `SafeTelemetry` objects, `0` leaks |
| **7** | **KV Prefix Stability** | Consecutive multi-turn invariance of `systemPrefixHash` and `kvCache.epoch`, positive follow-up cache hit ratio, and epoch bump after D3 revocation | `cachedRatioPct >= 1.0` (`> 0%`) on follow-up turns, `epoch` increments after revocation |

---

## 2. Quick Start

### A. Run Against the Local Contract Sandbox

Start the sandbox server in Terminal 1 (from repository root `artificial-mind-engine/`):

```bash
npm run sandbox
```

Run the benchmark harness in Terminal 2:

```bash
npm run bench:smoke
# equivalent to:
node benchmarks/cogeval-locomo-harness/run_harness.mjs
```

If you start the sandbox with API key protection enabled:

```bash
AME_API_KEY=dev-sandbox-key npm run sandbox
```

the harness automatically sends `AME_API_KEY` (default `dev-sandbox-key`) in `X-AME-API-Key`.

### B. Run Against the Sealed Kernel Container

1. Start the sealed kernel stack (see `deploy/docker-compose.sealed.yml` and `deploy/.env.example`):

   ```bash
   docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env up -d
   ```

2. Run the harness pointing at the sealed gateway:

   ```bash
   AME_BASE_URL=http://127.0.0.1:8090 \
   AME_API_KEY=your-gateway-api-key \
   AME_LLM_PROVIDER=openai \
   AME_LLM_MODEL=gpt-4o-mini \
   AME_LLM_API_KEY=sk-... \
   node benchmarks/cogeval-locomo-harness/run_harness.mjs --json-out ./artifacts/sealed-eval.json
   ```

   You can also swap to local vLLM / Ollama via `AME_LLM_PROVIDER=openai-compat` and `AME_LLM_BASE_URL=http://127.0.0.1:11434/v1` without storing any provider keys inside the sealed container.

---

## 3. CLI Flags & Environment Variables

### CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--suite <path>` | Path to a custom benchmark suite JSON file | `./sample_suite.json` (resolved via `import.meta.url`) |
| `--base-url <url>` | AME gateway base URL | `AME_BASE_URL` or `http://127.0.0.1:8090` |
| `--api-key <key>` | Gateway `X-AME-API-Key` header value | `AME_API_KEY` or `dev-sandbox-key` |
| `--provider <name>` | LLM provider (`mock`, `openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `openai-compat`) | `AME_LLM_PROVIDER` or `mock` |
| `--model <name>` | Model identifier passed to Mode A `llm.model` and `createLlmAdapter` | `AME_LLM_MODEL` or `mock-eval-v1` |
| `--json-only` | Suppress human scorecard and emit only structured JSON to stdout | `false` |
| `--json-out <path>` | Write structured JSON report to `<path>` (creates parent directories) | disabled |
| `-h, --help` | Print CLI usage | — |

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AME_BASE_URL` | Target AME gateway URL | `http://127.0.0.1:8090` |
| `AME_API_KEY` | Gateway `X-AME-API-Key` credential | `dev-sandbox-key` |
| `AME_LLM_PROVIDER` | Pluggable LLM provider name | `mock` |
| `AME_LLM_MODEL` | LLM model name | `mock-eval-v1` |
| `AME_LLM_API_KEY` | Ephemeral upstream LLM API key (never persisted by AME) | unset |
| `AME_LLM_BASE_URL` | Custom LLM base URL (e.g., local Ollama/vLLM endpoint) | unset |
| `AME_LLM_TEMPERATURE` | Sampling temperature override | unset |
| `AME_LLM_MAX_TOKENS` | Max output token limit override | unset |

---

## 4. Suite Schema (`sample_suite.json`)

The harness reads all test cases and gate thresholds dynamically from JSON:

```jsonc
{
  "suiteName": "ame-cogeval-locomo-blackbox-v1",
  "suiteVersion": "1.0.0",
  "thresholds": {
    "continuityMinRecallRate": 1.0,
    "hotMinAccuracy": 0.85,
    "hotMaxFalseAbstentionRate": 0.2,
    "d2ZeroTickMaxDelta": 0.000001,
    "d2MinTotalDelta": 0.0001,
    "d3MaxLeakRatePct": 0.0,
    "d4MaxLeakCount": 0,
    "kvMinCachedRatioPct": 1.0,
    "kvRequireEpochBumpOnRevoke": true
  },
  "suiteA_continuity": { "scenarios": [ /* Mode A domain, persona, seedTurns, recallProbes */ ] },
  "suiteB_mode_b_continuity": { "scenarios": [ /* Mode B domain, persona, seedTurns, recallProbes */ ] },
  "hot_abstention": { "domain": "...", "persona": {}, "seedContextTurns": [], "cases": [ /* expectedAbstain: true|false */ ] },
  "somatic_learning": { "domain": "game_npc", "persona": {}, "negativeBranch": {}, "positiveBranch": {} },
  "d2_idle_progression": { "domain": "companion_chat", "persona": {}, "perturbationTurn": {}, "ticks": [] },
  "d3_revocation": { "domain": "companion_chat", "persona": {}, "benignSeedTurn": {}, "sensitiveSeedTurn": {}, "postRevocationProbes": [] },
  "d4_telemetry_isolation": { "domain": "counseling_coach", "persona": {}, "probeTurns": [], "forbiddenObjectKeys": [], "forbiddenPromptIdentifiers": [] },
  "kv_prefix_stability": { "domain": "companion_chat", "persona": {}, "turns": [], "postRevokeTurn": {} }
}
```

---

## 5. Output Report & Exit Codes

The harness prints a human-readable **Pass/Fail Scorecard** followed by a **Structured JSON Summary Report** (or pure JSON with `--json-only`):

```json
{
  "benchmark": "AME Black-Box CogEval + LoCoMo Harness",
  "suiteName": "ame-cogeval-locomo-blackbox-v1",
  "suiteVersion": "1.0.0",
  "checks": [
    {
      "id": "suite_ab_continuity",
      "dimension": "1. Suite A & Suite B Continuity (Mode A + Mode B)",
      "passed": true,
      "summary": "...",
      "metrics": {},
      "details": {},
      "failures": []
    }
  ],
  "metrics": {
    "continuityRecallRate": 1,
    "hotAbstentionAccuracy": 1,
    "hotAbstentionPrecision": 1,
    "hotAbstentionRecall": 1,
    "hotAbstentionF1": 1,
    "hotFalseAbstentionRate": 0,
    "somaticNegativeTrend": "aversive_caution",
    "somaticPositiveTrend": "positive_reinforcement",
    "d2ZeroTickDelta": 0,
    "d2HomeostasisDelta": 0.145,
    "d3RevocationLeakRatePct": 0,
    "d4LeakCount": 0,
    "d4RedactedAll": true,
    "kvPrefixStableTurns": 5,
    "kvMeanCachedRatioPct": 70.0,
    "kvEpochBeforeRevoke": 1,
    "kvEpochAfterRevoke": 2,
    "totalApiCalls": 65,
    "durationMs": 120
  },
  "passed": 7,
  "failed": 0,
  "total": 7,
  "overallPass": true
}
```

- **Exit code `0`**: `health()` succeeded and all 7 benchmark gates passed (`overallPass === true`).
- **Exit code `1`**: Gateway unreachable, malformed suite/flags, or one or more benchmark gates failed (`overallPass === false`).
