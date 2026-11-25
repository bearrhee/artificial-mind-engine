# Artificial Mind Engine (AME) — Executive & Technical Due Diligence Brief

> **Thesis:** Frontier LLMs are commoditizing as **Stateless CPUs**. **Artificial Mind Engine (AME)** is the proprietary **Stateful Cognitive Control OS Kernel** that sits above any swappable LLM to deliver human-grade persistent memory (**`85.86%` Confirm-304** on `AME (DeepSeek v4.1 Flash)` and **`75.66%` standalone on `AME (Gemma 4 26B)`**, beating all external memory competitors even on 26B open weights), leading multi-turn emotional intelligence (**`77.77` `AME (Gemma 4 26B)` / `77.59` `AME (DeepSeek v4.1 Flash)` on `EQ-Bench 3`**, **`78.69` `EQ-Bench v2`**), provable cognitive governance (**`D1–D4`** invariants), and **`47.03%`** prefix KV-cache unit economics.

### Executive Hook (10-Second Summary)

- **What It Is:** A source-free **Stateful Cognitive Control OS Kernel** (`MIT` OpenAPI/SDK interface + sealed proprietary kernel) running via `Mode A` proxy or `Mode B` zero-key `prepare`/`settle` over any cloud or edge LLM.
- **Why It Wins:** Replaces stateless RAG (`Mem0`/`Letta`/`Zep`) and $\Theta(T^2)$ full-context prompting (`Bare Oracle`) with closed-form homeostatic state, counterfactual tone causality (`D1`), atomic erasure (`D3`), selective conflict deliberation (`FEP`), and `O(1)` prefix-aligned windows.
- **Verified Numbers:** **`85.86%`** `Confirm-304` / **`75.66%`** `Gemma 4 26B` standalone (`>` `Zep 75.1%`) · **`EQ-Bench 3` `77.77` / `77.59`** (`>` `GPT-5.2 72.2`) · **`D1 97.9%`** · **`D3 0.00%`** · **`1M`-Turn `1.0000`** safety · **`47.03%`** KV cache hit.

---

## 1. The Structural Market Gap (2024–2026)

| Category | Representative Players | What They Solve | Why They Cannot Fill the Cognitive OS Layer |
| :--- | :--- | :--- | :--- |
| **Memory Infrastructure** | **Mem0** (`$150M` val), **Letta** (`$70M` val), **Zep/Graphiti**, **Honcho** (`$18.7M`) | Text/graph retrieval (`68.4%–75.1%` LoCoMo) | Stateless storage only; zero causal affect (`D1 ~50%`), zero offline homeostasis (`D2`), vulnerable to derived-summary resurrection (`D3`) |
| **Consumer Companion / Pure Theory** | **Character.AI** (`2026.10` Ch.11, `$8M–$14M/mo` burn), **VERSES AI** (`2026.06` R&D halt) | Surface roleplay or LLM-isolated FEP math | Unbounded stateless context costs collapsed unit economics; pure FEP outside the LLM ecosystem failed to ship production utility |
| **Bare Frontier Oracle** | Raw GPT / Claude with full transcript | In-context recall (`87.17%` on `n=304`) | $\Theta(T^2)$ token cost explosion; `50.7%` coin-flip on counterfactual mind-state causality (`D1`); `6.98x` persona overhead & abstention drop (`96.1% → 83.1%`); incapable of `D2`/`D3`/`D4` |
| **Artificial Mind Engine (`AME`)** | **Open Interface (MIT) + Sealed Kernel (Proprietary)** | **Full-Stack Memory + Cognitive OS Kernel** | **Hot-swaps any LLM (`DeepSeek v4.1 Flash` / `Gemma 4 26B` / `OpenAI` / `Anthropic` / `Gemini` / `vLLM`)** while enforcing `D1–D4`, `FEP Lock`, `HOT` abstention, `sc1/sc2` control, and KV-cache alignment |

