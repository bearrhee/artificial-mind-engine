# `ame-sdk` — Artificial Mind Engine Python SDK

Zero-dependency Python 3.10+ SDK (standard library only) implementing the full Artificial Mind Engine (AME) Gateway contract ([`openapi.yaml`](../../spec/openapi.yaml)).

## Installation

```bash
pip install -e packages/sdk-python
```

No third-party `pip` dependencies are required (`dependencies = []`).

## Quickstart

### Domain Profiles (`define_domain_profile`)

Create Minds from built-in domain presets (`game_npc`, `companion_chat`, `counseling_coach`, `custom`) or define a custom structured output schema:

```python
from ame_sdk import (
    AmeClient,
    DOMAIN_PROFILES,
    build_game_npc_profile,
    define_domain_profile,
)

client = AmeClient(base_url="http://127.0.0.1:8090", api_key="your-ame-key")

# Built-in preset or builder
npc_profile = build_game_npc_profile(name="Kaelen", role="Guild Quartermaster")
mind = client.create_mind(npc_profile)

# Custom domain with customSchema fields
custom_profile = define_domain_profile(
    name="TriageBot",
    role="Workflow Advisor",
    domain="custom",
    traits={"precision": 0.9},
    output_fields=["summary", "confidence", "nextAction"],
)
custom_mind = client.create_mind(custom_profile)
```

### Mode A — Proxy BYO-LLM (`client.turn`)

AME prepares cognitive state, invokes the chosen provider per request (without storing your LLM key), and settles the turn atomically:

```python
result = client.turn(
    mind["mindId"],
    user_input="Do you remember the obsidian blade I brought yesterday?",
    llm={
        "provider": "openai",
        "model": "gpt-4o-mini",
        "api_key": "sk-...",
        "temperature": 0.6,
        "max_tokens": 512,
    },
    reward_signal=0.8,
    outcome_tags=["trust_gain"],
)
print(result["reply"], result["domainOutput"])
```

### Mode B — Zero-Key Local Execution (`run_turn_with_local_llm`)

Keep your LLM keys strictly inside your own application runtime (`prepare` -> local adapter -> `settle`):

```python
from ame_sdk import create_llm_adapter, run_turn_with_local_llm

adapter = create_llm_adapter("anthropic", model="claude-3-5-sonnet-latest")
result = run_turn_with_local_llm(
    client,
    mind["mindId"],
    user_input="What is my current guild standing?",
    adapter=adapter,
)
```

## Supported LLM Providers (6 + Mock)

| Provider | Aliases | Default Endpoint | Env Key |
| --- | --- | --- | --- |
| `openai` | `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` |
| `anthropic` | `anthropic` | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `GEMINI_API_KEY` |
| `deepseek` | `deepseek` | `https://api.deepseek.com/v1/chat/completions` | `DEEPSEEK_API_KEY` |
| `openrouter` | `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` |
| `openai-compat` | `openai_compat`, `openai-compat` | `http://127.0.0.1:11434/v1/chat/completions` | Optional (`api_key`) |
| `mock` | `mock` | Zero-network deterministic local adapter | None |

## Core Guarantees (D2, D3, D4)

- **D2 Offline Homeostasis (`idle_tick`)**: Advance circadian/homeostasis state across absence gaps (`elapsed_hours` in `0..720`):
  ```python
  tick = client.idle_tick(mind["mindId"], elapsed_hours=12.5, reason="overnight_rest")
  ```
- **D3 Atomic Memory Revocation (`revoke_memory`)**: Purge a memory atomically across store, cache epoch, and derivatives with `residualLeakCheck == "0.00%"`:
  ```python
  receipt = client.revoke_memory(mind["mindId"], memory_id)
  assert receipt["revoked"] is True and receipt["residualLeakCheck"] == "0.00%"
  ```
- **D4 Telemetry Isolation (`get_telemetry`)**: Inspect `affectiveBand`, `fepMode`, `freeEnergy`, `kvPrefixEpoch`, and `revocationEpoch` with `d4Redacted == True` and zero raw unconscious/endocrine internal state vectors leaked:
  ```python
  telemetry = client.get_telemetry(mind["mindId"])
  assert telemetry["d4Redacted"] is True
  ```

## Running Tests

From the repository root (`D:\_Code\artificial-mind-engine`):

```bash
python -m unittest discover -s packages/sdk-python/tests -v
```
