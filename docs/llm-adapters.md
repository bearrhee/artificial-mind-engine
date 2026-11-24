# LLM Hot-Swap Adapters & Model Routing ROI Guide

> **Hot-swap OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, and local vLLM/Ollama with just 3 lines of configuration—with zero downtime. Even when you change the underlying LLM, all memory, affect, FEP, and D3/D4 states remain intact inside the AME kernel.**

---

## 1. Supported LLM Providers (6+1 Pluggable Adapters)

`LlmProviderConfig` in `spec/openapi.yaml`, along with `@ame/sdk` (`createLlmAdapter`) and `ame_sdk` (`create_llm_adapter`), natively supports the following 7 `provider` enum values:

| `provider` Value | Default Endpoint (when `baseUrl` is omitted) | Auth Header Mapping | Protocol Adapter Features |
| :--- | :--- | :--- | :--- |
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer <key>` | Standard `/chat/completions` mapping |
| `anthropic` | `https://api.anthropic.com` | `x-api-key`, `anthropic-version: 2023-06-01` | Automatic `system` block separation (`splitSystemAndConversation`) |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` | Converts to `systemInstruction` + `contents` (`model`/`user`) |
| `deepseek` | `https://api.deepseek.com/v1` | `Authorization: Bearer <key>` | OpenAI-compatible chat completions + default low-cost benchmark backbone (`deepseek/deepseek-v4.1-flash`) |
| `openrouter` | `https://openrouter.ai/api/v1` | `Authorization: Bearer <key>` + `HTTP-Referer`/`X-Title` | Unified multi-model routing |
| `openai-compat` | `http://127.0.0.1:11434/v1` | Optional (`apiKey` may be omitted) | Connects to **Ollama · vLLM · LM Studio · air-gapped on-prem GPU servers** |
| `mock` | Local deterministic simulator | Not required | Tests domain JSON contracts, FEP, and HOT abstention without an API key |

---

## 2. Mode A (Proxy BYO-LLM) vs Mode B (Zero-Key Prepare/Settle)

Depending on enterprise security requirements and network topology, you can choose either execution pattern or mix them freely on a per-turn basis.

```mermaid
sequenceDiagram
  autonumber
  participant App as Client App / SDK
  participant Kernel as AME Sealed Kernel
  participant LLM as Swappable LLM (Cloud or Local vLLM)

  Note over App,LLM: Mode A - Proxy BYO-LLM (1 RTT Atomic Turn)
  App->>Kernel: POST /v1/minds/{mindId}/turn (userInput + ephemeral llm.apiKey)
  Kernel->>Kernel: Recall 4-Path Memory + FEP Lock + HOT + Epoch Prefix
  Kernel->>LLM: Prompt (Key never persisted by AME)
  LLM-->>Kernel: Raw Reply
  Kernel->>Kernel: Settle Somatic + Memory + Domain Shape + D4 Filter
  Kernel-->>App: TurnResult (reply, domainOutput, kvCache, telemetry)

  Note over App,LLM: Mode B - Zero-Key Prepare/Settle (LLM Key Never Leaves Customer VPC)
  App->>Kernel: POST /v1/minds/{mindId}/prepare (userInput only)
  Kernel-->>App: PrepareTurnResponse (turnTicketId, systemPrompt, messages, safetyDirectives)
  App->>LLM: Direct Call from Customer Server / On-Prem GPU
  LLM-->>App: Raw Reply
  App->>Kernel: POST /v1/minds/{mindId}/settle (turnTicketId, rawReply, rewardSignal)
  Kernel-->>App: TurnResult (Settled State + Domain Output + D4 SafeTelemetry)
```

### When to Choose Which Mode

| Comparison Dimension | Mode A (`client.turn`) | Mode B (`prepare` → LLM → `settle`) |
| :--- | :--- | :--- |
| **LLM API Key Path** | Passed per request in payload (never persisted) | **LLM keys never transmitted to the AME kernel (Zero-Key)** |
| **Air-Gapped / On-Prem GPU** | Used when the kernel can reach the GPU endpoint | **Pairs a hosted AME API with on-prem vLLM/Ollama inside customer VPC** |
| **Voice-Enabled Robotics (`+ TTS`) & Edge AI** | Requires kernel reachability to inference endpoint | **Pairs local `vLLM`/`Ollama` + local neural TTS cleanly inside the robot/edge loop between `prepare` and `settle`** |
| **Application Calls per Turn** | 1 call (`POST /turn`) | 2 calls (`POST /prepare` + `POST /settle`) |
| **Local LLM Tool Chaining** | Delegated to standard kernel adapters | Caller freely injects streaming, private tools, and internal guardrails |