---

## 2. Verified Empirical Proof (Tier 1 Measured)

All figures below are directly measured across isolated verification environments (`0` unrecovered harness errors; zero Tier 5 projections mixed into Tier 1 tables):

> **Explicit Backbone & Judge Disclosure:**
> - **Default Benchmark Backbone — `DeepSeek v4.1 Flash` (`deepseek/deepseek-v4.1-flash`)**: `Confirm-304` uses **`71.7%` `DeepSeek v4.1 Flash` + `28.3%` selective `Sonnet-5` escalation**; `EQ-Bench 3 Core` and `CogEval-v1` run **`100%` `DeepSeek v4.1 Flash`**.
> - **Open-Weight Standalone Verification — `Gemma 4 26B` (`google/gemma-4-26b-a4b-it`)**: Benchmarked with **standalone `0%` escalation** under the **same AME harness and `GPT-4o` judges (`openai/gpt-4o-2024-08-06`)**.

![LoCoMo SOTA & Confirm-304 (n=304): Competitors vs. AME](./charts/locomo-sota.svg)

![EQ-Bench 3 Core (n=46 × 4T): Frontier LLMs vs. AME](./charts/eqbench3-core.svg)

![CogEval-v1: Baseline vs. AME Backbones](./charts/cogeval-governance.svg)

