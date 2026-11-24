# Game NPC Example (`Thorin Ironanvil`)

Demonstrates the **`game_npc`** vertical on top of the Artificial Mind Engine (AME) using **Mode A (Proxy BYO-LLM)** with **per-turn hot-swappable LLM providers**, **somatic affective shifts** on betrayal vs. fair trade, and **D2 offline homeostasis ticks**.

## What This Example Exercises

1. **Gateway Health & Mind Creation**: Checks `GET /v1/health` and provisions an isolated persistent `game_npc` Mind (`Thorin Ironanvil`, Forge Blacksmith).
2. **Per-Turn Live LLM Hot-Swapping** (without losing NPC memory or somatic state):
   - **Turn 1**: `deepseek` (`deepseek-chat`) — Peaceful forge greeting & sword inquiry (`rewardSignal: 20`).
   - **Turn 2**: `anthropic` (`claude-sonnet-4-5`) — Theft attempt & betrayal (`rewardSignal: -250`, `outcomeTags: ['theft_attempt', 'betrayal']`), asserting aversive somatic/trust shift (`npcTrustDelta <= 0`, `somaticTrend === 'aversive_caution'` or guarded/alert band, `d4Redacted === true`).
   - **Offline Gap (D2)**: `POST /v1/minds/{mindId}/idle-tick` (`elapsedHours: 14`, `reason: 'overnight_forge_rest'`), verifying numeric `homeostasisBefore` / `homeostasisAfter`.
   - **Turn 3**: `openai` (`gpt-4o-mini`) — Reconciliation & fair trade (`rewardSignal: 50`, `outcomeTags: ['fair_trade', 'reconciliation']`).
3. **Structured `domainOutput` Contract**: Explicitly logs and asserts `dialogue`, `emotionVector`, `facialExpressionHint`, `actionIntent`, and `npcTrustDelta` on every turn (mapping sandbox contract aliases `emotion`, `stance`, `questCue`, and `affinityDelta` seamlessly when running against `ame-sandbox-server`).

```text
Turn 1 (deepseek / mock)   ──► Peaceful greeting (+20)
Turn 2 (anthropic / mock)  ──► Theft & betrayal (-250)  ──► aversive shift / negative trust delta
Idle Tick (14h overnight)  ──► Homeostasis recovery     ──► homeostasisBefore -> homeostasisAfter
Turn 3 (openai / mock)     ──► Fair trade apology (+50) ──► trust & somatic recovery
```

## Quickstart (Zero-Key Sandbox Mode)

From the repository root:

```bash
# Terminal 1: start the local AME sandbox server
npm run sandbox

# Terminal 2: run the Game NPC vertical
npm run example:game
# or directly:
node examples/game-npc/run.mjs
```

When `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` are unset, each turn automatically falls back to `provider: "mock"` (`mock-rpg-v1`).

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AME_BASE_URL` | `http://127.0.0.1:8090` | AME Gateway / Sandbox base URL |
| `AME_API_KEY` | `dev-sandbox-key` | Gateway API key (`X-AME-API-Key`) |
| `DEEPSEEK_API_KEY` | _(unset -> mock)_ | Enables live `deepseek` on Turn 1 |
| `ANTHROPIC_API_KEY` | _(unset -> mock)_ | Enables live `anthropic` on Turn 2 |
| `OPENAI_API_KEY` | _(unset -> mock)_ | Enables live `openai` on Turn 3 |
| `DEEPSEEK_MODEL` / `ANTHROPIC_MODEL` / `OPENAI_MODEL` | `deepseek-chat` / `claude-sonnet-4-5` / `gpt-4o-mini` | Optional model overrides |