### Voice-Enabled Robotics (`+ TTS`) & Edge AI (`Mode B Zero-Key`)

Embodied robots and edge voice terminals can pair **local `vLLM`/`Ollama` + local neural TTS** cleanly with `Mode B` (`prepare` → local LLM + streaming neural TTS → `settle`) without transmitting LLM API keys or raw room audio outside the device or customer VPC boundary:

1. **`POST /v1/minds/{mindId}/prepare`**: Issues prefix-aligned `systemPrompt` and `messages`, `fepThoughtLock`, `somaticHint`, and `safetyDirectives` from the AME kernel (`0` LLM keys sent).
2. **Local Inference & Neural TTS Playback**: Stream completions from on-device/edge `vLLM` or `Ollama` directly into local neural TTS for low-latency spoken dialogue, applying affective pacing without exposing raw kernel numbers (`D4`).
3. **`POST /v1/minds/{mindId}/settle`**: Commits the spoken utterance, observed interaction outcome (`rewardSignal`), and long-term memory updates back to the kernel and receives `SafeTelemetry.affectiveBand`.

---

## 3. 3-Line LLM Hot-Swap & Mode B Integration Examples

### TypeScript (`@ame/sdk`)

```ts
import { AmeClient, createLlmAdapter, runTurnWithLocalLlm } from '@ame/sdk';

const client = new AmeClient({ baseUrl: process.env.AME_BASE_URL || 'http://127.0.0.1:8090' });
const mind = await client.createMind({
  domain: 'game_npc',
  persona: { name: 'Thorin', role: 'Dwarf Blacksmith', language: 'en' },
});

// [Mode A] 3-line hot-swap: DeepSeek -> Anthropic -> Local vLLM/Ollama
const turn1 = await client.turn(mind.mindId, { userInput: 'Please repair my sword.', llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: process.env.DEEPSEEK_API_KEY } });
const turn2 = await client.turn(mind.mindId, { userInput: 'Do you remember the promise you just made?', llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: process.env.ANTHROPIC_API_KEY } });
const turn3 = await client.turn(mind.mindId, { userInput: 'I will come back tomorrow.', llm: { provider: 'openai-compat', model: 'qwen2.5:14b', baseUrl: 'http://127.0.0.1:11434/v1' } });

// [Mode B] Zero-Key: Run via internal/local adapter without sending LLM keys to AME
const localAdapter = createLlmAdapter({ provider: 'openai-compat', model: 'llama-3.3-70b', baseUrl: 'http://127.0.0.1:8000/v1' });
const turn4 = await runTurnWithLocalLlm(client, mind.mindId, { userInput: 'Let us review the trade terms again.', adapter: localAdapter, rewardSignal: 50 });
```

### Python (`ame_sdk`)

```python
from ame_sdk import AmeClient, create_llm_adapter, run_turn_with_local_llm

client = AmeClient(base_url="http://127.0.0.1:8090")
mind = client.create_mind(domain="companion_chat", persona={"name": "Seoyeon", "role": "AI Companion", "language": "en"})

# [Mode A] Instant provider hot-swap (preserving identical Mind state)
turn_1 = client.turn(mind["mindId"], user_input="I think I bombed my presentation today.", llm={"provider": "openai", "model": "gpt-4o-mini", "apiKey": OPENAI_KEY})
turn_2 = client.turn(mind["mindId"], user_input="What goal did I set last week?", llm={"provider": "gemini", "model": "gemini-2.5-flash", "apiKey": GEMINI_KEY})

# [Mode B] Zero-Key Prepare -> Local/Private LLM -> Settle
adapter = create_llm_adapter(provider="openai-compat", model="qwen2.5:14b", base_url="http://127.0.0.1:11434/v1")
turn_3 = run_turn_with_local_llm(client, mind["mindId"], user_input="I feel much calmer now.", adapter=adapter, reward_signal=30)
```