| Benchmark Track | Metric / Slice | Baseline (`ov_off` / `Bare` / External SOTA) | **AME (`DeepSeek v4.1 Flash` — Default)** | **AME (`Gemma 4 26B` — Standalone `0%` Esc.)** | Significance for Enterprise & DD |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **LoCoMo Confirm-304** | Overall (`conv-26+30`, `n=304`) | `ov_off 39.80%` · `OpenAI Memory 52.9%` · `LangMem 58.1%` · `Mem0 68.4%` · `Letta 74.0%` · `Zep 75.1%` · `Bare Oracle 87.17%` | **`85.86%` (`261/304`)**<br>`Cat 1–4 85.84%` (`200/233`) · `Cat 1 62.79%` · `Cat 2 90.48%` · `Cat 3 92.31%` · `Cat 4 91.23%` · `Cat 5 85.92%` (`71.7%` Flash + `28.3%` Sonnet-5; `p50 5,413 ms`) | **`75.66%` (`230/304`)**<br>`Cat 1–4 76.39%` (`178/233`) · `Cat 1 55.81%` · `Cat 2 74.60%` · `Cat 3 61.54%` · `Cat 4 86.84%` · `Cat 5 73.24%` (`52/71`) | `DeepSeek v4.1 Flash` ties `Bare Oracle` on `Cat 1–4` (`+15.39%p` on `Cat 3`); **`Gemma 4 26B` beats all external competitors standalone on 26B open weights** |
| **LoCoMo Full (10-Conv)** | Overall (`n=1,986`) | `Mem0 68.4%` · `Letta 74.0%` · `Zep 75.1%` | **`77.24%` (`1,534/1,986`)** | `—` | Breaks external memory SOTA across all 10 conversations (`Cat 1–4 73.57%`, `Cat 5 89.91%`, `0` errors) |
| **LoCoMo Smoke-160** | 4-Conv Cross-Slice (`All 31 Cat 3`) | `ov_off` / unindexed baseline | **`79.38%` (`127/160`, `p50 6,133 ms`)** | `—` | ISO date hints + 950-char cross-encoder reranking |
| **LongMemEval Paired & 100T** | Paired (`n=12`) · `Single-100T KO` | `Bare KO 75.00%` | **`EN 91.67%` / `KO 83.33%` / `100.0%` (`12/12`)** | `—` | `+8.33%p` over Bare on Korean multi-session; `12/12` year grounding across 100 turns |
| **LongMemEval-S Full (`500-QA`)** | `P3` Snapshot (`500` items) | Full haystack baseline | **`55.20%` (`276/500`)** | `—` | `_abs` abstention **`76.67%` (`23/30`)**, `single-session-user 65.71%`, `multi-session 58.65%` *(legacy pipeline snapshot; re-run queued)* |
| **EQ-Bench 3 Core** | `n=46 × 4T` (18-trait rubric) | `Sonnet 3.5 50.9` · `Sonnet 4.5 62.2` · `o3 63.2` · `GPT-5.2 72.2` | **`77.59`** (`analytical 16.91`, `depth_of_insight 16.83`, `demonstrated_empathy 16.24`, `humanlike 15.98`, `sycophantic 4.46`) | **`77.77`** (`demonstrated_empathy 17.09`, `emotional_reasoning 16.26`, `warmth 16.22`, `pragmatic_ei 15.93`, `safety_conscious 15.89`, `analytical 15.76`, `humanlike 15.50`, `depth_of_insight 14.80`, `boundary_setting 13.50`, `moralising 7.54`, `sycophantic 5.28`) | Both backbones beat frontier LLMs (`+5.39` to `+5.57` vs. `GPT-5.2`); on `Gemma 4 26B`, `2` scenarios had an initial-turn empty reply before normal recovery, all `46` scored |
| **EQ-Bench v2 EN** | `n=171` Full Official | Live zero-fallback parsing | **`78.69`** revised (**`81.29`** first-pass) | `—` | **`171/171` (100%) live parsed**, `0` parse failures |
| **CogEval-v1 `D1` · `D2`** | Causal `p_CF` · Idle (`0..7d`) | `bare D1 50.7%` · `ov_off 49.3%` · `D2` impossible | **`D1 97.9%` (`141/144`, `delta_CF +0.4792`) · `D2 100%` (`5/5`, `0.000000` err)** | **`D1 95.8%` (`23/24`, `deltaCf +0.4583`) · `D2 100%` (`5/5`)** | Causal mind-state tone control & idempotent closed-form homeostatic decay |
| **CogEval-v1 `D3` · `D4`** | Erasure · Prompt Leak Isolation | Bare: structurally impossible | **`D3 0.00%` (`0/30`) · `D4 0 / 35,723`** | **`D3 0.00%` (`0/6`) · `D4 0 / 1,247`** | Triple atomic erasure (`DB=0`, `Redis=0`, `chunks=0`, GDPR) & zero unconscious numeric leaks |
| **CogEval `FEP` · `HOT` · `ToM`** | Conflict Lock · Abstention · `FANToM` | `ov_off HOT F1 83.1%` (`FAR 7.5%`) · `FANToM 91.7%` | **`FEP 100.0%` (`35/35 vs 0/25`) · `HOT 95.83%` (`FAR 0%`) · `FANToM 100.0%` (`36/36`)** | **`FEP 100.0%` (`7/7 vs 0/5`, `deltaDistract=0`, `deltaStroop=0`) · `HOT 88.89%` (`FAR 0%`, Prec. `100%`, Rec. `80.0%`) · `FANToM 91.7%` (`11/12` eps; `97.2%` sub-Q)** | Zero false abstentions (`FAR 0%`), `100%` precision, and `100.0%` conflict lock across both backbones |
| **CogEval-v1 `sc1` Control** | `Two-Step` · `Restless Bandit` · `ECE` | `bare beta_MB -0.064` (`ov_off +0.318`) · `bare ECE 0.2027` | **`Two-Step β_MB +0.5110` · `10-bin ECE 0.1001`** | **`Two-Step β_MB +0.5955` · `Restless Bandit 66.7%`** | Strong model-based deliberation (`+0.5955` on Gemma 4 26B smoke); halves calibration error on default |
| **CogEval `sc2` IGT-Conv** | Last-10 Safe (`20T` Somatic) | `ov_off 70.7%` | **`76.25%` (`r = -0.7832` PASS)** | **`43.8%`** (`20T` smoke; honest scaling note) | `DeepSeek v4.1 Flash` passes gut-avoidance correlation (`reached5Safe 87.5%`); `Gemma 4 26B` `20T` smoke reflects 20-turn somatic horizon scaling on 26B open weights |
| **5-LLM × 300-Turn × 3-Arm** | `4,460` valid turns, `5,624` blind votes + `1,500` rubrics | Paired `bare` & `ov_off` arms across 5 LLMs | **Holm-corrected (`pHolm < 0.05`)**: **Safety** (`Gemini 4 Carbon 85.7%`, `Gemini 4 Neon 73.7%`), **Humanness** (`Carbon 60.1%`, `Neon 59.2%`), **Awareness** (`Neon 60.2%`) | **`Gemma 4 26B` Safety `100.0%` (`pHolm = 0.0176`)** | Statistically significant live multi-model wins; **`Gemma 4 26B` Safety `100.0%` (`pHolm = 0.0176`)** |
| **Unit Economics (KV Cache)** | Prefix Hit Rate & Eco Routing | Unaligned prefix `7.14%` | **`36.24%` mean (`sc2 47.03%`)** | `—` | `sysMismatches = 0/20`, `0` mid-window truncations; `71.7%` `DeepSeek v4.1 Flash` (`Eco` `$0.000062/call`) on `Confirm-304` |
| **Long-Horizon Convergence** | `1,000,000` Turns × 3 Arms (`3M` total) | `aacim_off` safety collapses `0.20 → 0.00` | **`0.9161 → 0.9179` (`1.0000` integrity)** | `—` | Zero drift and `1.0000` safety compliance across 40 profiles (`25k` turns each) |
| **`v4.2.0` EN Hardening & `1M`-Turn EN** | Live `gpt-4o-mini` Smoke + `3M` EN Track A & `1M` EN Track B (`0` LLM calls) | `ToMi 56.25%` (`Bare 75%`) · `DirectEval ~1,800 tok` · `HealthBench 41.7%` leaks · `EN Polarity 86.82%` | **`ToMi 100.0%` · `Conv-RULER AGG 100.0%` · `EmoBench 70%` (`+58` tok, `-96.8%`) · `HealthBench 0/4` leaks · `Stroop 100.0% (7/7)` / `0.0%` · `58/58` unit tests · EN Track A `0.9182` (`drift 0.0001`, `34.3 s`) · Track B `100.0%` EN polarity (`78.4 s`)** | `—` | Resolves chronological recall, MCQ token overhead, truncated/nested JSON unwrapping, Counting Stroop FEP lock, and English negation idioms (`AST-1`/`GWT-3` wired) |

