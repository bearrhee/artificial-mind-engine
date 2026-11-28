---
title: Artificial Mind Engine — Benchmark Explorer
emoji: 📊
colorFrom: cyan
colorTo: slate
sdk: static
app_file: index.html
license: mit
short_description: Interactive charts for LoCoMo, EQ-Bench 3, CogEval-v1, 5,000T EN & LongMemEval-S v4.3.0
tags:
  - benchmarks
  - longmemeval
  - locomo
  - eq-bench
  - memory
  - cognitive-os
  - visualization
---

# Artificial Mind Engine (AME) — Benchmark Explorer

Interactive showcase for verified Tier-1 benchmarks of **Artificial Mind Engine (`v4.2.0` – `v4.3.0`)**.

## Headline Verified Metrics (100% EN Live + Cross-Backbone SOTA)

- **LongMemEval-S Stratified EN (`n=70`, `gpt-4o-mini`, `v4.3.0` PGVector + Jina)**: **`60.00%` (`42/70`, `+21.43%p` over `v4.2.0` lexical `38.57%`)**, **`-92.67%` query prompt tokens (`7,633` vs. `104,123` Bare Frontier, `13.64x` compression)**, `0.9857x` $O(1)$ scaling, **`0/17,745` `D4` leaks**.
- **5,000-Turn Continuous EN Live Marathon (`gpt-4o-mini`)**: **`96.67%` (`58/60`) Fact Recall** (`Mind-OFF 0%`), **`58.95%` Real OpenAI `cached_tokens` (`8.68M` cached)**, **`100%` HOT TPR (`FAR 0%`)**, **`100%` FEP Conflict Lock (`0%` calm)**, **`0%` D3 & D4 leaks**.
- **5-Frontier-Model EN Live (`1,000` turns, `750` blind votes)**: **`98.33%` objective recall**, **`85.21%` pooled blind Memory Awareness win rate** (`pHolm = 8.45e-18`), winning across all 5 LLMs (`Claude Sonnet 5.5`, `Gemini 2.5 Flash`, `DeepSeek V3.2`, `Gemma 4 26B A4B`, `GPT-4o mini`).
- **LoCoMo Confirm-304 (`n=304`) & EQ-Bench 3 (`n=46 × 4T`)**: **`85.86%`** (`AME DeepSeek v4.1 Flash + selective Sonnet-5`) / **`75.66%` standalone on `Gemma 4 26B`** (`> Zep 75.1%`); `EQ-Bench 3` **`77.77` (`Gemma 4 26B`)** / **`77.59` (`DeepSeek v4.1 Flash`)** (`> GPT-5.2 72.2`).
- **1M-Turn EN Convergence (`v4.2.0`)**: Track A **`0.9182`** (`driftDelta = 0.0001`), Track B **`100.0%` EN polarity**.

*Governance note (`AACIM v2.5.2`):* All LLM benchmark outcomes are small-sample/harness empirical measurements (`[관측·E3]`) and engineering telemetry checks (`[공학·E4]`), kept strictly separate from untested human-consciousness hypotheses (`P9`, `[가정·E4]`).

## Related Hugging Face Assets

- **Live Docker Sandbox**: [huggingface.co/spaces/artificial-mind/ame-sandbox-live](https://huggingface.co/spaces/artificial-mind/ame-sandbox-live)
- **CogEval-v1 Benchmark Probes (Parquet)**: [huggingface.co/datasets/artificial-mind/cogeval-v1](https://huggingface.co/datasets/artificial-mind/cogeval-v1)
- **Evaluation Traces & Metrics (Parquet)**: [huggingface.co/datasets/artificial-mind/ame-eval-traces](https://huggingface.co/datasets/artificial-mind/ame-eval-traces)
- **GitHub Source**: [bearrhee/artificial-mind-engine](https://github.com/bearrhee/artificial-mind-engine)