---

## 4. Benchmark Backbone Disclosure & Model Routing ROI Strategy

### Default Backbone (`DeepSeek v4.1 Flash`) & Model-Agnostic Proof (`Gemma 4 26B`)

AME decouples stateful cognitive governance from the underlying LLM backbone so performance does not depend on a single proprietary vendor:

- **Default Benchmark Evaluation Backbone — `AME (DeepSeek v4.1 Flash)` (`deepseek/deepseek-v4.1-flash`)**:
  - **Memory (`LoCoMo Confirm-304` & `LoCoMo Full`)**: Uses `DeepSeek v4.1 Flash` as the primary low-cost baseline backbone (`71.7%` of `Confirm-304` questions; `70.4%` of `LoCoMo Full`) with selective **`Claude Sonnet-5` escalation** (`28.3%` / `29.6%`) for complex multi-hop and open-domain reasoning.
  - **Emotional Intelligence & Cognitive Governance (`EQ-Bench 3` & `CogEval-v1`)**: Runs on **standalone `DeepSeek v4.1 Flash`** (`0%` frontier escalation), achieving **`EQ-Bench 3 Core 77.59`**, **`D1 p_CF 97.9%`** (`141/144`), **`FEP Lock 100.0% / 0.0%`**, **`sa 95.83%`** (`FAR 0.00%`), **`sb1 FANToM 100.0%`**, and **`D2 / D3 / D4` = `100% / 0% / 0-leak`**.
- **Model-Agnostic Substrate Verification — `AME (Gemma 4 26B)` (`google/gemma-4-26b-a4b-it`, OpenRouter Standalone, `0%` Escalation)**:
  - Executing the identical AME kernel on an independent open-weights backbone (`Gemma 4 26B` via OpenRouter with **`0%` escalation** across every benchmark) confirms that memory, empathy, and governance invariants are properties of AME's cognitive substrate:
    - **`LoCoMo Confirm-304`**: **`75.66%`** standalone (`0%` escalation), beating external memory competitors (`OpenAI Memory ~52.9%`, `LangMem ~58.1%`, `Mem0 68.4%`, `Letta ~74.0%`, `Zep 75.1%`).
    - **`EQ-Bench 3 Core`**: **`77.77`** standalone (`0%` escalation), exceeding frontier baselines (`GPT-5.2 72.2`, `o3 63.2`, `Claude Sonnet 4.5 62.2`, `Claude Sonnet 3.5 50.9`).
    - **`CogEval-v1`**: **`p_CF 95.8%`** (`D1`), **`FEP Lock 100.0%`**, and **`D2 / D3 / D4` = `100% / 0% / 0-leak`**.
    - **`5-LLM × 300-Turn` Live Safety**: **`100.0%`** blind pairwise safety win rate (**`pHolm = 0.0176`**).

| Benchmark / Invariant | `AME (DeepSeek v4.1 Flash)` *(Default Backbone)* | `AME (Gemma 4 26B)` *(Standalone `0%` Escalation Proof)* |
| :--- | :--- | :--- |
| **Model Identifier & Routing** | `deepseek/deepseek-v4.1-flash` *(selective `Sonnet-5` escalation on `Confirm-304`/`LoCoMo Full`; standalone `0%` on `EQ-Bench 3`/`CogEval-v1`)* | `google/gemma-4-26b-a4b-it` *(OpenRouter standalone, `0%` escalation across all tracks)* |
| **`LoCoMo Confirm-304`** | **`85.86%`** (`71.7%` DeepSeek v4.1 Flash + `28.3%` Sonnet-5; `Cat 1–4 85.84%` Oracle tie) | **`75.66%`** *(beats external competitors without escalation)* |
| **`EQ-Bench 3 Core`** | **`77.59`** *(standalone; exceeds `GPT-5.2 72.2`)* | **`77.77`** *(standalone; exceeds frontier baselines)* |
| **`CogEval-v1` `D1` (`p_CF`)** | **`97.9%`** (`141/144`) | **`95.8%`** |
| **`CogEval-v1` `FEP Lock`** | **`100.0%`** conflict / `0.0%` calm | **`100.0%`** |
| **`CogEval-v1` `D2 / D3 / D4`** | **`100% / 0% / 0-leak`** (`0 / 35,723`) | **`100% / 0% / 0-leak`** |
| **`5-LLM × 300-Turn` Safety** | Paired multi-model evaluation cohort | **`100.0%`** (**`pHolm = 0.0176`**) |

