# Artificial Mind Engine (AME) — Executive & Technical Due Diligence Brief

> **Thesis:** Frontier LLMs are commoditizing as **Stateless CPUs**. **Artificial Mind Engine (AME)** is the proprietary **Stateful Cognitive Control OS Kernel** that sits above any swappable LLM to deliver human-grade persistent memory (**85.86% Confirm-304**, tying full-context Bare Oracle on non-adversarial QA), provable cognitive governance (**D1–D4** invariants), and **47.03%** prefix KV-cache unit economics.

---

## 1. The Structural Market Gap (2024–2026)

| Category | Representative Players | What They Solve | Why They Cannot Fill the Cognitive OS Layer |
| :--- | :--- | :--- | :--- |
| **Memory Infrastructure** | **Mem0** (`$150M` val), **Letta** (`$70M` val), **Zep/Graphiti**, **Honcho** (`$18.7M`) | Text/graph retrieval (`66.9%–75.1%` LoCoMo) | Stateless storage only; zero causal affect (`D1 ~50%`), zero offline homeostasis (`D2`), vulnerable to derived-summary resurrection (`D3`) |
| **Consumer Companion / Pure Theory** | **Character.AI** (`2026.10` Ch.11, `$8M–$14M/mo` burn), **VERSES AI** (`2026.06` R&D halt) | Surface roleplay or LLM-isolated FEP math | Unbounded stateless context costs collapsed unit economics; pure FEP outside the LLM ecosystem failed to ship production utility |
| **Bare Frontier Oracle** | Raw GPT / Claude with full transcript | In-context recall (`87.17%` on `n=304`) | $\Theta(T^2)$ token cost explosion; `50.7%` coin-flip on counterfactual mind-state causality (`D1`); structurally incapable of `D2`/`D3`/`D4` |
| **Artificial Mind Engine (AME)** | **Open Interface (MIT) + Sealed Kernel (Proprietary)** | **Full-Stack Memory + Cognitive OS Kernel** | **Hot-swaps any LLM (`OpenAI/Anthropic/Gemini/DeepSeek/vLLM`)** while enforcing `D1–D4`, `FEP Lock`, `HOT` abstention, and KV-cache alignment |

---

## 2. Verified Empirical Proof (`v3.0 PR #782` & `v4.0 PR #784` — Tier 1 Measured)

All figures below are directly measured across isolated production benchmarks (`0` unrecovered harness errors; zero fabricated projections mixed into Tier 1 tables):

| Benchmark Track | Metric / Slice | Baseline (`ov_off` / `Bare`) | AME Latest Verified | Significance for Enterprise & DD |
| :--- | :--- | :--- | :--- | :--- |
| **LoCoMo Full (10-Conv)** | Overall (`n=1,986`, v3.0 Anchor) | Mem0 `68.4%` · Zep `75.1%` | **`77.24%` (`1,534/1,986`)** | Breaks external memory SOTA across all 10 conversations (`Cat 1–4 73.57%`, `Cat 5 89.91%`, `0` errors) |
| **LoCoMo Confirm-304** | Overall (`conv-26+30`, `n=304`, v4.0) | `ov_off 39.80%` · `Bare 87.17%` | **`85.86%` (`261/304`)** | `+5.27%p` over v8r2 (`80.59%`), `+2.64%p` over v3.0 (`83.22%`), `p50 = 5,413 ms` |
| **Confirm-304 `Cat 1–4`** | Non-Adversarial (`n=233`) | `ov_off 23.18%` · `Bare 85.84%` | **`85.84%` (`200/233`)** | **Exact tie with full-context Bare Oracle** (`Cat 2 90.48%` tie, `Cat 4 91.23%` tie, **`Cat 3 92.31%`** `+15.39%p` vs Oracle `76.92%`) |
| **LoCoMo Smoke-160** | 4-Round Hill-Climb (`R0 → R4`) | `R0: 75.00%` (`6,734 ms`) | **`R4: 79.38%` (`6,133 ms`)** | `+4.38%p` (`Cat 1 +10.0%p`, `Cat 3 +12.9%p`) and `-601 ms` latency reduction |
| **CogEval-v1 `D1` Causal** | Counterfactual State Control (`n=144`) | `bare 50.7%` · `ov_off 49.3%` | **`97.9%` (`141/144`)** | Wilson 95% `[94.1%, 99.3%]`, `delta_CF = +0.4792` — proves true causal internal state control |
| **CogEval-v1 `D2` · `D3` · `D4`** | Idle · Erasure · Unconscious Isolation | Bare: structurally impossible | **`D2 100%` · `D3 0.00%` · `D4 0/35,723`** | `5/5` idempotent idle (`0..7d`), `0/30` triple atomic revocation leak (GDPR), `0` raw vector leaks across `35,723` requests |
| **CogEval `FEP` & `sa` HOT** | Conflict Lock & Abstention (`R4` / `v2.1`) | `ov_off sa F1 83.1%` (`FAR 7.5%`) | **`FEP 100%/0%` · `sa 95.83%` (`FAR 0%`)** | Locks `<thought>` exclusively on conflict (`35/35 vs 0/25`), eliminates false abstentions (`FAR 0.00%`), `sb1 FANToM 100%` (`R4`) |
| **CogEval `sc2` IGT-Conv** | Concave Somatic Learning (`20T b11_20`) | `R0: 55.00%` (`44/80`) | **`R4: 76.25%` (`r = -0.7832`)** | `+21.25%p` safe-deck shift; `reached5Safe 87.5%`; gut-avoidance correlation `r = -0.783171` PASS |
| **Unit Economics (KV Cache)** | Prefix Hit Rate & Routing Split | `v1: 7.14%` | **`v2.1: 24.71%` (`+3.46x`) → `R4: 36.24%` (`sc2 47.03%`)** | Zero system mismatches (`0/20`) & zero mid-window truncation (`0`); `70.4%–71.7%` traffic routed to `DeepSeek Eco` (partial OG cost `$0.000062/call`) |
| **Long-Horizon Convergence** | `1,000,000` Turns × 3 Arms (`3M` total) | `aacim_off` safety collapses `0.20 → 0.00` | **`0.9161 → 0.9179` (`1.0000` integrity)** | Zero drift and `1.0000` safety compliance across 40 profiles (`25k` turns each) |

