---
license: mit
language:
  - en
tags:
  - benchmarks
  - longmemeval
  - cognitive-os
  - kv-cache
  - d4-redacted
  - evaluation-traces
pretty_name: AME Verified EN Live Evaluation Traces (v4.2.0 – v4.3.0)
configs:
  - config_name: marathon_5000t_en
    data_files:
      - split: test
        path: data/marathon_5000t_en/test-00000-of-00001.parquet
  - config_name: marathon_5000t_checkpoints
    data_files:
      - split: test
        path: data/marathon_5000t_checkpoints/test-00000-of-00001.parquet
  - config_name: multi_llm_5models_en
    data_files:
      - split: test
        path: data/multi_llm_5models_en/test-00000-of-00001.parquet
  - config_name: cogeval_v1_4arms_en
    data_files:
      - split: test
        path: data/cogeval_v1_4arms_en/test-00000-of-00001.parquet
  - config_name: longmemeval_s_n70_v43_metrics
    data_files:
      - split: test
        path: data/longmemeval_s_n70_v43_metrics/test-00000-of-00001.parquet
---

# `artificial-mind/ame-eval-traces` — Verified English Live Evaluation Metrics

D4-redacted per-turn, per-checkpoint, per-model, and per-item evaluation traces from verified 100% English live runs of **Artificial Mind Engine (`v4.2.0` – `v4.3.0`)**.

| Subset (`config_name`) | Rows | Source Run & Key Outcome |
| :--- | ---: | :--- |
| `marathon_5000t_en` | 10000 | Continuous `5,000`-Turn EN Live Marathon (`gpt-4o-mini`, AME vs. Mind-OFF: `96.67%` vs. `0%` Recall, `58.95%` OpenAI `cached_tokens`, `0` D3/D4 leaks) |
| `marathon_5000t_checkpoints` | 10 | Checkpoint progression (`t=100, 500, 1000, 2500, 5000`) for AME vs. Mind-OFF |
| `multi_llm_5models_en` | 10 | 5-Frontier-Model EN Live (`1,000` turns, `750` blind votes across `Claude Sonnet 5.5`, `Gemini 2.5 Flash`, `DeepSeek V3.2`, `Gemma 4 26B A4B`, `GPT-4o mini`; pooled `85.21%` Awareness WR, `pHolm=8.45e-18`) |
| `cogeval_v1_4arms_en` | 4 | CogEval-v1 4-arm comparison (`bare`, `mind_off`, `ame_deepseek`, `ame_gemma`) across D1, HOT, FANToM, FEP Lock, IGT-Conv, D2, D3 & D4 |
| `longmemeval_s_n70_v43_metrics` | 210 | Stratified `LongMemEval-S (n=70)` numerical/judge telemetry across `ame_v4_3_0_pg_jina` (`60.00%`, `-92.67%` tokens), `ame_v4_2_0_lexical` (`38.57%`), and `bare_frontier_104k` (`62.86%`) |

## Quick Usage

```python
from datasets import load_dataset

lme = load_dataset("artificial-mind/ame-eval-traces", "longmemeval_s_n70_v43_metrics", split="test")
print(lme.to_pandas().groupby("arm")[["judge_correct", "query_prompt_tokens"]].mean())
```

## Privacy, Copyright & Governance Guarantees

- **Strict `D4` Redaction**: Automated scan verified **`0` forbidden internal state keys** across all Parquet columns and values.
- **No Copyright Redistribution**: `longmemeval_s_n70_v43_metrics` stores question IDs, slice types, token counts, latencies, D4 audits, and judge verdicts only (upstream source: `xiaowu0162/longmemeval-cleaned`).
- **Evidence Discipline (`AACIM v2.5.2`)**: All empirical metrics reflect specific harness runs (`[관측·E3]`) and engineering contract telemetry (`[공학·E4]`), distinct from clinical or human cognitive claims.
