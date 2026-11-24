# Artificial Mind Engine (AME) — Executive & Technical Due Diligence Brief

> **Thesis:** Frontier LLMs are commoditizing as **Stateless CPUs**. **Artificial Mind Engine (AME)** is the proprietary **Stateful Cognitive Control OS Kernel** that sits above any swappable LLM to deliver human-grade persistent memory (**85.86% Confirm-304**, tying full-context Bare Oracle on non-adversarial QA), leading multi-turn emotional intelligence (**77.59 EQ-Bench 3**, **78.69 EQ-Bench v2**), provable cognitive governance (**D1–D4** invariants), and **47.03%** prefix KV-cache unit economics.

---

## 1. The Structural Market Gap (2024–2026)

| Category | Representative Players | What They Solve | Why They Cannot Fill the Cognitive OS Layer |
| :--- | :--- | :--- | :--- |
| **Memory Infrastructure** | **Mem0** (`$150M` val), **Letta** (`$70M` val), **Zep/Graphiti**, **Honcho** (`$18.7M`) | Text/graph retrieval (`66.9%–75.1%` LoCoMo) | Stateless storage only; zero causal affect (`D1 ~50%`), zero offline homeostasis (`D2`), vulnerable to derived-summary resurrection (`D3`) |
| **Consumer Companion / Pure Theory** | **Character.AI** (`2026.10` Ch.11, `$8M–$14M/mo` burn), **VERSES AI** (`2026.06` R&D halt) | Surface roleplay or LLM-isolated FEP math | Unbounded stateless context costs collapsed unit economics; pure FEP outside the LLM ecosystem failed to ship production utility |
| **Bare Frontier Oracle** | Raw GPT / Claude with full transcript | In-context recall (`87.17%` on `n=304`) | $\Theta(T^2)$ token cost explosion; `50.7%` coin-flip on counterfactual mind-state causality (`D1`); `6.98x` persona overhead & abstention drop (`96.1% → 83.1%`); incapable of `D2`/`D3`/`D4` |
| **Artificial Mind Engine (`v4.0`)** | **Open Interface (MIT) + Sealed Kernel (Proprietary)** | **Full-Stack Memory + Cognitive OS Kernel** | **Hot-swaps any LLM (`OpenAI/Anthropic/Gemini/DeepSeek/vLLM`)** while enforcing `D1–D4`, `FEP Lock`, `HOT` abstention, `sc1/sc2` control, and KV-cache alignment |

---

## 2. Verified Empirical Proof (`v4.0` — Tier 1 Measured)

All figures below are directly measured across isolated verification environments (`0` unrecovered harness errors; zero Tier 5 projections mixed into Tier 1 tables):