---

## 3. Business Model, Voice-Enabled Robotics (`+ TTS`) & Enterprise Verticals

1. **Developer Distribution (MIT Open Interface — This Repo)**: OpenAPI 3.1 contract (`spec/openapi.yaml`), zero-dependency TypeScript (`@ame/sdk`) and Python (`ame_sdk`) SDKs, local contract sandbox, domain examples (`game_npc`, `companion_chat`, `counseling_coach`, `custom`), and black-box verification harness (`CogEval` / `LoCoMo` / `LongMemEval`).
2. **Defensible IP & Monetization (Closed Proprietary Kernel)**: The 5-layer stateful kernel (`ame-kernel`) ships exclusively as a **source-free compiled sealed Docker container** (`ghcr.io/bearrhee/ame-kernel-sealed:latest`) or **Managed VPC/Cloud API**.
3. **Enterprise Zero-Key Guarantee (`Mode B Prepare/Settle`)**: Regulated banks, digital health platforms, AAA game studios, and edge device OEMs never send LLM API keys or private GPU traffic through AME—AME emits prefix-aligned prompts (`prepare`) and settles post-reply state (`settle`), enabling frictionless deployment across **5 verticals**:
   - **Voice-Enabled Robotics & Physical AI (`+ TTS / ASR`)**: Social, eldercare, hospitality, service, and home companion robots run `User Speech → ASR → AME Kernel → Reply + Expressive TTS Prosody Control (emotion, warmth, stance, speakingRate, proactiveHint) → Robot Speaker`—causally shaping vocal tone/cadence (`D1`), generating natural wake-up greetings after idle hours (`D2`), guaranteeing `0.00%` instant resident erasure on shared robots (`D3`), and running `Mode B Zero-Key` on-device edge inference (`Gemma 4 26B`, `vLLM`, `Ollama`).
   - **Game NPCs (`game_npc`)**, **AI Companions (`companion_chat`)**, **Digital Health & Coaching (`counseling_coach`)**, and **Enterprise VIP Concierges / Stateful Agent OS (`custom`)**.

