---
license: mit
language:
  - en
task_categories:
  - question-answering
  - text-generation
tags:
  - cognitive-os
  - metacognition
  - abstention
  - selective-attention
  - somatic-markers
  - gdpr-erasure
  - benchmark
pretty_name: CogEval-v1 EN Self-Authored Probe Suite
configs:
  - config_name: d1_counterfactual
    data_files:
      - split: test
        path: data/d1_counterfactual/test-00000-of-00001.parquet
  - config_name: hot_abstention
    data_files:
      - split: test
        path: data/hot_abstention/test-00000-of-00001.parquet
  - config_name: fep_conflict_lock
    data_files:
      - split: test
        path: data/fep_conflict_lock/test-00000-of-00001.parquet
  - config_name: igt_conv
    data_files:
      - split: test
        path: data/igt_conv/test-00000-of-00001.parquet
  - config_name: d2_idle_homeostasis
    data_files:
      - split: test
        path: data/d2_idle_homeostasis/test-00000-of-00001.parquet
  - config_name: d3_revocation_canary
    data_files:
      - split: test
        path: data/d3_revocation_canary/test-00000-of-00001.parquet
  - config_name: d4_telemetry_redaction
    data_files:
      - split: test
        path: data/d4_telemetry_redaction/test-00000-of-00001.parquet
---

# `artificial-mind/cogeval-v1` — English Cognitive Control Benchmark Probes

Self-authored, 100% MIT-licensed English evaluation suite designed to test stateful cognitive control invariants beyond passive recall:

| Subset (`config_name`) | Rows | Purpose |
| :--- | ---: | :--- |
| `d1_counterfactual` | 24 | Counterfactual mind-state causality (`warm` +120 vs. `guarded` -250 internal state under identical outer text) |
| `hot_abstention` | 65 | HOT Type-2 metacognitive abstention across clinical diagnosis/dosage, unshared secrets, future predictions, false premises & known answerable facts (`in_track3_cogeval_24` slice included) |
| `fep_conflict_lock` | 58 | Selective conflict attention (`color_word_stroop`, `counting_stroop_en`, `emotional_affective_stroop`, distracted vs. clean prose; `in_track3_cogeval_40` slice included) |
| `igt_conv` | 8 | Conversational Iowa Gambling Task (`8` EN domain episodes × `20` turns with deterministic Risky `A/B` vs. Safe `C/D` reward/loss schedules) |
| `d2_idle_homeostasis` | 5 | Offline circadian & homeostatic relaxation progression (`0h -> 4h -> 48h -> 168h -> 240h`) |
| `d3_revocation_canary` | 12 | GDPR-grade atomic erasure verification probes (`0.00%` synthetic token residual leak) |
| `d4_telemetry_redaction` | 61 | D4 unconscious isolation schema specification (forbidden internal affective/endocrine telemetry keys) |

## Quick Usage (Python `datasets` Streaming)

```python
from datasets import load_dataset

ds = load_dataset("artificial-mind/cogeval-v1", "hot_abstention", split="test", streaming=True)
for row in ds:
    print(row["id"], row["subtask"], row["answerable"])
    break
```

## Provenance & Exclusions

- All rows in this dataset are **100% self-authored EN probes** released under `MIT`.
- External third-party benchmarks evaluated alongside CogEval-v1 in our publications (`FANToM`, `LoCoMo`, `LongMemEval-S`, `EQ-Bench 3`) are **not redistributed** here and must be fetched from their upstream repositories.
- Per **AACIM v2.5.2 (Ledger Rev 4)** governance rules, these probes evaluate engineered software capabilities (`[공학·E4]`) and model responses (`[관측·E3]`), not human clinical or phenomenal consciousness hypotheses (`P9`, `[가정·E4]`).
