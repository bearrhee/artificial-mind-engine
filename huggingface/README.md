# Hugging Face Hub Packaging (`artificial-mind`)

This folder packages the **MIT Open Interface**, interactive **Sandbox & Benchmark Spaces**, and **D4-redacted Parquet Datasets** for publishing under the **`artificial-mind`** Hugging Face organization — while keeping the proprietary 5-layer kernel source **100% excluded** (`Closed-IP & Secret Guard`).

## Published Asset Map (`https://huggingface.co/artificial-mind`)

| Asset Type | Repository ID | Source Contents | Purpose |
| :--- | :--- | :--- | :--- |
| **Docker Space** | [`artificial-mind/ame-sandbox-live`](https://huggingface.co/spaces/artificial-mind/ame-sandbox-live) | `huggingface/spaces/ame-sandbox-live/` + `packages/sandbox-server` + `packages/sdk-ts` + `spec/openapi.yaml` | Interactive zero-key OpenAPI 3.1 contract sandbox (`port 7860`, `/tmp` storage) |
| **Static Space** | [`artificial-mind/ame-benchmarks`](https://huggingface.co/spaces/artificial-mind/ame-benchmarks) | `huggingface/spaces/ame-benchmarks/README.md` + `docs/index.html` + `docs/charts/*.svg` | Zero-cost interactive chart explorer & live SVG showcase |
| **Dataset (Parquet)** | [`artificial-mind/cogeval-v1`](https://huggingface.co/datasets/artificial-mind/cogeval-v1) | `huggingface/datasets/cogeval-v1/` (7 Parquet subsets) | Self-authored EN cognitive control probes (`D1`, `HOT`, `FEP`, `IGT-Conv`, `D2`, `D3`, `D4`) |
| **Dataset (Parquet)** | [`artificial-mind/ame-eval-traces`](https://huggingface.co/datasets/artificial-mind/ame-eval-traces) | `huggingface/datasets/ame-eval-traces/` (5 Parquet subsets) | Verified D4-redacted `5,000T` EN, `5-LLM` EN, `CogEval-v1` 4-arm & `LongMemEval-S v4.3.0 (n=70)` telemetry |

> **Why no empty `Models` repo?** AME is a **model-agnostic cognitive OS kernel** rather than fixed neural weights. Hosting weightless API wrappers under HF `Models` violates platform best-effort guidelines and gains zero discovery traction; Spaces + Parquet Datasets + Collections + Papers align natively with HF trending signals without exposing closed-kernel IP.

## Local Verification (Dry Run — No Token Required)

```bash
# 1. Validate Parquet datasets (add --from-scratch if regenerating from local scratch artifacts)
python huggingface/build_hf_datasets.py --verify-only

# 2. Stage all 4 HF repos locally, verify YAML frontmatter, Parquet readability & Closed-IP/Secret guard
python huggingface/publish_to_hf.py --org artificial-mind --dry-run
```

## Live Publish (Requires `artificial-mind` Org & Write `HF_TOKEN`)

1. Create the **`artificial-mind`** organization on Hugging Face (`https://huggingface.co/organizations/new`).
2. Generate a write token (`https://huggingface.co/settings/tokens`) with write scope to `artificial-mind`.
3. Either run locally or add **`HF_TOKEN`** as a GitHub Repository Secret (`Settings -> Secrets and variables -> Actions -> HF_TOKEN`):

```bash
HF_TOKEN=hf_xxx python huggingface/publish_to_hf.py --org artificial-mind
```

When `HF_TOKEN` is set in GitHub Actions Secrets, pushing changes under `huggingface/`, `docs/`, `packages/sandbox-server/`, `packages/sdk-ts/`, or `spec/openapi.yaml` automatically runs [`.github/workflows/sync-huggingface.yml`](../.github/workflows/sync-huggingface.yml).