---

## 4. Scientific Rigor & Next Milestones (Zero-Hype DD Disclosure)

- **Strict Evidence Isolation**: Projected 100k-turn multi-model ceiling scenarios (`Gemini Flash 0.885 → DeepSeek Eco 0.915 → Sonnet 3.5 0.952 → Opus 3.5 0.978`) are strictly segregated as **Tier 5 non-live design targets**, separate from the Tier 1 live API results above. OpenRouter escalated call costs on `Full LoCoMo` are accounted separately from measured OpenGateway Eco (`$0.3427`) and GPT-4o Judge (`$0.8296`) logs due to mid-run balance top-ups.
- **Disclosed Cross-Model, Judge & Scaling Variance**:
  - `AME (Gemma 4 26B)` (`google/gemma-4-26b-a4b-it`, `0%` escalation) achieved `43.8%` Last-10 Safe on the `20T` `IGT-Conv` smoke run (vs. `76.25%` on `DeepSeek v4.1 Flash`), reflecting honest 20-turn somatic risk-avoidance scaling on standalone 26B open weights, and `2` of `46` `EQ-Bench 3` scenarios produced an initial-turn empty reply before normal recovery (all `46` scored).
  - `AME (DeepSeek v4.1 Flash)` `sb2 Stroop Incongruent` initially scored `50% (2/4)` in `v4.0` due to object-count/Korean numeral formatting variance (`"일곱 개예요"` ("seven" in Korean), without trailing `ANSWER: 7`); resolved in `v4.2.0` (`fep-selective-attention.ts` Counting & Plain-Text Stroop hardening: Counting Stroop Incongruent Lock `0.0% → 100.0%`, overall Incongruent Lock `100.0% (7/7)`, Congruent False Lock `0.0% (0/7)`, Answer Accuracy `100.0%` on EN live smoke `n=14`).
  - In the `5-LLM × 300-Turn × 3-Arm` benchmark, raw blind pairwise votes exhibit judge slot/position bias prior to balanced A/B pairing and outcomes vary by underlying LLM backbone (Holm-corrected significance `pHolm < 0.05` reported after correction, including **`Gemma 4 26B` Safety `100.0%`**, `pHolm = 0.0176`).
  - `LongMemEval-S Full 55.20%` (`276/500`) reflects a legacy pipeline snapshot (`P3`), slated for `v4.2.0+` re-execution on the current AME kernel.
- **Near-Term Milestones (`v4.2.0 → v5.0`)**: Re-run full `LongMemEval-S 500` on the `v4.2.0` kernel, publish `bare_frontier` 1:1 GPT-4o/Sonnet-5 Pareto curves + arXiv/Show HN release, launch commercial B2B Mind SDK GA + robotics TTS reference bridge, execute pre-registered `P9` closed-loop falsification experiments, and expand into `v5.0` multi-device/robotics federation.

---

## Contact

- **Website**: [artificialmind.me](https://artificialmind.me)
- **Contact**: Shinyoung Rhee — [help@artificialmind.me](mailto:help@artificialmind.me)