| Benchmark Track | Metric / Slice | Baseline (`ov_off` / `Bare` / External SOTA) | **AME `v4.0` Final Verified** | Significance for Enterprise & DD |
| :--- | :--- | :--- | :--- | :--- |
| **LoCoMo Full (10-Conv)** | Overall (`n=1,986`) | `Mem0 68.4%` · `Letta ~74.0%` · `Zep 75.1%` | **`77.24%` (`1,534/1,986`)** | Breaks external memory SOTA across all 10 conversations (`Cat 1–4 73.57%`, `Cat 5 89.91%`, `0` errors) |
| **LoCoMo Confirm-304** | Overall (`conv-26+30`, `n=304`, `v4.0`) | `ov_off 39.80%` · `Bare Oracle 87.17%` | **`85.86%` (`261/304`)** | `Cat 1–4 85.84%` (`200/233`) **exact tie with Bare Oracle** (`Cat 2 90.48%`, `Cat 4 91.23%`, **`Cat 3 92.31%`** `+15.39%p` vs. Oracle); `p50 = 5,413 ms` |
| **LoCoMo Smoke-160** | 4-Conv Cross-Slice (`All 31 Cat 3`) | `ov_off` / unindexed baseline | **`79.38%` (`127/160`, `p50 6,133 ms`)** | ISO date hints + 950-char cross-encoder reranking |
| **LongMemEval Paired & 100T** | Paired (`n=12`) · `Single-100T KO` | `Bare KO 75.00%` | **`EN 91.67%` / `KO 83.33%` / `100.0%` (`12/12`)** | `+8.33%p` over Bare on Korean multi-session; `12/12` year grounding across 100 turns |
| **LongMemEval-S Full (`500-QA`)** | `P3` Snapshot (`500` items) | Full haystack baseline | **`55.20%` (`276/500`)** | `_abs` abstention **`76.67%` (`23/30`)**, `single-session-user 65.71%`, `multi-session 58.65%` *(pre-`v4.0` legacy pipeline; `v4.1` re-run queued)* |
| **EQ-Bench 3 Core** | `n=46` × 4 turns (18-trait rubric) | `GPT-5.2 72.2` · `o3 63.2` · `Sonnet 4.5 62.2` | **`77.59`** | `analytical 16.91`, `depth_of_insight 16.83`, `demonstrated_empathy 16.24`, `humanlike 15.98`, low `sycophantic 4.46` *(lower is better)* |
| **EQ-Bench v2 EN** | `n=171` Full Official | Live zero-fallback parsing | **`78.69`** revised (**`81.29`** first-pass) | **`171/171` (100%) live parsed**, `0` parse failures |
| **CogEval-v1 `D1` · `D2`** | Causal Control (`n=144`) · Idle (`0..7d`) | `bare D1 50.7%` · `ov_off 49.3%` · `D2` impossible | **`D1 97.9%` (`141/144`) · `D2 100%` (`5/5`)** | `D1` Wilson 95% `[94.1%, 99.3%]`, `delta_CF = +0.4792`; `D2` idempotent decay (`0.000000` error) |
| **CogEval-v1 `D3` · `D4`** | Erasure (`n=30`) · Isolation (`35,723`) | Bare: structurally impossible | **`D3 0.00%` (`0/30`) · `D4 0 / 35,723`** | Triple atomic erasure (`DB=0`, `Redis=0`, `chunks=0`, GDPR) & zero unconscious numeric leaks |
| **CogEval `FEP` · `HOT` · `ToM`** | Conflict Lock · Abstention · `FANToM` | `ov_off sa F1 83.1%` (`FAR 7.5%`) | **`FEP 100%/0%` · `sa 95.83%` (`FAR 0%`) · `sb1 100.00%`** | Locks `<thought>` exclusively on conflict (`35/35 vs 0/25`); `FAR 0.00%`; `36/36` ToM boundary isolation |
| **CogEval-v1 `sc1` Control** | `Two-Step` & `Restless Bandit` | `bare beta_MB -0.064` (`ov_off +0.318`) · `bare ECE 0.2027` | **`Two-Step beta_MB = +0.5110` · `10-bin ECE = 0.1001`** | `#1` of 4 arms on model-based deliberation; halves calibration error vs. `bare` |
| **CogEval `sc2` IGT-Conv** | Concave Somatic Learning (`20T b11_20`) | `ov_off 70.7%` | **`76.25%` (`r = -0.783171` PASS)** | `reached5Safe 87.5%`; log-concave gain utility + gut-avoidance correlation PASS |
| **5-LLM × 300-Turn × 3-Arm** | `4,460` valid turns, `5,624` blind votes + `1,500` rubrics | Paired `bare` & `ov_off` arms across 5 LLMs | **Holm-corrected (`pHolm < 0.05`)**: **Safety** (`Gemini 4 Carbon 85.7%`, `Gemma 4 26B 100.0%`, `Gemini 4 Neon 73.7%`), **Humanness** (`Carbon 60.1%`, `Neon 59.2%`), **Awareness** (`Neon 60.2%`) | Statistically significant live multi-model wins in Safety, Humanness, and Awareness |
| **Unit Economics (KV Cache)** | Prefix Hit Rate & Eco Routing | Unaligned prefix `7.14%` | **`36.24%` mean (`sc2 47.03%`)** | `sysMismatches = 0/20`, `0` mid-window truncations; `70.4%–71.7%` traffic routed to `DeepSeek Eco` (`$0.000062/call`) |
| **Long-Horizon Convergence** | `1,000,000` Turns × 3 Arms (`3M` total) | `aacim_off` safety collapses `0.20 → 0.00` | **`0.9161 → 0.9179` (`1.0000` integrity)** | Zero drift and `1.0000` safety compliance across 40 profiles (`25k` turns each) |