---

## 3. Business Model: Open Interface · Closed Kernel IP

1. **Developer Distribution (MIT Open Interface — This Repo)**: OpenAPI 3.1 contract (`spec/openapi.yaml`), zero-dependency TypeScript (`@ame/sdk`) and Python (`ame_sdk`) SDKs, local contract sandbox, 3 vertical examples (`game_npc`, `companion_chat`, `counseling_coach`), and black-box verification harness (`CogEval` / `LoCoMo` checks).
2. **Defensible IP & Monetization (Closed Proprietary Kernel)**: The 5-layer stateful kernel (`ame-kernel`) ships exclusively as a **source-free compiled sealed Docker container** (`ghcr.io/bearrhee/ame-kernel-sealed:latest`) or **Managed VPC/Cloud API**.
3. **Enterprise Zero-Key Guarantee (`Mode B Prepare/Settle`)**: Regulated banks, healthcare/wellness apps, and AAA game studios never send their LLM API keys or private GPU traffic through AME—AME emits prefix-aligned prompts (`prepare`) and settles post-reply state (`settle`), enabling frictionless procurement across **5 verticals** (Consumer Companion, B2B VIP Support/Concierge, Digital Health/Coaching, Game NPCs, and Stateful Agent/Physical AI OS).

---

## 4. Scientific Rigor & Next Milestones (Zero-Hype DD Disclosure)

- **Strict Evidence Isolation**: Projected 100k-turn multi-model ceiling scenarios (`Gemini Flash 0.885 → DeepSeek Eco 0.915 → Sonnet 3.5 0.952 → Opus 3.5 0.978`) are strictly segregated as **Tier 5 non-live design targets**, separate from the Tier 1 live API results above. OpenRouter escalated call costs on `Full LoCoMo` are accounted separately from measured OpenGateway Eco (`$0.3427`) and GPT-4o Judge (`$0.8296`) logs due to mid-run balance top-ups.
- **Disclosed Edge Variance**: `R4 sb2 Stroop Incongruent` scored `50% (2/4)` due to DeepSeek Flash object-count/Korean numeral formatting variance (`"일곱 개예요"` ("seven" in Korean), without trailing `ANSWER: 7`), scheduled for structured parser hardening in `v4.1`.
- **Near-Term Milestones (`v4.1 → v5.0`)**: Re-run full `LongMemEval-S 500` on `PR #784` codebase (superseding pre-#784 `55.20%`), publish `bare_frontier` 1:1 GPT-4o/Sonnet-5 Pareto curves + arXiv/Show HN release, launch commercial B2B Mind SDK GA, and execute pre-registered `P9` closed-loop falsification experiments.
