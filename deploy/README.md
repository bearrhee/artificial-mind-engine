# Sealed Kernel Deployment Guide (`ame-kernel`)

This directory contains the Docker Compose deployment template for running the **Artificial Mind Engine (AME) Sealed Kernel** (`ame-kernel`) alongside its backing PostgreSQL (`pgvector/pgvector:pg17`) and Redis (`redis:7-alpine`) stores.

`artificial-mind-engine` separates the **open MIT-licensed gateway interface, SDKs, examples, and black-box harness** from the **proprietary closed-IP cognitive kernel image** (`ghcr.io/bearrhee/ame-kernel-sealed:latest`). No kernel source code or model weights are mounted from the host.

---

## Architecture

```mermaid
flowchart LR
  subgraph Client["Client Applications & SDKs (MIT)"]
    TS["TypeScript SDK (@ame/sdk) & Node Examples"]
    PY["Python SDK (ame-sdk)"]
    BENCH["cogeval-locomo-harness"]
  end

  subgraph HostNet["Client-Side BYO-LLM Boundary"]
    LLM["Stateless LLM Providers (OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / vLLM)"]
  end

  subgraph ComposeNet["Docker Compose Network (deploy/docker-compose.sealed.yml)"]
    KERNEL["ame-kernel (Port 8090, Closed-IP Image, AME_MODE=sealed-kernel, AME_D4_STRICT_REDACTION=true)"]
    PG[("postgres (pgvector/pgvector:pg17, ame_postgres_data)")]
    REDIS[("redis (redis:7-alpine --appendonly yes, ame_redis_data)")]
  end

  TS -->|"HTTP + X-AME-API-Key (127.0.0.1:8090)"| KERNEL
  PY -->|"HTTP + X-AME-API-Key (127.0.0.1:8090)"| KERNEL
  BENCH -->|"HTTP + X-AME-API-Key (127.0.0.1:8090)"| KERNEL

  Client -->|"Mode B Zero-Key (Direct LLM call with client key)"| LLM
  KERNEL -.->|"Mode A Proxy (Transient per-request llm.apiKey only)"| LLM

  KERNEL -->|"DATABASE_URL / AME_DATABASE_URL (Internal Network)"| PG
  KERNEL -->|"REDIS_URL / AME_REDIS_URL (Internal Network)"| REDIS
```

### Service Inventory

| Service | Image | Host Port | Persistence | Role |
| :--- | :--- | :--- | :--- | :--- |
| `ame-kernel` | `${AME_SEALED_IMAGE:-ghcr.io/bearrhee/ame-kernel-sealed:latest}` | `${AME_PORT:-8090}:8090` | None (zero source bind mounts) | Closed-IP Cognitive OS Kernel & OpenAPI 3.1 Gateway |
| `postgres` | `pgvector/pgvector:pg17` | Internal only | `ame_postgres_data:/var/lib/postgresql/data` | Persistent Mind state, memories, embeddings, revocation ledger |
| `redis` | `redis:7-alpine` (`--appendonly yes`) | Internal only | `ame_redis_data:/data` | Ephemeral turn tickets, KV prefix epoch, `revocationEpoch` state |

---

## Prerequisites

- **Docker Engine** and **Docker Compose v2+** (`docker compose version`)
- A valid **AME License Key** (`AME_LICENSE_KEY`) for `AME_MODE=sealed-kernel`
- Registry authentication (`docker login ghcr.io`) if pulling a private commercial/evaluation `AME_SEALED_IMAGE`

---

## Step-by-Step Launch

### 1. Create `deploy/.env` from `.env.example`

From the `deploy/` directory (or repository root):

```bash
# Inside deploy/
cp .env.example .env
```

Or on Windows PowerShell from the repository root:

```powershell
Copy-Item deploy/.env.example deploy/.env
```

Edit `deploy/.env` and replace all placeholder secrets:

- `AME_API_KEY`: Shared gateway secret required in the `X-AME-API-Key` header.
- `AME_LICENSE_KEY`: Commercial or evaluation license key for the sealed kernel.
- `POSTGRES_PASSWORD`: Strong URL-safe password (alphanumeric, `-`, `_`) for PostgreSQL.