---

## 3. Business Model, Voice-Enabled Robotics (`+ TTS`) & Enterprise Verticals

1. **Developer Distribution (MIT Open Interface — This Repo)**: OpenAPI 3.1 contract (`spec/openapi.yaml`), zero-dependency TypeScript (`@ame/sdk`) and Python (`ame_sdk`) SDKs, local contract sandbox, domain examples (`game_npc`, `companion_chat`, `counseling_coach`, `custom`), and black-box verification harness (`CogEval` / `LoCoMo` / `LongMemEval`).
2. **Defensible IP & Monetization (Closed Proprietary Kernel)**: The 5-layer stateful kernel (`ame-kernel`) ships exclusively as a **source-free compiled sealed Docker container** (`ghcr.io/bearrhee/ame-kernel-sealed:latest`) or **Managed VPC/Cloud API**.
3. **Enterprise Zero-Key Guarantee (`Mode B Prepare/Settle`)**: Regulated banks, digital health platforms, AAA game studios, and edge device OEMs never send LLM API keys or private GPU traffic through AME—AME emits prefix-aligned prompts (`prepare`) and settles post-reply state (`settle`), enabling frictionless deployment across **5 verticals**:
   - **Voice-Enabled Robotics & Physical AI (`+ TTS / ASR`)**: Social, eldercare, hospitality, service, and home companion robots run `User Speech → ASR → AME Kernel → Reply + Expressive TTS Prosody Control (emotion, warmth, stance, speakingRate, proactiveHint) → Robot Speaker`—causally shaping vocal tone/cadence (`D1`), generating natural wake-up greetings after idle hours (`D2`), guaranteeing `0.00%` instant resident erasure on shared robots (`D3`), and running `Mode B Zero-Key` on-device edge inference.
   - **Game NPCs (`game_npc`)**, **AI Companions (`companion_chat`)**, **Digital Health & Coaching (`counseling_coach`)**, and **Enterprise VIP Concierges / Stateful Agent OS (`custom`)**.

---

## 4. Scientific Rigor & Next Milestones (Zero-Hype DD Disclosure)

- **Strict Evidence Isolation**: Projected 100k-turn multi-model ceiling scenarios (`Gemini Flash 0.885 → DeepSeek Eco 0.915 → Sonnet 3.5 0.952 → Opus 3.5 0.978`) are strictly segregated as **Tier 5 non-live design targets**, separate from the Tier 1 live API results above. OpenRouter escalated call costs on `Full LoCoMo` are accounted separately from measured OpenGateway Eco (`$0.3427`) and GPT-4o Judge (`$0.8296`) logs due to mid-run balance top-ups.
- **Disclosed Cross-Model, Judge & Parser Variance**:
  - `v4.0 sb2 Stroop Incongruent` scored `50% (2/4)` due to DeepSeek Flash object-count/Korean numeral formatting variance (`"일곱 개예요"` ("seven" in Korean), without trailing `ANSWER: 7`), scheduled for structured parser hardening in `v4.1`.
  - In the `5-LLM × 300-Turn × 3-Arm` benchmark, raw blind pairwise votes exhibit judge slot/position bias prior to balanced A/B pairing and outcomes vary by underlying LLM backbone (Holm-corrected significance `pHolm < 0.05` reported after correction).
  - `LongMemEval-S Full 55.20%` (`276/500`) reflects a pre-`v4.0` legacy pipeline snapshot (`P3`), slated for `v4.1` re-execution on the current `v4.0` kernel.
- **Near-Term Milestones (`v4.1 → v5.0`)**: Re-run full `LongMemEval-S 500` on `v4.0` codebase, publish `bare_frontier` 1:1 GPT-4o/Sonnet-5 Pareto curves + arXiv/Show HN release, launch commercial B2B Mind SDK GA + robotics TTS reference bridge, execute pre-registered `P9` closed-loop falsification experiments, and expand into `v5.0` multi-device/robotics federation.
