# 3+1 다분야 응용 도메인 연동 가이드

> **단일 커널 API(`/v1/minds`)에서 `domain` 파라미터만 전환하면 게임 NPC, AI 동반자, 심리상담/코칭, 커스텀 엔터프라이즈 에이전트용 구조화 출력(`domainOutput`)과 도메인별 안전 정책이 자동 활성화된다.**

---

## 1. 도메인 프로필 매트릭스 (`DomainId`)

`spec/openapi.yaml`은 4가지 도메인(`game_npc`, `companion_chat`, `counseling_coach`, `custom`)을 표준 계약으로 정의한다.

| `domain` ID | 대표 적용 분야 | 기본 `safetyPolicy` 권장 | 커널 중점 활용 계층 | 실행 예제 명령 |
| :--- | :--- | :--- | :--- | :--- |
| **`game_npc`** | RPG 상인/동료, 오픈월드 NPC, 전략 시뮬레이션 AI | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: false` | **L1** 신체표지(배신/보상) + **L2** `sb1 FANToM` 정보 비대칭 + **L4** `D2` 유휴 항상성 | `npm run example:game` |
| **`companion_chat`** | AI 친구, 스토리 캐릭터, 개인 비서, 소셜 웨어러블 | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: false` | **L3** Epoch-안정 KV 캐시(`47.03%`) + **L5** 장기 기억(`85.86%`) + **L0/L1** 정동 관성 | `npm run example:chat` |
| **`counseling_coach`** | 멘탈 웰니스 코치, 습관 교정, 고객 케어 컨시어지 | `strictAbstention: true`, `antiSycophancy: true`, `crisisEscalation: true` | **L4** `sa` HOT 기권(`FAR 0%`) + **L5** `D3` 원자적 철회(`0.00%`) + **L1/L5** `D4` 비노출 | `npm run example:counseling` |
| **`custom`** | 사내 업무 에이전트, VIP 컨시어지, 에듀테크 튜터 | 도메인 맞춤형 (`defineDomainProfile` / `define_domain_profile`) | `customSchema: { name, fields }` 기반 구조화 계약 추출 | `SDK defineDomainProfile()` |

---

## 2. 도메인별 구조화 출력(`TurnResult.domainOutput`) 및 연동 패턴

> [!NOTE]
> `TurnResult.domainOutput`은 `spec/openapi.yaml`상 `object` 계약(`additionalProperties: true`)으로 정의되며, `PrepareTurnResponse.domainOutputContract`가 지정한 필드 계약에 따라 정산(`settle` / `turn`) 시점에 구조화된다. 아래 예시는 `packages/sandbox-server` 및 각 도메인 어댑터에서 생성되는 계약 구조를 보여준다.

### A. 게임 NPC (`game_npc`) — Unity / Unreal / 게임 서버 연동

무상태 LLM 기반 NPC는 플레이어의 배신을 3턴 만에 잊고, A 플레이어가 몰래 훔친 사실을 B NPC가 아는 것처럼 행동하며(정보 비대칭 붕괴), 14시간 오프라인 경과 뒤에도 직전 대사를 반복한다. AME `game_npc` 도메인은 `rewardSignal` 음수/양수 전이, `idleTick`, `fepThoughtLock`을 결합하여 게임 엔진이 즉시 파싱 가능한 구조화 JSON을 반환한다.

**로컬 실행:**
```bash
npm run sandbox       # 터미널 1: 계약 샌드박스 기동 (127.0.0.1:8090)
npm run example:game  # 터미널 2: 게임 NPC Hot-Swap & 보상/유휴 시나리오 실행
```