> **Important:** Never put LLM provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.) inside `deploy/.env`. See [Security Boundaries](#security-boundaries-d3--d4--byo-llm).

### 2. Start the Sealed Kernel Stack

Run from the repository root:

```bash
docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env up -d
```

Docker Compose waits for `postgres` (`pg_isready`) and `redis` (`redis-cli ping`) to become healthy before starting `ame-kernel`.

### 3. Verify Container Health & `/v1/health`

Check container status:

```bash
docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env ps
```

Probe the unauthenticated `/v1/health` endpoint:

```bash
curl -fsS http://127.0.0.1:8090/v1/health
```

PowerShell:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8090/v1/health"
```

Expected response shape (per [`spec/openapi.yaml`](../spec/openapi.yaml)):

```json
{
  "ok": true,
  "service": "ame-kernel",
  "version": "1.0.0",
  "mode": "sealed-kernel",
  "domains": ["game_npc", "companion_chat", "counseling_coach", "custom"]
}
```

Confirm `"mode": "sealed-kernel"` and `"ok": true`.

---

## Running Examples & Benchmarks Against `http://127.0.0.1:8090`

Both `@ame/sdk` (`packages/sdk-ts`) and `ame-sdk` (`packages/sdk-python`) read `AME_BASE_URL` and `AME_API_KEY` automatically.

### Set Target Environment Variables

**Bash / Zsh:**

```bash
export AME_BASE_URL="http://127.0.0.1:8090"
export AME_API_KEY="your-ame-api-key-from-deploy-env"
```

**PowerShell:**

```powershell
$env:AME_BASE_URL = "http://127.0.0.1:8090"
$env:AME_API_KEY = "your-ame-api-key-from-deploy-env"
```

### TypeScript / Node Examples

Run the domain examples defined in root [`package.json`](../package.json) against the sealed kernel:

```bash
npm run example:game
npm run example:chat
npm run example:counseling
```

### Python SDK (`packages/sdk-python`)

Install or point `PYTHONPATH` to `packages/sdk-python`, then verify `/v1/health` and Mind creation against `http://127.0.0.1:8090`:

```bash
PYTHONPATH=packages/sdk-python python -c "
from ame_sdk.client import AmeClient
with AmeClient() as client:
    print(client.health())
"
```

### `cogeval-locomo-harness` Benchmark

Run the black-box evaluation harness against the live sealed kernel:

```bash
npm run bench:smoke
```

Equivalent direct invocation:

```bash
AME_BASE_URL=http://127.0.0.1:8090 AME_API_KEY="$AME_API_KEY" node benchmarks/cogeval-locomo-harness/run_harness.mjs
```

---

## Security Boundaries (`D3` / `D4` / `BYO-LLM`)

### 1. Closed-IP & Host Isolation

- **Zero source bind mounts:** `ame-kernel` has no host volume mounts in `docker-compose.sealed.yml`. All proprietary kernel binaries remain encapsulated inside the container image.
- **Internal database isolation:** Neither `postgres` (5432) nor `redis` (6379) publishes ports to the host; only `ame-kernel` exposes `${AME_PORT:-8090}`.
- **Production ingress note:** In multi-host or public deployments, place `ame-kernel` behind a TLS-terminating reverse proxy or bind host port mapping to loopback (`127.0.0.1:${AME_PORT:-8090}:8090`).

### 2. BYO-LLM Credential Boundary (Zero Stored LLM Keys)

`deploy/.env` **never stores LLM provider API keys**. You retain full control over provider credentials:

- **Mode A — Proxy BYO-LLM (`POST /v1/minds/{mindId}/turn`):**
  The client passes `llm.apiKey` transiently inside each request payload. `ame-kernel` executes the upstream LLM call in memory and never persists or logs `llm.apiKey`.
- **Mode B — Zero-Key Prepare/Settle (`POST /v1/minds/{mindId}/prepare` → client LLM call → `POST /v1/minds/{mindId}/settle`):**
  `ame-kernel` returns prefix-aligned prompts, safety directives, and an ephemeral `turnTicketId`. Your application invokes your chosen LLM (cloud or on-prem vLLM/Ollama) directly, so LLM API keys never cross the `ame-kernel` network boundary.

### 3. `D3` Triple Atomic Memory Revocation

Calling `DELETE /v1/minds/{mindId}/memories/{memoryId}` enforces three-layer erasure across the backing stores:

1. **PostgreSQL transactional deletion:** Deletes the primary memory record, linked turn chunks, and derived traces.
2. **Redis epoch invalidation:** Atomically increments `revocationEpoch` and purges stale cached state tied to prior epochs.
3. **Query-time opt-out guard:** Returns a `RevocationReceipt` verifying `residualLeakCheck: "0.00%"` so revoked secrets cannot resurrect in subsequent turns.

### 4. `D4` Unconscious–Conscious Firewall

`docker-compose.sealed.yml` hard-pins `AME_D4_STRICT_REDACTION=true`:

- Raw internal continuous vectors (`Layer 0–1` affective/endocrine state) are never serialized into prompts, logs, or API responses.
- `/v1/minds/{mindId}`, `/v1/minds/{mindId}/telemetry`, and `TurnResult.telemetry` emit only `SafeTelemetry` (`d4Redacted: true`).

---

## Lifecycle & Maintenance

View logs:

```bash
docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env logs -f ame-kernel
```

Stop containers while preserving persistent Postgres & Redis volumes (`ame_postgres_data`, `ame_redis_data`):

```bash
docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env down
```

Destroy containers **and wipe all persistent Mind memories and Redis epochs** (irreversible):

```bash
docker compose -f deploy/docker-compose.sealed.yml --env-file deploy/.env down -v
```
