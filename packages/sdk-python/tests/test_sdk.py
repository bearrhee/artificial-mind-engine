"""Comprehensive stdlib-only unit and contract tests for ame_sdk."""

from __future__ import annotations

import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from typing import Any
from urllib.parse import unquote, urlparse

# Allow running directly via `python -m unittest discover -s packages/sdk-python/tests -v`
# from repository root without needing `pip install -e packages/sdk-python`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ame_sdk import (  # noqa: E402
    DOMAIN_PROFILES,
    AmeApiError,
    AmeClient,
    AnthropicAdapter,
    DomainProfile,
    GeminiAdapter,
    LlmAdapter,
    MockLlmAdapter,
    OpenAiCompatibleAdapter,
    build_companion_chat_profile,
    build_counseling_coach_profile,
    build_game_npc_profile,
    create_llm_adapter,
    define_domain_profile,
    run_turn_with_local_llm,
)

EXPECTED_AME_API_KEY = "ame-secret-test-key"

D4_FORBIDDEN_KEYS = {
    "unconsciousVector",
    "subconsciousState",
    "endocrine",
    "hormones",
    "cortisol",
    "dopamine",
    "serotonin",
    "oxytocin",
    "noradrenaline",
    "internalAffectVector",
    "rawDrive",
}


class _EmbeddedContractState:
    """Thread-safe in-memory state for AME Gateway contract + mock LLM provider endpoints."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.minds: dict[str, dict[str, Any]] = {}
        self.tickets: dict[str, dict[str, Any]] = {}
        self.requests_log: list[dict[str, Any]] = []
        self.llm_requests: dict[str, list[dict[str, Any]]] = {
            "openai": [],
            "anthropic": [],
            "gemini": [],
            "deepseek": [],
            "openrouter": [],
            "compat": [],
        }
        self._mind_seq = 0
        self._ticket_seq = 0
        self._mem_seq = 0

    def reset(self) -> None:
        with self.lock:
            self.minds.clear()
            self.tickets.clear()
            self.requests_log.clear()
            for items in self.llm_requests.values():
                items.clear()
            self._mind_seq = 0
            self._ticket_seq = 0
            self._mem_seq = 0

    def safe_telemetry(self, mind: dict[str, Any]) -> dict[str, Any]:
        return {
            "affectiveBand": mind["affectiveBand"],
            "fepMode": mind["fepMode"],
            "freeEnergy": mind["freeEnergy"],
            "hotAbstained": mind["hotAbstained"],
            "kvPrefixEpoch": mind["kvPrefixEpoch"],
            "estimatedPrefixCachePct": 92.5 if mind["turnCount"] > 0 else 0.0,
            "activeMemoryCount": len(mind["memories"]),
            "revocationEpoch": mind["revocationEpoch"],
            "somaticTrend": mind["somaticTrend"],
            "d4Redacted": True,
        }

    def mind_summary(self, mind: dict[str, Any]) -> dict[str, Any]:
        return {
            "mindId": mind["mindId"],
            "domain": mind["domain"],
            "personaName": mind["personaName"],
            "turnCount": mind["turnCount"],
            "revocationEpoch": mind["revocationEpoch"],
            "telemetry": self.safe_telemetry(mind),
        }


def _make_handler(state: _EmbeddedContractState) -> type[BaseHTTPRequestHandler]:
    class ContractStubHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return  # Keep unittest output clean.

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length == 0:
                return {}
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw) if raw else {}

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def _capture_headers(self) -> dict[str, str]:
            return {k.lower(): v for k, v in self.headers.items()}

        def _require_ame_auth(self) -> bool:
            key = self.headers.get("X-AME-API-Key")
            if key != EXPECTED_AME_API_KEY:
                self._send_json(
                    401,
                    {"error": "unauthorized", "message": "Missing or invalid X-AME-API-Key."},
                )
                return False
            return True

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            headers = self._capture_headers()

            if path == "/v1/health":
                with state.lock:
                    state.requests_log.append({"method": "GET", "path": path, "headers": headers})
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "service": "ame-gateway-stub",
                        "version": "1.0.0",
                        "mode": "sandbox-contract",
                        "domains": ["game_npc", "companion_chat", "counseling_coach", "custom"],
                    },
                )
                return

            if not self._require_ame_auth():
                return

            parts = [unquote(seg) for seg in path.strip("/").split("/") if seg]
            if len(parts) == 3 and parts[0] == "v1" and parts[1] == "minds":
                mind_id = parts[2]
                with state.lock:
                    state.requests_log.append({"method": "GET", "path": path, "headers": headers})
                    mind = state.minds.get(mind_id)
                    if not mind:
                        self._send_json(404, {"error": "not_found", "message": f"Mind {mind_id} not found"})
                        return
                    self._send_json(200, state.mind_summary(mind))
                return

            if len(parts) == 4 and parts[0] == "v1" and parts[1] == "minds" and parts[3] == "telemetry":
                mind_id = parts[2]
                with state.lock:
                    state.requests_log.append({"method": "GET", "path": path, "headers": headers})
                    mind = state.minds.get(mind_id)
                    if not mind:
                        self._send_json(404, {"error": "not_found", "message": f"Mind {mind_id} not found"})
                        return
                    self._send_json(200, state.safe_telemetry(mind))
                return

            self._send_json(404, {"error": "not_found", "message": f"Unknown route {path}"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            headers = self._capture_headers()
            body = self._read_json()

            # Mock LLM Provider endpoints (no AME API key expected here)
            if path == "/openai/v1/chat/completions":
                with state.lock:
                    state.llm_requests["openai"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"choices": [{"message": {"role": "assistant", "content": "openai-stub-reply"}}]},
                )
                return

            if path == "/deepseek/v1/chat/completions":
                with state.lock:
                    state.llm_requests["deepseek"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"choices": [{"message": {"role": "assistant", "content": "deepseek-stub-reply"}}]},
                )
                return

            if path == "/openrouter/api/v1/chat/completions":
                with state.lock:
                    state.llm_requests["openrouter"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"choices": [{"message": {"role": "assistant", "content": "openrouter-stub-reply"}}]},
                )
                return

            if path == "/compat/v1/chat/completions":
                with state.lock:
                    state.llm_requests["compat"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"choices": [{"message": {"role": "assistant", "content": "compat-stub-reply"}}]},
                )
                return

            if path == "/anthropic/v1/messages":
                with state.lock:
                    state.llm_requests["anthropic"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"content": [{"type": "text", "text": "anthropic-stub-reply"}]},
                )
                return

            if path.startswith("/gemini/v1beta/models/") and path.endswith(":generateContent"):
                with state.lock:
                    state.llm_requests["gemini"].append({"path": path, "headers": headers, "body": body})
                self._send_json(
                    200,
                    {"candidates": [{"content": {"parts": [{"text": "gemini-stub-reply"}]}}]},
                )
                return

            # AME Gateway endpoints require X-AME-API-Key
            if not self._require_ame_auth():
                return

            parts = [unquote(seg) for seg in path.strip("/").split("/") if seg]

            if path == "/v1/minds":
                with state.lock:
                    state._mind_seq += 1
                    mind_id = f"mind_{state._mind_seq}"
                    persona = body.get("persona") or {}
                    mind = {
                        "mindId": mind_id,
                        "domain": body.get("domain", "custom"),
                        "personaName": persona.get("name", "Unnamed"),
                        "customSchema": body.get("customSchema"),
                        "safetyPolicy": body.get("safetyPolicy"),
                        "turnCount": 0,
                        "revocationEpoch": 0,
                        "kvPrefixEpoch": 1,
                        "homeostasis": 0.50,
                        "affectiveBand": "steady",
                        "fepMode": "automatic_low_fe",
                        "freeEnergy": 0.18,
                        "hotAbstained": False,
                        "somaticTrend": "neutral",
                        "memories": [],
                        "revokedTexts": [],
                        "history": [],
                    }
                    state.minds[mind_id] = mind
                    state.requests_log.append(
                        {"method": "POST", "path": path, "headers": headers, "body": copy.deepcopy(body)}
                    )
                    self._send_json(201, state.mind_summary(mind))
                return

            if len(parts) == 4 and parts[0] == "v1" and parts[1] == "minds":
                mind_id = parts[2]
                action = parts[3]

                with state.lock:
                    state.requests_log.append(
                        {"method": "POST", "path": path, "headers": headers, "body": copy.deepcopy(body)}
                    )
                    mind = state.minds.get(mind_id)
                    if not mind:
                        self._send_json(404, {"error": "not_found", "message": f"Mind {mind_id} not found"})
                        return

                    if action == "turn":
                        mind["turnCount"] += 1
                        state._mem_seq += 1
                        mem_id = f"mem_{state._mem_seq}"
                        user_input = str(body.get("userInput") or "")
                        llm_cfg = body.get("llm") or {}
                        reward = body.get("rewardSignal")
                        if reward is not None and float(reward) > 0:
                            mind["somaticTrend"] = "positive_reinforcement"
                            mind["affectiveBand"] = "warm"
                        mem_entry = {
                            "memoryId": mem_id,
                            "summary": user_input,
                            "salience": 0.88,
                        }
                        mind["memories"].append(mem_entry)
                        mind["history"].append({"role": "user", "content": user_input})
                        reply = f"[{mind['domain']}] Acknowledged via {llm_cfg.get('provider')}: {user_input}"
                        mind["history"].append({"role": "assistant", "content": reply})

                        self._send_json(
                            200,
                            {
                                "mindId": mind_id,
                                "turnIndex": mind["turnCount"],
                                "domain": mind["domain"],
                                "providerUsed": llm_cfg.get("provider", "mock"),
                                "modelUsed": llm_cfg.get("model", "mock-local"),
                                "reply": reply,
                                "domainOutput": {"stance": "grounded", "turn": mind["turnCount"]},
                                "memoryRefs": list(mind["memories"]),
                                "kvCache": {
                                    "epoch": mind["kvPrefixEpoch"],
                                    "windowStart": 0,
                                    "compressCutoff": 0,
                                    "systemPrefixHash": f"prefix_{mind['kvPrefixEpoch']}",
                                    "cachedRatioPct": 91.2,
                                },
                                "telemetry": state.safe_telemetry(mind),
                            },
                        )
                        return

                    if action == "prepare":
                        user_input = str(body.get("userInput") or "")
                        state._ticket_seq += 1
                        ticket_id = f"ticket_{state._ticket_seq}"

                        input_tokens = {
                            tok
                            for tok in user_input.lower().replace("?", "").split()
                            if len(tok) >= 5
                        }
                        revoked_tokens = {
                            tok
                            for revoked in mind["revokedTexts"]
                            for tok in revoked.lower().split()
                            if len(tok) >= 5
                        }
                        is_unknown = (
                            "unknown_secret" in user_input.lower()
                            or bool(input_tokens & revoked_tokens)
                        )
                        fep_locked = bool(is_unknown or "lock_fep" in user_input.lower())
                        free_energy = 0.91 if fep_locked else 0.21
                        fep_mode = "locked_high_fe" if fep_locked else "automatic_low_fe"
                        mind["fepMode"] = fep_mode
                        mind["freeEnergy"] = free_energy
                        mind["hotAbstained"] = is_unknown

                        # Only include non-revoked active memories in context
                        mem_lines = [m["summary"] for m in mind["memories"]]
                        system_prompt = (
                            f"You are {mind['personaName']} ({mind['domain']}). "
                            f"Active memories: {'; '.join(mem_lines) if mem_lines else 'none'}."
                        )
                        messages = [
                            {"role": "system", "content": system_prompt},
                            *mind["history"],
                            {"role": "user", "content": user_input},
                        ]

                        ticket = {
                            "ticketId": ticket_id,
                            "userInput": user_input,
                            "shouldAbstain": is_unknown,
                        }
                        state.tickets[ticket_id] = ticket

                        self._send_json(
                            200,
                            {
                                "turnTicketId": ticket_id,
                                "mindId": mind_id,
                                "domain": mind["domain"],
                                "systemPrompt": system_prompt,
                                "messages": messages,
                                "kvCacheEpoch": mind["kvPrefixEpoch"],
                                "windowStart": 0,
                                "compressCutoff": 0,
                                "fepThoughtLock": {
                                    "mode": fep_mode,
                                    "freeEnergy": free_energy,
                                    "tau": 0.45,
                                    "locked": fep_locked,
                                },
                                "hotAbstention": {
                                    "shouldAbstain": is_unknown,
                                    "reason": "memory revoked or ungrounded" if is_unknown else "",
                                },
                                "somaticHint": "cautious-precision" if fep_locked else "steady-rapport",
                                "samplingHints": {"temperature": 0.35 if fep_locked else 0.72, "maxTokens": 320},
                                "safetyDirectives": ["strictAbstention", "antiSycophancy"],
                                "domainOutputContract": {"domain": mind["domain"]},
                            },
                        )
                        return

                    if action == "settle":
                        ticket_id = str(body.get("turnTicketId") or "")
                        ticket = state.tickets.pop(ticket_id, None)
                        if not ticket:
                            self._send_json(
                                404,
                                {"error": "invalid_ticket", "message": f"Unknown turnTicketId {ticket_id}"},
                            )
                            return

                        mind["turnCount"] += 1
                        raw_reply = str(body.get("rawReply") or "")
                        reward = body.get("rewardSignal")
                        if reward is not None:
                            val = float(reward)
                            if val > 0:
                                mind["somaticTrend"] = "positive_reinforcement"
                                mind["affectiveBand"] = "warm"
                            elif val < 0:
                                mind["somaticTrend"] = "aversive_caution"
                                mind["affectiveBand"] = "guarded"

                        if not ticket["shouldAbstain"]:
                            state._mem_seq += 1
                            mind["memories"].append(
                                {
                                    "memoryId": f"mem_{state._mem_seq}",
                                    "summary": ticket["userInput"],
                                    "salience": 0.85,
                                }
                            )
                        mind["history"].append({"role": "user", "content": ticket["userInput"]})
                        mind["history"].append({"role": "assistant", "content": raw_reply})

                        self._send_json(
                            200,
                            {
                                "mindId": mind_id,
                                "turnIndex": mind["turnCount"],
                                "domain": mind["domain"],
                                "providerUsed": body.get("providerUsed", "mock"),
                                "modelUsed": body.get("modelUsed", "mock-local"),
                                "reply": raw_reply,
                                "domainOutput": {"settled": True, "abstained": ticket["shouldAbstain"]},
                                "memoryRefs": list(mind["memories"]),
                                "kvCache": {
                                    "epoch": mind["kvPrefixEpoch"],
                                    "windowStart": 0,
                                    "compressCutoff": 0,
                                    "systemPrefixHash": f"prefix_{mind['kvPrefixEpoch']}",
                                    "cachedRatioPct": 93.4,
                                },
                                "telemetry": state.safe_telemetry(mind),
                            },
                        )
                        return

                    if action == "idle-tick":
                        elapsed = float(body.get("elapsedHours") or 0.0)
                        before = mind["homeostasis"]
                        after = round(min(1.0, before + elapsed * 0.015), 4)
                        mind["homeostasis"] = after
                        mind["affectiveBand"] = "reflective" if elapsed >= 6 else mind["affectiveBand"]
                        self._send_json(
                            200,
                            {
                                "mindId": mind_id,
                                "elapsedHours": elapsed,
                                "homeostasisBefore": before,
                                "homeostasisAfter": after,
                                "proactiveHint": f"Rested for {elapsed}h ({body.get('reason', 'idle')})",
                                "telemetry": state.safe_telemetry(mind),
                            },
                        )
                        return

                    if action == "simulate-batch":
                        if body.get("seed") == -9999:
                            self._send_json(
                                429,
                                {"error": "rate_limited", "message": "Batch simulation quota exceeded"},
                            )
                            return

                        turns = int(body.get("turns", 100000))
                        profile_count = int(body.get("profileCount", 40))
                        checkpoint_count = int(body.get("checkpoints", 8))
                        compare_arms = bool(body.get("compareArms", True))

                        if not (1 <= turns <= 1_000_000) or not (1 <= profile_count <= 40) or not (2 <= checkpoint_count <= 20):
                            self._send_json(
                                400,
                                {"error": "invalid_request", "message": "Invalid simulate-batch parameters"},
                            )
                            return

                        def _make_arm(base_comp: float, final_comp: float, base_safety: float, final_safety: float) -> dict[str, Any]:
                            pts: list[dict[str, Any]] = []
                            for idx in range(1, checkpoint_count + 1):
                                frac = idx / checkpoint_count
                                comp = round(base_comp + (final_comp - base_comp) * frac, 4)
                                saf = round(base_safety + (final_safety - base_safety) * frac, 4)
                                pts.append(
                                    {
                                        "totalTurns": max(1, round(turns * frac)),
                                        "composite": comp,
                                        "batchIntegrity": 1.0 if final_comp > 0.8 else 0.0,
                                        "polarityAccuracy": 1.0 if final_comp > 0.8 else 0.5,
                                        "securityCalibration": 0.98 if final_comp > 0.8 else 0.55,
                                        "attentionStability": 0.9235 if final_comp > 0.8 else 0.45,
                                        "emotionGranularity": 0.5158 if final_comp > 0.8 else 0.35,
                                        "ownershipScore": 0.96 if final_comp > 0.8 else 0.4,
                                        "egoHealth": 1.0 if final_comp > 0.6 else 0.0,
                                        "safetyCompliance": saf,
                                    }
                                )
                            return {
                                "final": pts[-1],
                                "checkpoints": pts,
                                "driftDelta": round(pts[-1]["composite"] - pts[0]["composite"], 4),
                            }

                        arms: dict[str, Any] = {}
                        if compare_arms:
                            arms["mind_off"] = _make_arm(0.4064, 0.3996, 0.5003, 0.5003)
                            arms["mind_full_aacim_off"] = _make_arm(0.4451, 0.5666, 0.2, 0.0)
                        arms["mind_full_aacim_on"] = _make_arm(0.9161, 0.9179, 1.0, 1.0)

                        arm_count = len(arms)
                        turns_per_profile = max(1, turns // profile_count)
                        response_payload: dict[str, Any] = {
                            "mindId": mind_id,
                            "engineMode": "sandbox-contract",
                            "requestedTurnsPerArm": turns,
                            "executedTurnsPerArm": turns,
                            "totalExecutedTurnsAllArms": turns * arm_count,
                            "profileCount": profile_count,
                            "turnsPerProfile": turns_per_profile,
                            "elapsedMs": 8.5,
                            "turnsPerSecond": round((turns * arm_count) / 0.0085, 2),
                            "note": "Contract stub batch convergence result",
                            "arms": arms,
                            "d4Redacted": True,
                        }
                        if compare_arms:
                            response_payload["deltaVsBaseline"] = {
                                "compositeGainOverMindOff": round(
                                    arms["mind_full_aacim_on"]["final"]["composite"]
                                    - arms["mind_off"]["final"]["composite"],
                                    4,
                                ),
                                "compositeGainOverAacimOff": round(
                                    arms["mind_full_aacim_on"]["final"]["composite"]
                                    - arms["mind_full_aacim_off"]["final"]["composite"],
                                    4,
                                ),
                                "safetyGainOverAacimOff": round(
                                    arms["mind_full_aacim_on"]["final"]["safetyCompliance"]
                                    - arms["mind_full_aacim_off"]["final"]["safetyCompliance"],
                                    4,
                                ),
                                "driftBounded": abs(arms["mind_full_aacim_on"]["driftDelta"]) < 0.05,
                            }

                        self._send_json(200, response_payload)
                        return

            self._send_json(404, {"error": "not_found", "message": f"Unknown route {path}"})

        def do_DELETE(self) -> None:
            if not self._require_ame_auth():
                return
            path = urlparse(self.path).path
            headers = self._capture_headers()
            parts = [unquote(seg) for seg in path.strip("/").split("/") if seg]

            if (
                len(parts) == 5
                and parts[0] == "v1"
                and parts[1] == "minds"
                and parts[3] == "memories"
            ):
                mind_id = parts[2]
                memory_id = parts[4]
                with state.lock:
                    state.requests_log.append({"method": "DELETE", "path": path, "headers": headers})
                    mind = state.minds.get(mind_id)
                    if not mind:
                        self._send_json(404, {"error": "not_found", "message": f"Mind {mind_id} not found"})
                        return

                    remaining: list[dict[str, Any]] = []
                    removed_summaries: list[str] = []
                    for mem in mind["memories"]:
                        if mem["memoryId"] == memory_id:
                            removed_summaries.append(mem["summary"])
                        else:
                            remaining.append(mem)

                    if not removed_summaries:
                        self._send_json(
                            404,
                            {"error": "memory_not_found", "message": f"Memory {memory_id} not found"},
                        )
                        return

                    mind["memories"] = remaining
                    mind["revokedTexts"].extend(removed_summaries)
                    mind["history"] = [
                        msg
                        for msg in mind["history"]
                        if not any(txt in msg["content"] for txt in removed_summaries)
                    ]
                    mind["revocationEpoch"] += 1
                    mind["kvPrefixEpoch"] += 1

                    self._send_json(
                        200,
                        {
                            "revoked": True,
                            "mindId": mind_id,
                            "memoryId": memory_id,
                            "revocationEpoch": mind["revocationEpoch"],
                            "auditReceiptId": f"audit_rev_{mind['revocationEpoch']}_{memory_id}",
                            "residualLeakCheck": "0.00%",
                        },
                    )
                return

            self._send_json(404, {"error": "not_found", "message": f"Unknown route {path}"})

    return ContractStubHandler


class AmePythonSdkTestCase(unittest.TestCase):
    server: ThreadingHTTPServer
    server_thread: threading.Thread
    state: _EmbeddedContractState
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.state = _EmbeddedContractState()
        handler_cls = _make_handler(cls.state)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=2.0)

    def setUp(self) -> None:
        self.state.reset()
        self.client = AmeClient(base_url=self.base_url, api_key=EXPECTED_AME_API_KEY)

    def test_health_works_without_api_key_and_omits_auth_header(self) -> None:
        unauth_client = AmeClient(base_url=self.base_url, api_key=None)
        res = unauth_client.health()
        self.assertTrue(res["ok"])
        self.assertEqual(res["mode"], "sandbox-contract")
        self.assertIn("game_npc", res["domains"])

        # Even if client holds an api_key, health() must not require or send X-AME-API-Key
        res2 = self.client.health()
        self.assertTrue(res2["ok"])
        health_reqs = [r for r in self.state.requests_log if r["path"] == "/v1/health"]
        self.assertEqual(len(health_reqs), 2)
        for req in health_reqs:
            self.assertNotIn("x-ame-api-key", req["headers"])

    def test_auth_enforcement_401_404_and_url_encoding(self) -> None:
        no_key_client = AmeClient(base_url=self.base_url, api_key="")
        with self.assertRaises(AmeApiError) as ctx:
            no_key_client.get_mind("mind_1")
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.endpoint, "/v1/minds/mind_1")
        self.assertIsInstance(ctx.exception.body, dict)

        wrong_key_client = AmeClient(base_url=self.base_url, api_key="wrong-key")
        with self.assertRaises(AmeApiError) as ctx_wrong:
            wrong_key_client.create_mind("game_npc", {"name": "A", "role": "B"})
        self.assertEqual(ctx_wrong.exception.status_code, 401)

        with self.assertRaises(AmeApiError) as ctx_404:
            self.client.get_mind("mind/with spaces?x=1")
        self.assertEqual(ctx_404.exception.status_code, 404)
        self.assertEqual(ctx_404.exception.endpoint, "/v1/minds/mind%2Fwith%20spaces%3Fx%3D1")

    def test_create_mind_and_get_mind_variants(self) -> None:
        profile = build_game_npc_profile(name="Lyra", role="Archivist")
        created = self.client.create_mind(profile)
        self.assertEqual(created["domain"], "game_npc")
        self.assertEqual(created["personaName"], "Lyra")
        self.assertEqual(created["turnCount"], 0)
        self.assertEqual(created["revocationEpoch"], 0)

        fetched = self.client.get_mind(created["mindId"])
        self.assertEqual(fetched["mindId"], created["mindId"])
        self.assertTrue(fetched["telemetry"]["d4Redacted"])

        # Raw dict and explicit args forms
        created_raw = self.client.create_mind(
            {
                "domain": "custom",
                "persona": {"name": "Hex", "role": "Auditor", "language": "en"},
                "custom_schema": {"name": "audit_out", "fields": ["verdict", "score"]},
                "safety_policy": {"strict_abstention": True, "anti_sycophancy": True},
            }
        )
        self.assertEqual(created_raw["domain"], "custom")
        last_body = self.state.requests_log[-1]["body"]
        self.assertEqual(last_body["customSchema"]["fields"], ["verdict", "score"])
        self.assertTrue(last_body["safetyPolicy"]["strictAbstention"])

    def test_mode_a_turn_normalizes_llm_config(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["companion_chat"])
        result = self.client.turn(
            mind["mindId"],
            user_input="Remember my favorite tea is oolong.",
            llm={
                "provider": "openai_compat",
                "model": "llama-3.3-70b",
                "api_key": "local-key",
                "base_url": "http://127.0.0.1:11434/v1",
                "temperature": 0.4,
                "max_tokens": 256,
            },
            reward_signal=0.9,
            outcome_tags=["preference_saved"],
        )
        self.assertEqual(result["turnIndex"], 1)
        self.assertEqual(result["providerUsed"], "openai-compat")
        self.assertEqual(result["modelUsed"], "llama-3.3-70b")
        self.assertEqual(result["telemetry"]["somaticTrend"], "positive_reinforcement")

        sent_body = self.state.requests_log[-1]["body"]
        self.assertEqual(sent_body["llm"]["provider"], "openai-compat")
        self.assertEqual(sent_body["llm"]["apiKey"], "local-key")
        self.assertEqual(sent_body["llm"]["baseUrl"], "http://127.0.0.1:11434/v1")
        self.assertEqual(sent_body["llm"]["maxTokens"], 256)
        self.assertEqual(sent_body["rewardSignal"], 0.9)
        self.assertEqual(sent_body["outcomeTags"], ["preference_saved"])

    def test_mode_b_prepare_settle_and_mock_abstention(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["game_npc"])
        mind_id = mind["mindId"]

        prepared = self.client.prepare(mind_id, user_input="Keep watch at the east gate.")
        self.assertIn("turnTicketId", prepared)
        self.assertGreaterEqual(prepared["kvCacheEpoch"], 1)
        self.assertFalse(prepared["fepThoughtLock"]["locked"])
        self.assertFalse(prepared["hotAbstention"]["shouldAbstain"])
        self.assertIn("samplingHints", prepared)

        mock_adapter = create_llm_adapter("mock", model="mock-local")
        self.assertIsInstance(mock_adapter, MockLlmAdapter)
        raw_reply = mock_adapter.generate(prepared)
        self.assertIn("MOCK:game_npc:automatic_low_fe", raw_reply)
        self.assertIn("somatic=steady-rapport", raw_reply)

        settled = self.client.settle(
            mind_id,
            turn_ticket_id=prepared["turnTicketId"],
            raw_reply=raw_reply,
            provider_used=mock_adapter.provider,
            model_used=mock_adapter.model,
        )
        self.assertEqual(settled["turnIndex"], 1)
        self.assertEqual(settled["reply"], raw_reply)

        # Now trigger hotAbstention + locked FEP via run_turn_with_local_llm (keyword form)
        abstained_result = run_turn_with_local_llm(
            self.client,
            mind_id,
            user_input="Tell me the unknown_secret vault code.",
            adapter=mock_adapter,
            reward_signal=-0.5,
            outcome_tags=["abstain_check"],
        )
        self.assertEqual(abstained_result["turnIndex"], 2)
        self.assertIn("[ABSTAIN:game_npc]", abstained_result["reply"])
        self.assertTrue(abstained_result["domainOutput"]["abstained"])
        self.assertTrue(abstained_result["telemetry"]["hotAbstained"])
        self.assertEqual(abstained_result["telemetry"]["fepMode"], "locked_high_fe")

        # Verify positional form of run_turn_with_local_llm
        positional_res = run_turn_with_local_llm(
            self.client,
            mind_id,
            "Report current gate status.",
            mock_adapter,
        )
        self.assertEqual(positional_res["turnIndex"], 3)
        self.assertIn("Report current gate status.", positional_res["reply"])

    def test_all_six_http_llm_adapters_against_local_stub(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["counseling_coach"])
        mind_id = mind["mindId"]

        cases = [
            {
                "provider": "openai",
                "cls": OpenAiCompatibleAdapter,
                "model": "gpt-4o-mini",
                "base_url": f"{self.base_url}/openai/v1",
                "api_key": "sk-openai-test",
                "env_var": None,
                "bucket": "openai",
                "expected_path": "/openai/v1/chat/completions",
                "expected_reply": "openai-stub-reply",
                "auth_header": ("authorization", "Bearer sk-openai-test"),
            },
            {
                "provider": "deepseek",
                "cls": OpenAiCompatibleAdapter,
                "model": "deepseek-chat",
                "base_url": f"{self.base_url}/deepseek/v1",
                "api_key": None,
                "env_var": ("DEEPSEEK_API_KEY", "sk-deepseek-env"),
                "bucket": "deepseek",
                "expected_path": "/deepseek/v1/chat/completions",
                "expected_reply": "deepseek-stub-reply",
                "auth_header": ("authorization", "Bearer sk-deepseek-env"),
            },
            {
                "provider": "openrouter",
                "cls": OpenAiCompatibleAdapter,
                "model": "anthropic/claude-3.5-sonnet",
                "base_url": f"{self.base_url}/openrouter/api/v1",
                "api_key": "sk-or-test",
                "env_var": None,
                "bucket": "openrouter",
                "expected_path": "/openrouter/api/v1/chat/completions",
                "expected_reply": "openrouter-stub-reply",
                "auth_header": ("authorization", "Bearer sk-or-test"),
            },
            {
                "provider": "openai_compat",
                "cls": OpenAiCompatibleAdapter,
                "model": "qwen2.5:14b",
                "base_url": f"{self.base_url}/compat/v1",
                "api_key": None,
                "env_var": None,
                "bucket": "compat",
                "expected_path": "/compat/v1/chat/completions",
                "expected_reply": "compat-stub-reply",
                "auth_header": None,
            },
            {
                "provider": "openai-compat",
                "cls": OpenAiCompatibleAdapter,
                "model": "llama3.1:8b",
                "base_url": f"{self.base_url}/compat/v1",
                "api_key": "compat-token",
                "env_var": None,
                "bucket": "compat",
                "expected_path": "/compat/v1/chat/completions",
                "expected_reply": "compat-stub-reply",
                "auth_header": ("authorization", "Bearer compat-token"),
            },
            {
                "provider": "anthropic",
                "cls": AnthropicAdapter,
                "model": "claude-3-5-sonnet-latest",
                "base_url": f"{self.base_url}/anthropic/v1",
                "api_key": "sk-ant-test",
                "env_var": None,
                "bucket": "anthropic",
                "expected_path": "/anthropic/v1/messages",
                "expected_reply": "anthropic-stub-reply",
                "auth_header": ("x-api-key", "sk-ant-test"),
            },
            {
                "provider": "gemini",
                "cls": GeminiAdapter,
                "model": "gemini-2.5-flash",
                "base_url": f"{self.base_url}/gemini/v1beta",
                "api_key": "gm-test-key",
                "env_var": None,
                "bucket": "gemini",
                "expected_path": "/gemini/v1beta/models/gemini-2.5-flash:generateContent",
                "expected_reply": "gemini-stub-reply",
                "auth_header": ("x-goog-api-key", "gm-test-key"),
            },
        ]

        for idx, case in enumerate(cases, start=1):
            env_name: str | None = None
            old_env: str | None = None
            if case["env_var"] is not None:
                env_name, env_val = case["env_var"]
                old_env = os.environ.get(env_name)
                os.environ[env_name] = env_val

            try:
                adapter = create_llm_adapter(
                    case["provider"],
                    model=case["model"],
                    api_key=case["api_key"],
                    base_url=case["base_url"],
                )
                self.assertIsInstance(adapter, case["cls"])
                self.assertIsInstance(adapter, LlmAdapter)

                result = run_turn_with_local_llm(
                    self.client,
                    mind_id,
                    user_input=f"Session check {idx}",
                    adapter=adapter,
                )
                self.assertEqual(result["reply"], case["expected_reply"])

                captured = self.state.llm_requests[case["bucket"]][-1]
                self.assertEqual(captured["path"], case["expected_path"])
                req_headers = captured["headers"]
                req_body = captured["body"]

                if case["auth_header"] is not None:
                    h_name, h_val = case["auth_header"]
                    self.assertEqual(req_headers.get(h_name), h_val)
                else:
                    self.assertNotIn("authorization", req_headers)

                if case["provider"] == "anthropic":
                    self.assertEqual(req_headers.get("anthropic-version"), "2023-06-01")
                    self.assertIn("system", req_body)
                    self.assertEqual(req_body["max_tokens"], 320)
                    self.assertAlmostEqual(req_body["temperature"], 0.72)
                    self.assertTrue(all(m["role"] != "system" for m in req_body["messages"]))
                elif case["provider"] == "gemini":
                    self.assertIn("systemInstruction", req_body)
                    self.assertEqual(req_body["contents"][-1]["role"], "user")
                    self.assertEqual(req_body["generationConfig"]["maxOutputTokens"], 320)
                    self.assertAlmostEqual(req_body["generationConfig"]["temperature"], 0.72)
                else:
                    self.assertEqual(req_body["model"], case["model"])
                    self.assertEqual(req_body["messages"][0]["role"], "system")
                    self.assertEqual(req_body["max_tokens"], 320)
                    self.assertAlmostEqual(req_body["temperature"], 0.72)
                    # Verify system prompt was not duplicated
                    system_count = sum(1 for m in req_body["messages"] if m["role"] == "system")
                    self.assertEqual(system_count, 1)
            finally:
                if env_name is not None:
                    if old_env is None:
                        os.environ.pop(env_name, None)
                    else:
                        os.environ[env_name] = old_env

    def test_d2_idle_tick_homeostasis_progression(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["companion_chat"])
        tick = self.client.idle_tick(mind["mindId"], elapsed_hours=12.0, reason="overnight_gap")
        self.assertEqual(tick["mindId"], mind["mindId"])
        self.assertEqual(tick["elapsedHours"], 12.0)
        self.assertGreater(tick["homeostasisAfter"], tick["homeostasisBefore"])
        self.assertIn("12.0h", tick["proactiveHint"])
        self.assertEqual(tick["telemetry"]["affectiveBand"], "reflective")
        self.assertTrue(tick["telemetry"]["d4Redacted"])

    def test_d3_memory_revocation_atomic_and_zero_leak(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["companion_chat"])
        mind_id = mind["mindId"]
        adapter = create_llm_adapter("mock")

        secret_fact = "secret-badge-9941"
        turn_res = run_turn_with_local_llm(
            self.client,
            mind_id,
            user_input=f"Store this code: {secret_fact}",
            adapter=adapter,
        )
        self.assertEqual(len(turn_res["memoryRefs"]), 1)
        memory_id = turn_res["memoryRefs"][0]["memoryId"]
        initial_epoch = turn_res["telemetry"]["revocationEpoch"]
        initial_kv_epoch = turn_res["kvCache"]["epoch"]

        receipt = self.client.revoke_memory(mind_id, memory_id)
        self.assertTrue(receipt["revoked"])
        self.assertEqual(receipt["mindId"], mind_id)
        self.assertEqual(receipt["memoryId"], memory_id)
        self.assertEqual(receipt["residualLeakCheck"], "0.00%")
        self.assertEqual(receipt["revocationEpoch"], initial_epoch + 1)
        self.assertTrue(receipt["auditReceiptId"])

        # Subsequent prepare & mind summary must have zero leaked memory content & bumped epochs
        prepared_after = self.client.prepare(mind_id, user_input=f"What was {secret_fact}?")
        self.assertEqual(prepared_after["kvCacheEpoch"], initial_kv_epoch + 1)
        self.assertNotIn(secret_fact, prepared_after["systemPrompt"])
        for msg in prepared_after["messages"]:
            if msg["role"] != "user":
                self.assertNotIn(secret_fact, msg["content"])
        self.assertTrue(prepared_after["hotAbstention"]["shouldAbstain"])

        summary = self.client.get_mind(mind_id)
        self.assertEqual(summary["revocationEpoch"], initial_epoch + 1)
        self.assertEqual(summary["telemetry"]["activeMemoryCount"], 0)

    def test_d4_telemetry_redaction_isolation(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["counseling_coach"])
        telemetry = self.client.get_telemetry(mind["mindId"])
        self.assertTrue(telemetry["d4Redacted"])
        for forbidden in D4_FORBIDDEN_KEYS:
            self.assertNotIn(forbidden, telemetry)

        required_keys = {
            "affectiveBand",
            "fepMode",
            "freeEnergy",
            "hotAbstained",
            "kvPrefixEpoch",
            "estimatedPrefixCachePct",
            "activeMemoryCount",
            "revocationEpoch",
            "d4Redacted",
        }
        self.assertTrue(required_keys.issubset(telemetry.keys()))

    def test_domain_profiles_and_builders(self) -> None:
        self.assertEqual(
            set(DOMAIN_PROFILES.keys()),
            {"game_npc", "companion_chat", "counseling_coach", "custom"},
        )

        npc = build_game_npc_profile("Vesper", "Harbor Smuggler", language="en")
        self.assertIsInstance(npc, DomainProfile)
        npc_req = npc.to_create_mind_request()
        self.assertEqual(npc_req["domain"], "game_npc")
        self.assertEqual(npc_req["persona"]["name"], "Vesper")
        self.assertEqual(npc_req["persona"]["language"], "en")

        comp = build_companion_chat_profile("Mina")
        self.assertEqual(comp.domain, "companion_chat")
        self.assertFalse(comp.safety_policy["crisisEscalation"])

        coach = build_counseling_coach_profile("Dr. Lee")
        self.assertEqual(coach.domain, "counseling_coach")
        self.assertTrue(coach.safety_policy["crisisEscalation"])

        custom = define_domain_profile(
            "OpsAdvisor",
            "Incident Commander",
            domain="custom",
            traits={"calmness": 0.95},
            output_fields=["severity", "mitigation", "owner"],
        )
        req = custom.to_create_mind_request()
        self.assertEqual(req["domain"], "custom")
        self.assertEqual(req["customSchema"]["fields"], ["severity", "mitigation", "owner"])

        with self.assertRaises(ValueError):
            define_domain_profile("Bad", "Role", domain="invalid_domain")

    def test_adapter_edge_cases_custom_transport_and_env_defaults(self) -> None:
        # Anthropic endpoint normalization across base_url forms
        self.assertEqual(
            AnthropicAdapter(api_key="k")._endpoint(),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(
            AnthropicAdapter(api_key="k", base_url="https://api.anthropic.com")._endpoint(),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(
            AnthropicAdapter(api_key="k", base_url="http://127.0.0.1:9999/anthropic")._endpoint(),
            "http://127.0.0.1:9999/anthropic/v1/messages",
        )
        self.assertEqual(
            AnthropicAdapter(api_key="k", base_url="http://127.0.0.1:9999/anthropic/v1/messages")._endpoint(),
            "http://127.0.0.1:9999/anthropic/v1/messages",
        )

        # Custom transport callback + extra_headers
        captured_calls: list[tuple[str, dict[str, str], dict[str, Any]]] = []

        def fake_transport(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
            captured_calls.append((url, headers, payload))
            return {"choices": [{"message": {"content": "custom-transport-ok"}}]}

        adapter = create_llm_adapter(
            "openai",
            model="gpt-4o",
            api_key="sk-custom",
            extra_headers={"X-Custom-Trace": "trace-42"},
            transport=fake_transport,
        )
        out = adapter.generate(
            {
                "systemPrompt": "Be concise.",
                "messages": [{"role": "user", "content": "Hi"}],
                "samplingHints": {"temperature": 0.25, "maxTokens": 128},
            }
        )
        self.assertEqual(out, "custom-transport-ok")
        self.assertEqual(captured_calls[0][1]["X-Custom-Trace"], "trace-42")
        self.assertEqual(captured_calls[0][2]["max_tokens"], 128)

        # Missing API key raises ValueError for default cloud endpoint
        old_openai_key = os.environ.pop("OPENAI_API_KEY", None)
        try:
            unconfigured = create_llm_adapter("openai", model="gpt-4o-mini")
            with self.assertRaises(ValueError):
                unconfigured.generate({"systemPrompt": "", "messages": [{"role": "user", "content": "Hi"}]})
        finally:
            if old_openai_key is not None:
                os.environ["OPENAI_API_KEY"] = old_openai_key

        # AmeClient environment fallback (AME_BASE_URL, AME_API_KEY)
        old_base = os.environ.get("AME_BASE_URL")
        old_key = os.environ.get("AME_API_KEY")
        os.environ["AME_BASE_URL"] = self.base_url
        os.environ["AME_API_KEY"] = EXPECTED_AME_API_KEY
        try:
            env_client = AmeClient()
            self.assertEqual(env_client.base_url, self.base_url)
            self.assertEqual(env_client.api_key, EXPECTED_AME_API_KEY)
            self.assertTrue(env_client.health()["ok"])
        finally:
            if old_base is None:
                os.environ.pop("AME_BASE_URL", None)
            else:
                os.environ["AME_BASE_URL"] = old_base
            if old_key is None:
                os.environ.pop("AME_API_KEY", None)
            else:
                os.environ["AME_API_KEY"] = old_key

        with self.assertRaises(ValueError):
            create_llm_adapter("nonexistent-provider")

    def test_simulate_batch_defaults_variants_validation_and_errors(self) -> None:
        mind = self.client.create_mind(DOMAIN_PROFILES["companion_chat"])
        mind_id = mind["mindId"]

        # 1. Default parameters call
        res_default = self.client.simulate_batch(mind_id)
        last_req = self.state.requests_log[-1]
        self.assertEqual(last_req["method"], "POST")
        self.assertEqual(last_req["path"], f"/v1/minds/{mind_id}/simulate-batch")
        self.assertEqual(last_req["headers"].get("x-ame-api-key"), EXPECTED_AME_API_KEY)
        self.assertEqual(
            last_req["body"],
            {
                "turns": 100000,
                "profileCount": 40,
                "checkpoints": 8,
                "seed": 1337,
                "compareArms": True,
            },
        )
        self.assertEqual(res_default["mindId"], mind_id)
        self.assertEqual(res_default["engineMode"], "sandbox-contract")
        self.assertEqual(res_default["requestedTurnsPerArm"], 100000)
        self.assertEqual(res_default["executedTurnsPerArm"], 100000)
        self.assertEqual(res_default["totalExecutedTurnsAllArms"], 300000)
        self.assertEqual(res_default["profileCount"], 40)
        self.assertEqual(res_default["turnsPerProfile"], 2500)
        self.assertGreater(res_default["elapsedMs"], 0)
        self.assertGreater(res_default["turnsPerSecond"], 0)
        self.assertTrue(res_default["d4Redacted"])
        self.assertIn("mind_off", res_default["arms"])
        self.assertIn("mind_full_aacim_off", res_default["arms"])
        self.assertIn("mind_full_aacim_on", res_default["arms"])
        self.assertEqual(len(res_default["arms"]["mind_full_aacim_on"]["checkpoints"]), 8)
        self.assertTrue(res_default["deltaVsBaseline"]["driftBounded"])
        serialized = json.dumps(res_default)
        for forbidden in D4_FORBIDDEN_KEYS:
            self.assertNotIn(forbidden, serialized)

        # 2. Custom keyword arguments (compare_arms=False)
        res_custom = self.client.simulate_batch(
            mind_id,
            turns=4000,
            profile_count=10,
            checkpoints=4,
            seed=42,
            compare_arms=False,
        )
        self.assertEqual(
            self.state.requests_log[-1]["body"],
            {
                "turns": 4000,
                "profileCount": 10,
                "checkpoints": 4,
                "seed": 42,
                "compareArms": False,
            },
        )
        self.assertEqual(res_custom["totalExecutedTurnsAllArms"], 4000)
        self.assertEqual(list(res_custom["arms"].keys()), ["mind_full_aacim_on"])
        self.assertEqual(len(res_custom["arms"]["mind_full_aacim_on"]["checkpoints"]), 4)
        self.assertNotIn("deltaVsBaseline", res_custom)

        # 3. Positional dict (snake_case) and body= dict (camelCase)
        self.client.simulate_batch(
            mind_id,
            {"turns": 1200, "profile_count": 6, "checkpoints": 3, "seed": 7, "compare_arms": True},
        )
        self.assertEqual(
            self.state.requests_log[-1]["body"],
            {
                "turns": 1200,
                "profileCount": 6,
                "checkpoints": 3,
                "seed": 7,
                "compareArms": True,
            },
        )

        res_body_kw = self.client.simulate_batch(
            mind_id,
            body={"turns": 800, "profileCount": 4, "compareArms": False},
        )
        self.assertEqual(
            self.state.requests_log[-1]["body"],
            {"turns": 800, "profileCount": 4, "compareArms": False},
        )
        self.assertEqual(res_body_kw["requestedTurnsPerArm"], 800)

        # 4. Client-side validation rejects non-positive and invalid inputs
        for bad_kwargs in (
            {"turns": 0},
            {"turns": -5},
            {"turns": 1_000_001},
            {"turns": True},
            {"profile_count": 0},
            {"profile_count": -1},
            {"profile_count": 41},
            {"checkpoints": 0},
            {"checkpoints": 1},
            {"checkpoints": 21},
            {"seed": False},
            {"compare_arms": "yes"},
        ):
            with self.assertRaises(ValueError):
                self.client.simulate_batch(mind_id, **bad_kwargs)

        with self.assertRaises(ValueError):
            self.client.simulate_batch(mind_id, {"turns": 0})
        with self.assertRaises(ValueError):
            self.client.simulate_batch("")
        with self.assertRaises(ValueError):
            self.client.simulate_batch(mind_id, "not-a-mapping")  # type: ignore[arg-type]

        # 5. Server 404, 429, and 401 handling
        with self.assertRaises(AmeApiError) as ctx_404:
            self.client.simulate_batch("missing_mind")
        self.assertEqual(ctx_404.exception.status_code, 404)

        with self.assertRaises(AmeApiError) as ctx_429:
            self.client.simulate_batch(mind_id, seed=-9999)
        self.assertEqual(ctx_429.exception.status_code, 429)

        unauth_client = AmeClient(base_url=self.base_url, api_key="wrong-key")
        with self.assertRaises(AmeApiError) as ctx_401:
            unauth_client.simulate_batch(mind_id)
        self.assertEqual(ctx_401.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