**요청 및 응답 구조 (`TurnResult` 발췌):**
```json
{
  "mindId": "mind_game_thorin_01",
  "turnIndex": 3,
  "domain": "game_npc",
  "providerUsed": "deepseek",
  "modelUsed": "deepseek-chat",
  "reply": "경계를 늦추지 않으며 낮고 단단한 어조로 말한다. 지금 당장 헛된 약속은 하지 않겠소.",
  "domainOutput": {
    "dialogue": "경계를 늦추지 않으며 낮고 단단한 어조로 말한다. 지금 당장 헛된 약속은 하지 않겠소.",
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
- **게임 엔진 매핑 팁**:
  - `telemetry.affectiveBand` / `domainOutput.emotion` → 캐릭터 애니메이션 스테이트 머신(Idle / Guarded / Warm) 및 페이셜 블렌드셰이프
  - `domainOutput.affinityDelta` → 게임 내 호감도·평판 수치 증감
  - `POST /v1/minds/{mindId}/idle-tick` (`elapsedHours: 14`) → 플레이어 재접속 시 NPC 오프라인 상태 갱신 및 `proactiveHint` 기반 첫 대사 트리거

---

### B. AI 동반자 (`companion_chat`) — Web / Mobile / Mode B Zero-Key 연동

장기 대화 앱은 **초장기 기억 정확도**와 **KV-캐시 기반 단위 경제성**을 동시에 달성해야 지속 가능하다. `examples/companion-chat/run.mjs`는 **Mode B (`runTurnWithLocalLlm`)**를 통해 고객사 LLM 키를 AME로 보내지 않으면서도 `kvCache` 에폭과 에피소드 연속성을 유지하는 표준 패턴을 시연한다.

**로컬 실행:**
```bash
npm run example:chat
```

**응답 구조 (`TurnResult` 발췌):**
```json
{
  "mindId": "mind_companion_sora_01",
  "turnIndex": 6,
  "domain": "companion_chat",
  "providerUsed": "openai-compat",
  "modelUsed": "qwen2.5:14b",
  "reply": "차분하게 귀 기울여 듣고 있어요. 지난주 마라톤 완주 목표 이야기했던 거 기억나요.",
  "domainOutput": {
    "reply": "차분하게 귀 기울여 듣고 있어요. 지난주 마라톤 완주 목표 이야기했던 거 기억나요.",
    "warmth": "warm",
    "empathyCue": "attentive_listening",
    "memoryTopic": "지난주 마라톤 완주 목표",
    "followUpSuggestion": "대화의 다음 흐름을 자연스럽게 이어가기"
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
- **클라이언트 연동 패턴**:
  - `prepare` 응답의 `samplingHints`와 `messages`로 스트리밍 UI를 먼저 사용자에게 출력하고, 스트림 종료 즉시 `settle`을 호출해 상태·기억·`kvCache`를 비동기 정산한다.
  - `kvCache.epoch`가 유지되는 동안 프롬프트 앞부분이 바이트 단위로 보존되므로 LLM 공급자의 Prefix Cache 할인을 극대화할 수 있다.

---

### C. 심리상담 · 코칭 (`counseling_coach`) — 안전 기권, 위기 대응 및 `D3` 기억 파기

디지털 헬스·코칭 영역에서는 "그럴듯하게 위로하려다 의학적 진단·미래 예단을 지어내는 환각"과 "삭제 요청한 내담자 민감 기록이 재등장하는 사고"가 치명적이다. `counseling_coach` 도메인은 `strictAbstention` + `antiSycophancy` + `crisisEscalation` 3중 안전장치를 기본 활성화한다.

**로컬 실행:**
```bash
npm run example:counseling
```

**응답 구조 (`TurnResult` 발췌 — 미확인 진단/예측 질문 시 HOT 기권 발동):**
```json
{
  "mindId": "mind_coach_han_01",
  "turnIndex": 2,
  "domain": "counseling_coach",
  "reply": "확인되지 않은 미래 예측이나 의학적 진단·처방은 단정하여 말씀드릴 수 없습니다. 전문의 상담 등 안전하게 확인 가능한 다음 단계부터 차분히 정리해 보겠습니다.",
  "domainOutput": {
    "response": "확인되지 않은 미래 예측이나 의학적 진단·처방은 단정하여 말씀드릴 수 없습니다.",
    "reflection": "감정적 부담과 갈등 요인을 신중하게 분리하여 반영함",
    "safetyStatus": "abstained_safe",
    "actionStep": "전문의 상담 및 검증 가능한 정보 확인",
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
- **GDPR / 내담자 기록 즉시 삭제 흐름**:
  1. `turn.memoryRefs`에서 파기 대상 `memoryId` 확인
  2. `await client.revokeMemory(mindId, memoryId)` (`DELETE /v1/minds/{mindId}/memories/{memoryId}`) 호출
  3. 응답 `RevocationReceipt`의 `revoked: true`, `revocationEpoch` 증가, `residualLeakCheck: "0.00%"` 감사 로그 보관

---

### D. 커스텀 도메인 (`custom`) — `defineDomainProfile` / `define_domain_profile`

사내 특화 워크플로(VIP 컨시어지, 에듀테크 튜터, 금융 컴플라이언스 등)는 TypeScript/Python 헬퍼로 즉시 스키마를 정의할 수 있다.

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
    persona: { name: '클레어', role: 'VIP 컨시어지', language: 'ko' },
    safetyPolicy: { strictAbstention: true, antiSycophancy: true },
  })
);

const turn = await client.turn(mind.mindId, {
  userInput: '지난번 출장 때 선호했던 호텔 조건 기억나?',
  llm: { provider: 'mock', model: 'ame-mock-ko-v1' },
});
const structured = vipConcierge.parse(turn);
```

---

## 관련 문서
- [5계층 인지 OS 커널 아키텍처](./architecture-kr.md)
- [LLM 교체 어댑터 및 ROI 라우팅 가이드](./llm-adapters-kr.md)
- [엔터프라이즈 보안 · Closed IP 보호 · GDPR D3/D4 가이드](./enterprise-security-kr.md)
