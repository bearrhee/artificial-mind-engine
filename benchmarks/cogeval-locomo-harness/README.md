# AME Black-Box CogEval + LoCoMo + LongMemEval-S Benchmark Suite

Black-box evaluation suite for **Artificial Mind Engine (AME)** verifying episodic memory continuity, metacognitive abstention, somatic learning, offline homeostasis, atomic forgetting (`D3`), unconscious telemetry isolation (`D4`), KV prefix cache stability, and paired **LongMemEval-S vs Bare Frontier** unit economics strictly through the public OpenAPI 3.1 contract (`../../spec/openapi.yaml`) and `@ame/sdk` (`../../packages/sdk-ts/src/index.mjs`).

---

## Suite Components

| File | Role | Notes |
| :--- | :--- | :--- |
| `run_harness.mjs` | 7-Gate CogEval + LoCoMo Black-Box Harness | Exercises Mode A + Mode B across all 7 invariants |
| `sample_suite.json` | Default 7-gate smoke suite | Korean/English synthetic scenarios & safety probes |
| `longmemeval_frontier_runner.mjs` | LongMemEval-S + Bare Frontier Paired Comparator | Supports up to full 500-QA `longmemeval_s_cleaned.json` |
| `sample_longmemeval.json` | 10-item synthetic offline smoke fixture | Strictly offline smoke verification (zero external claims) |
| `dd_scorecard_generator.mjs` | Institutional VC Technical DD Scorecard Generator | Synthesizes Markdown + JSON with strict tier isolation |
| `test/harness.test.mjs` | Automated `node --test` integration suite | Runs sandbox + local HTTP LLM stub (zero API cost) |

---

## 1. Benchmark Methodology (`run_harness.mjs`)

Unlike prompt-inspection harnesses that rely on privileged database or Redis access, this suite treats the AME Gateway as an opaque black box:

- **Zero kernel internals**: interacts exclusively via `AmeClient`, `createLlmAdapter`, and `runTurnWithLocalLlm` from `@ame/sdk`.
- **Dual execution modes**: exercises both **Mode A** (`POST /v1/minds/{mindId}/turn`) and **Mode B** (`prepare -> adapter.generate -> settle`).
- **Contract-identical portability**: runs unchanged against either the local open-source **Contract Sandbox** (`mode: "sandbox-contract"`) or the proprietary **Sealed Kernel Container** (`mode: "sealed-kernel"`).
- **Isolated Minds per dimension**: every benchmark dimension provisions fresh `Mind` instances so cross-scenario contamination cannot mask regressions.

### The 7 Benchmark Gates (`run_harness.mjs`)

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

## 2. Quick Start (`run_harness.mjs`)

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
   node benchmarks/cogeval-locomo-harness/run_harness.mjs --json-out ./artifacts/harness-sealed.json
   ```

   You can also swap to local vLLM / Ollama via `AME_LLM_PROVIDER=openai-compat` and `AME_LLM_BASE_URL=http://127.0.0.1:11434/v1` without storing any provider keys inside the sealed container.

---

## 3. LongMemEval-S + Bare Frontier Paired Comparator (`longmemeval_frontier_runner.mjs`)

`longmemeval_frontier_runner.mjs` provides a black-box paired comparator between:

- **`ame-gateway`**: provisions an isolated Mind per question via `AmeClient`, ingests `haystack_sessions` turns sequentially with timestamps, queries via Mode B (`prepare -> adapter.generate -> settle`, default for exact prompt-token visibility) or Mode A (`/turn`), and records Exact Match, Contains Match, Token-F1, `abstentionAccuracy`, `abstentionFAR`, KV `cachedRatioPct`, `O(1)` bounded prompt tokens vs haystack length, query latency `p50`/`p95`, and `d4RedactedAll`.
- **`bare-frontier`**: packs all dated `haystack_sessions` into a single flattened stateless prompt and calls the user-selected frontier LLM via `createLlmAdapter` (`openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `openai-compat`, `mock`), measuring raw `O(T)` single-query / `O(T^2)` replay prompt tokens, accuracy, and latency.
- **`pairedDelta`**: computes `accuracyDeltaPct`, `tokenReductionRatio`, `tokenCompressionFactor`, `amePromptBounded`, and `d4RedactedAll`.

### Running on the 10-Item Synthetic Offline Smoke Fixture (`sample_longmemeval.json`)

> [!NOTE]
> `sample_longmemeval.json` is a 10-item synthetic offline smoke dataset covering `single-session-user`, `temporal-reasoning`, `knowledge-update`, `multi-session`, and `abstention` (`_abs`) schemas. It contains zero real-world benchmark claims and is designed for schema, contract, and `O(1)` prompt-bounding verification. (When run with `--provider mock`, `@ame/sdk`'s built-in Korean mock checks pipeline plumbing, `O(1)` bounding, KV cache, and D4 redaction; use a real LLM provider or the test suite's local HTTP frontier stub to evaluate English QA accuracy.)

```bash
node benchmarks/cogeval-locomo-harness/longmemeval_frontier_runner.mjs \
  --dataset benchmarks/cogeval-locomo-harness/sample_longmemeval.json \
  --arm both \
  --provider openai \
  --model gpt-4o-mini \
  --api-key "$OPENAI_API_KEY" \
  --json-out ./artifacts/lme-smoke.json
```

### Running on the Full 500-QA Official `longmemeval_s_cleaned.json` Dataset

Against the proprietary **Sealed Kernel Container** (`AME_BASE_URL=http://127.0.0.1:8090`):

```bash
AME_BASE_URL=http://127.0.0.1:8090 \
AME_API_KEY=your-gateway-api-key \
node benchmarks/cogeval-locomo-harness/longmemeval_frontier_runner.mjs \
  --dataset /path/to/longmemeval_s_cleaned.json \
  --arm both \
  --provider openai \
  --model gpt-4o-mini \
  --api-key "$OPENAI_API_KEY" \
  --limit 500 \
  --json-out ./artifacts/lme-sealed-500.json
```

Use `--arm ame-gateway` or `--arm bare-frontier` to run a single arm, `--ame-mode a` to test Mode A `/turn` instead of Mode B `prepare/settle`, and `--base-url http://127.0.0.1:11434/v1 --provider openai-compat` for local Ollama/vLLM endpoints.

### Comparator CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--dataset <path>` | Path to LongMemEval-S JSON array (e.g. `sample_longmemeval.json` or 500-QA `longmemeval_s_cleaned.json`) | `./sample_longmemeval.json` |
| `--arm <mode>` | `ame-gateway` \| `bare-frontier` \| `both` | `both` |
| `--provider <name>` | `mock` \| `openai` \| `anthropic` \| `gemini` \| `deepseek` \| `openrouter` \| `openai-compat` | `AME_LLM_PROVIDER` or `mock` |
| `--model <name>` | Upstream LLM model identifier | `AME_LLM_MODEL` or `mock-eval-v1` |
| `--api-key <key>` | Upstream LLM API key | `AME_LLM_API_KEY` |
| `--base-url <url>` | Upstream LLM base URL override | `AME_LLM_BASE_URL` |
| `--ame-base-url <url>` | AME Gateway base URL | `AME_BASE_URL` or `http://127.0.0.1:8090` |
| `--ame-api-key <key>` | Gateway `X-AME-API-Key` header | `AME_API_KEY` or `dev-sandbox-key` |
| `--ame-mode <a\|b>` | Query path: `b` (Mode B `prepare/generate/settle`) or `a` (Mode A `/turn`) | `b` |
| `--ingest-mode <mode>` | Haystack replay: `settle` (zero-cost Mode B historical settle) or `mode-a` | `settle` |
| `--chunk-chars <n>` | Optional max characters per ingested user chunk (`0` = unsplit turn) | `0` |
| `--limit <n>` | Evaluate up to `<n>` items | all items in dataset |
| `--offset <n>` | Start offset into dataset | `0` |
| `--json-out <path>` | Write structured JSON report to `<path>` | disabled |
| `--json-only` | Suppress human summary and emit JSON only | `false` |

---

## 4. VC Technical Due-Diligence Scorecard Generator (`dd_scorecard_generator.mjs`)

`dd_scorecard_generator.mjs` synthesizes the outputs of `run_harness.mjs` and `longmemeval_frontier_runner.mjs` into an institutional Markdown DD report and JSON summary while strictly separating **live contract sandbox verification** (`sandbox-contract-verification`) from **live sealed-kernel production evaluation** (`sealed-kernel-production-eval`).

```bash
# 1. Run 7-gate harness
node benchmarks/cogeval-locomo-harness/run_harness.mjs \
  --json-only --json-out ./artifacts/harness.json

# 2. Run LongMemEval-S paired comparator
node benchmarks/cogeval-locomo-harness/longmemeval_frontier_runner.mjs \
  --dataset benchmarks/cogeval-locomo-harness/sample_longmemeval.json \
  --arm both \
  --json-only --json-out ./artifacts/lme.json

# 3. Generate institutional DD Scorecard (Markdown + JSON)
node benchmarks/cogeval-locomo-harness/dd_scorecard_generator.mjs \
  --harness-json ./artifacts/harness.json \
  --lme-json ./artifacts/lme.json \
  --out-md ./artifacts/dd-scorecard.md \
  --out-json ./artifacts/dd-scorecard.json
```

### Scorecard Generator CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--harness-json <path>` | Path to `run_harness.mjs` JSON output | optional (one input required) |
| `--lme-json <path>` | Path to `longmemeval_frontier_runner.mjs` JSON output | optional (one input required) |
| `--out-md <path>` | Output Markdown report path | disabled (prints to stdout) |
| `--out-json <path>` | Output JSON summary path | disabled |
| `--title <text>` | Custom report title | default DD title |
| `--json-only` | Emit JSON summary to stdout instead of Markdown | `false` |

---

## 5. Automated Test Verification

Run the self-contained automated test suite (boots the local `sandbox-server` on port `0` and an isolated local HTTP frontier LLM stub with zero external API calls):

```bash
node --test benchmarks/cogeval-locomo-harness/test/harness.test.mjs
```

---

## 6. `run_harness.mjs` CLI Flags & Suite Schema (`sample_suite.json`)

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

### Exit Codes (`run_harness.mjs`)

- **Exit code `0`**: `health()` succeeded and all 7 benchmark gates passed (`overallPass === true`).
- **Exit code `1`**: Gateway unreachable, malformed suite/flags, or one or more benchmark gates failed (`overallPass === false`).