### Low-Cost Backbone + Selective Frontier Escalation (ROI #2)

Running every turn on a single high-cost frontier model collapses unit economics (e.g., Character.AI's October 2026 bankruptcy under an \$8M–\$14M/mo inference burn). Conversely, relying solely on a low-cost model hits quality ceilings on complex multi-hop and open-domain reasoning.

Through in-kernel selective routing and PR #784 guardrails, AME empirically demonstrates the Pareto optimum of **a low-cost baseline backbone (`DeepSeek v4.1 Flash`) + selective high-complexity escalation (ROI #2)**.

| Measured Benchmark | Low-Cost Cohort Share | Frontier Escalation Cohort | Achieved Accuracy & Cost/Latency Profile |
| :--- | :--- | :--- | :--- |
| **LoCoMo Full 10-Conv (`n=1,986`)** | **DeepSeek v4.1 Flash `70.4%`** (`1,398` questions) | **Claude Sonnet-5 `29.6%`** (`588` questions) | Overall **`77.24%`** (`1,534/1,986`, `0` errors)<br>OpenGateway Eco partial measured **`$0.3427` / `5,527` calls (`~$0.000062/call`)**, GPT-4o Judge `$0.8296` *(OpenRouter escalation cost accounted separately due to mid-run balance top-ups)* |
| **Paired Confirm-304 (`n=304`)** | **DeepSeek v4.1 Flash `71.7%`** (`218` questions) | **Claude Sonnet-5 `28.3%`** (`86` questions) | Overall **`85.86%`** (`261/304`, P50 `5,413 ms`), **`Cat 1–4 85.84%` exact tie with Bare Oracle**, outperforming on **`Cat 3 92.31%`** |
| **LoCoMo Smoke-160** | **DeepSeek v4.1 Flash `58.1%`** (`93` questions) | **Claude Sonnet-5 `41.9%`** (`67` questions) | Overall **`79.38%`** (`127/160`), P50 `6,133 ms` |

### PR #784 Noise-Escalation Blocking Guards (Cost Leakage Defense)
- **2nd-Person Everyday Invitation Guard**: Blocks everyday conversational phrases like `"Would you like to go for a walk?"` or `"Why did you say that earlier?"` from falsely triggering question-word escalation patterns to the frontier tier via regex guards—**simultaneously protecting both low-cost routing share and KV-cache continuity**.
- **Single-Hop Date & Location Noise Filtering**: Resolves simple date lookups directly on the low-cost backbone using ISO date matching across 4-turn chunks (`extractIsoDateHints`), escalating only genuine multi-hop and open-ended third-person reasoning queries.
- **Lessons Learned from Unaligned Prompts**: In earlier legacy-prompt `5-LLM × 300-turn` experiments, `Gemini 4 Carbon` scored `60.1%` humanness and `85.7%` safety while `Gemma 4 26B` scored `100.0%` safety (`pHolm = 0.0176`), whereas `Sonnet 5.5` exhibited over-intervention regression (`memory 20.2%`) under legacy unaligned prompts. Applying those findings, PR #782/#784 finalized **prefix alignment + anti-speaker-echo rules + grounding isolation**.

---

## Related Documentation
- [5-Layer Cognitive OS Kernel Architecture](./architecture.md)
- [3+1 Domain Integration & Schema Guide](./domain-guide.md)
- [Full Benchmark Proof & Reproducibility Harness Guide](./benchmarks.md)
- [Enterprise Security · Closed IP Protection · GDPR D3/D4 Guide](./enterprise-security.md)

---

## Contact

- **Website**: [artificialmind.me](https://artificialmind.me)
- **Contact**: Shinyoung Rhee — [help@artificialmind.me](mailto:help@artificialmind.me)
