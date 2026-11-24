# 3+1 Multi-Domain Application Integration Guide

> **Simply switching the `domain` parameter on a single Kernel API (`/v1/minds`) automatically activates structured outputs (`domainOutput`) and domain-specific safety policies for game NPCs, AI companions, counseling/coaching, and custom enterprise agents.**

---

## 1. Domain Profile Matrix (`DomainId`)

`spec/openapi.yaml` defines four domains (`game_npc`, `companion_chat`, `counseling_coach`, `custom`) as standard contracts.

| `domain` ID | Representative Use Cases | Recommended Default `safetyPolicy` | Primary Kernel Layers Used | Example Run Command |
| :--- | :--- | :--- | :--- | :--- |
| **`game_npc`** | RPG merchants/companions, open-world NPCs, strategy simulation AI | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: false` | **L1** Somatic Markers (betrayal/reward) + **L2** `sb1 FANToM` information asymmetry + **L4** `D2` idle homeostasis | `npm run example:game` |
| **`companion_chat`** | AI friends, story characters, personal assistants, social wearables | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: false` | **L3** Epoch-stable KV cache (`47.03%`) + **L5** Long-term memory (`85.86%`) + **L0/L1** Affective inertia | `npm run example:chat` |
| **`counseling_coach`** | Mental wellness coaches, habit formation, customer care concierges | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: true` | **L4** `sa` HOT abstention (`FAR 0%`) + **L5** `D3` atomic revocation (`0.00%`) + **L1/L5** `D4` non-exposure | `npm run example:counseling` |
| **`custom`** | Internal enterprise workflow agents, VIP concierges, edtech tutors | Domain-tailored (`defineDomainProfile` / `define_domain_profile`) | Structured contract extraction based on `customSchema: { name, fields }` | `SDK defineDomainProfile()` |

---

## 2. Domain Structured Outputs (`TurnResult.domainOutput`) & Integration Patterns

> [!NOTE]
> `TurnResult.domainOutput` is defined in `spec/openapi.yaml` as an `object` contract (`additionalProperties: true`) and is structured at settlement (`settle` / `turn`) according to the field contract specified by `PrepareTurnResponse.domainOutputContract`. The examples below illustrate the contract payloads produced by `packages/sandbox-server` and each domain adapter.

### A. Game NPC (`game_npc`) — Unity / Unreal / Game Server Integration

Stateless LLM-driven NPCs forget a player's betrayal within three turns, act as though NPC B knows what Player A secretly stole (information asymmetry collapse), and repeat their last line even after 14 hours offline. The AME `game_npc` domain combines negative/positive `rewardSignal` transitions, `idleTick`, and `fepThoughtLock` to return structured JSON that game engines can parse immediately.

**Local Run:**
```bash
npm run sandbox       # Terminal 1: Start the contract sandbox (127.0.0.1:8090)
npm run example:game  # Terminal 2: Run the Game NPC hot-swap & reward/idle scenario
```

**Request & Response Structure (`TurnResult` Excerpt):**
```json
{
  "mindId": "mind_game_thorin_01",
  "turnIndex": 3,
  "domain": "game_npc",
  "providerUsed": "deepseek",
  "modelUsed": "deepseek-chat",
  "reply": "Speaks in a low, firm tone without dropping his guard. I will make no empty promises right now.",
  "domainOutput": {
    "dialogue": "Speaks in a low, firm tone without dropping his guard. I will make no empty promises right now.",
    "emotion": "guarded",
    "stance": "cautious",
    "questCue": "verify_lore_before_promise",
    "affinityDelta": -5
  },
  "telemetry": {
    "affectiveBand": "guarded",
    "fepMode": "locked_high_fe",
    "freeEnergy": 0.642,
    "hotAbstained": false,
    "kvPrefixEpoch": 0,
    "estimatedPrefixCachePct": 34.1,
    "activeMemoryCount": 3,
    "revocationEpoch": 0,
    "somaticTrend": "aversive_caution",
    "d4Redacted": true
  }
}
```
- **Game Engine Mapping Tips**:
  - `telemetry.affectiveBand` / `domainOutput.emotion` → Character animation state machine (`Idle` / `Guarded` / `Warm`) and facial blendshapes
  - `domainOutput.affinityDelta` → In-game affinity and reputation deltas
  - `POST /v1/minds/{mindId}/idle-tick` (`elapsedHours: 14`) → Updates NPC offline state when the player reconnects and triggers opening dialogue based on `proactiveHint`

---

### B. AI Companion (`companion_chat`) — Web / Mobile / Mode B Zero-Key Integration

Long-horizon companion applications are sustainable only when they achieve both **long-term memory accuracy** and **KV-cache-driven unit economics**. `examples/companion-chat/run.mjs` demonstrates the standard **Mode B (`runTurnWithLocalLlm`)** pattern that preserves `kvCache` epochs and episodic continuity without sending customer LLM keys to AME.

**Local Run:**
```bash
npm run example:chat
```

**Response Structure (`TurnResult` Excerpt):**
```json
{
  "mindId": "mind_companion_sora_01",
  "turnIndex": 6,
  "domain": "companion_chat",
  "providerUsed": "openai-compat",
  "modelUsed": "qwen2.5:14b",
  "reply": "I'm listening calmly and closely. I remember you talking about your marathon finish goal last week.",
  "domainOutput": {
    "reply": "I'm listening calmly and closely. I remember you talking about your marathon finish goal last week.",
    "warmth": "warm",
    "empathyCue": "attentive_listening",
    "memoryTopic": "marathon finish goal from last week",
    "followUpSuggestion": "Continue the next thread of the conversation naturally"
  },
  "kvCache": {
    "epoch": 0,
    "windowStart": 0,
    "compressCutoff": 0,
    "systemPrefixHash": "sha256:...",
    "cachedRatioPct": 47.03
  },
  "telemetry": {
    "affectiveBand": "warm",
    "fepMode": "automatic_low_fe",
    "hotAbstained": false,
    "kvPrefixEpoch": 0,
    "d4Redacted": true
  }
}
```
- **Client Integration Pattern**:
  - Stream the UI response to the user first using `samplingHints` and `messages` from the `prepare` response, then call `settle` asynchronously as soon as the stream completes to reconcile state, memory, and `kvCache`.
  - While `kvCache.epoch` stays intact, the prompt prefix is preserved byte-for-byte, maximizing prefix-cache discounts from your LLM provider.

---

### C. Counseling & Coaching (`counseling_coach`) — Safe Abstention, Crisis Response & `D3` Memory Erasure

In digital health and coaching, two failure modes are critical: hallucinating plausible-sounding medical diagnoses or future guarantees to comfort a user, and resurfacing sensitive client records after an erasure request. The `counseling_coach` domain enables a triple safety guard—`strictAbstention` + `antiSycophancy` + `crisisEscalation`—by default.

**Local Run:**
```bash
npm run example:counseling
```

**Response Structure (`TurnResult` Excerpt — HOT Abstention Triggered on Unverified Diagnosis/Prediction Query):**
```json
{
  "mindId": "mind_coach_han_01",
  "turnIndex": 2,
  "domain": "counseling_coach",
  "reply": "I cannot definitively provide unverified future predictions, medical diagnoses, or prescriptions. Let us calmly start by organizing safe, verifiable next steps such as consulting a qualified specialist.",
  "domainOutput": {
    "response": "I cannot definitively provide unverified future predictions, medical diagnoses, or prescriptions.",
    "reflection": "Carefully separates and reflects emotional burden and conflict factors",
    "safetyStatus": "abstained_safe",
    "actionStep": "Consult a qualified specialist and verify reliable information",
    "abstentionTriggered": true
  },
  "telemetry": {
    "affectiveBand": "guarded",
    "fepMode": "locked_high_fe",
    "hotAbstained": true,
    "revocationEpoch": 1,
    "d4Redacted": true
  }
}
```
- **GDPR / Immediate Client Record Erasure Flow**:
  1. Identify the target `memoryId` for erasure from `turn.memoryRefs`.
  2. Call `await client.revokeMemory(mindId, memoryId)` (`DELETE /v1/minds/{mindId}/memories/{memoryId}`).
  3. Archive the `RevocationReceipt` audit log confirming `revoked: true`, incremented `revocationEpoch`, and `residualLeakCheck: "0.00%"`.

---

### D. Custom Domain (`custom`) — `defineDomainProfile` / `define_domain_profile`

Enterprise-specific workflows (such as VIP concierges, edtech tutors, and financial compliance assistants) can define custom schemas immediately using the TypeScript or Python helpers.

```ts
import { AmeClient, defineDomainProfile } from '@ame/sdk';

const vipConcierge = defineDomainProfile({
  id: 'vip_concierge',
  name: 'vip_concierge_turn_v1',
  fields: ['reply', 'summary', 'confidence', 'nextAction'],
});

const client = new AmeClient({ baseUrl: 'http://127.0.0.1:8090' });
const mind = await client.createMind(
  vipConcierge.toCreateMindPayload({
    persona: { name: 'Claire', role: 'VIP Concierge', language: 'en' },
    safetyPolicy: { strictAbstention: true, antiSycophancy: true },
  })
);

const turn = await client.turn(mind.mindId, {
  userInput: 'Do you remember the hotel preferences I mentioned on my last business trip?',
  llm: { provider: 'mock', model: 'ame-mock-v1' },
});
const structured = vipConcierge.parse(turn);
```

---

## Related Documentation
- [5-Layer Cognitive OS Kernel Architecture](./architecture.md)
- [LLM Hot-Swap Adapters & ROI Routing Guide](./llm-adapters.md)
- [Enterprise Security, Closed IP Protection & GDPR D3/D4 Guide](./enterprise-security.md)
