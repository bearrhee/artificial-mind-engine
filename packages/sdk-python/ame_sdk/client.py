"""Zero-dependency HTTP client for the Artificial Mind Engine (AME) Gateway API."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping, Sequence

from .domains import normalize_custom_schema, normalize_safety_policy

_LLM_KEY_MAP: dict[str, str] = {
    "provider": "provider",
    "model": "model",
    "api_key": "apiKey",
    "apiKey": "apiKey",
    "base_url": "baseUrl",
    "baseUrl": "baseUrl",
    "temperature": "temperature",
    "max_tokens": "maxTokens",
    "maxTokens": "maxTokens",
}

_CREATE_MIND_KEY_MAP: dict[str, str] = {
    "domain": "domain",
    "persona": "persona",
    "custom_schema": "customSchema",
    "customSchema": "customSchema",
    "safety_policy": "safetyPolicy",
    "safetyPolicy": "safetyPolicy",
}

_TURN_KEY_MAP: dict[str, str] = {
    "user_input": "userInput",
    "userInput": "userInput",
    "llm": "llm",
    "reward_signal": "rewardSignal",
    "rewardSignal": "rewardSignal",
    "outcome_tags": "outcomeTags",
    "outcomeTags": "outcomeTags",
    "metadata": "metadata",
}

_PREPARE_KEY_MAP: dict[str, str] = {
    "user_input": "userInput",
    "userInput": "userInput",
    "reward_signal": "rewardSignal",
    "rewardSignal": "rewardSignal",
    "outcome_tags": "outcomeTags",
    "outcomeTags": "outcomeTags",
    "metadata": "metadata",
}

_SETTLE_KEY_MAP: dict[str, str] = {
    "turn_ticket_id": "turnTicketId",
    "turnTicketId": "turnTicketId",
    "raw_reply": "rawReply",
    "rawReply": "rawReply",
    "reward_signal": "rewardSignal",
    "rewardSignal": "rewardSignal",
    "outcome_tags": "outcomeTags",
    "outcomeTags": "outcomeTags",
    "provider_used": "providerUsed",
    "providerUsed": "providerUsed",
    "model_used": "modelUsed",
    "modelUsed": "modelUsed",
}

_IDLE_TICK_KEY_MAP: dict[str, str] = {
    "elapsed_hours": "elapsedHours",
    "elapsedHours": "elapsedHours",
    "reason": "reason",
}


class AmeApiError(Exception):
    """Error raised when the AME Gateway returns a non-2xx HTTP status or transport failure."""

    def __init__(
        self,
        status_code: int,
        message: str,
        body: Any = None,
        endpoint: str = "",
    ) -> None:
        self.status_code = int(status_code)
        self.message = str(message)
        self.body = body
        self.endpoint = str(endpoint)
        detail = (
            f"AME API error {self.status_code} at {self.endpoint}: {self.message}"
            if self.endpoint
            else f"AME API error {self.status_code}: {self.message}"
        )
        super().__init__(detail)


def _encode_path_segment(value: str, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    return urllib.parse.quote(text, safe="")


def _normalize_provider_name(provider: str) -> str:
    cleaned = str(provider).strip().lower()
    if cleaned == "openai_compat":
        return "openai-compat"
    return cleaned


def _normalize_llm_config(llm: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize snake_case LLM config fields to canonical OpenAPI LlmProviderConfig."""
    normalized: dict[str, Any] = {}
    # Process snake_case first so canonical camelCase keys win if both are supplied.
    ordered_items = sorted(llm.items(), key=lambda item: item[0] in _LLM_KEY_MAP and item[0] == _LLM_KEY_MAP[item[0]])
    for raw_key, value in ordered_items:
        if value is None:
            continue
        canonical_key = _LLM_KEY_MAP.get(raw_key, raw_key)
        if canonical_key == "provider":
            normalized[canonical_key] = _normalize_provider_name(str(value))
        else:
            normalized[canonical_key] = value
    return normalized


def _normalize_mapping_keys(data: Mapping[str, Any], key_map: Mapping[str, str]) -> dict[str, Any]:
    """Normalize snake_case keys to OpenAPI camelCase while preferring canonical keys."""
    normalized: dict[str, Any] = {}
    ordered_items = sorted(data.items(), key=lambda item: item[0] == key_map.get(item[0], item[0]))
    for raw_key, value in ordered_items:
        if value is None:
            continue
        canonical_key = key_map.get(raw_key, raw_key)
        normalized[canonical_key] = value
    return normalized


class AmeClient:
    """Synchronous stdlib-only client covering all 9 endpoints of the AME Gateway API."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        resolved_base = base_url or os.environ.get("AME_BASE_URL") or "http://127.0.0.1:8090"
        self.base_url = str(resolved_base).rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("AME_API_KEY")
        self.timeout = float(timeout)

    def __enter__(self) -> AmeClient:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close hook for context-manager symmetry; urllib closes per request."""

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        auth: bool = True,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers: dict[str, str] = {"Accept": "application/json"}
        data: bytes | None = None

        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        if auth and self.api_key:
            headers["X-AME-API-Key"] = self.api_key

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_text = resp.read().decode("utf-8", errors="replace").strip()
                if not raw_text:
                    return {}
                try:
                    parsed = json.loads(raw_text)
                except json.JSONDecodeError as exc:
                    raise AmeApiError(
                        resp.status,
                        "Invalid JSON response from AME Gateway.",
                        body=raw_text,
                        endpoint=path,
                    ) from exc
                if not isinstance(parsed, dict):
                    return {"data": parsed}
                return parsed
        except urllib.error.HTTPError as exc:
            raw_error = exc.read().decode("utf-8", errors="replace").strip()
            parsed_body: Any = raw_error if raw_error else None
            error_message = str(exc.reason or f"HTTP {exc.code}")
            if raw_error:
                try:
                    decoded = json.loads(raw_error)
                    parsed_body = decoded
                    if isinstance(decoded, dict):
                        error_message = str(
                            decoded.get("message")
                            or decoded.get("error")
                            or decoded.get("detail")
                            or error_message
                        )
                except json.JSONDecodeError:
                    error_message = raw_error
            raise AmeApiError(exc.code, error_message, body=parsed_body, endpoint=path) from exc
        except urllib.error.URLError as exc:
            raise AmeApiError(0, f"Transport error: {exc.reason}", body=None, endpoint=path) from exc

    def health(self) -> dict[str, Any]:
        """GET /v1/health — Gateway and sealed kernel health check (no API key required)."""
        return self._request("GET", "/v1/health", auth=False)

    def create_mind(
        self,
        domain: Any = None,
        persona: Mapping[str, Any] | None = None,
        *,
        custom_schema: Mapping[str, Any] | None = None,
        safety_policy: Mapping[str, Any] | None = None,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/minds — Create an isolated persistent Mind instance."""
        if body is not None:
            payload = _normalize_mapping_keys(body, _CREATE_MIND_KEY_MAP)
        elif isinstance(domain, Mapping):
            payload = _normalize_mapping_keys(domain, _CREATE_MIND_KEY_MAP)
        elif hasattr(domain, "to_create_mind_request") and callable(domain.to_create_mind_request):
            payload = dict(domain.to_create_mind_request())
        else:
            if not domain:
                raise ValueError("domain must be provided when creating a Mind.")
            if persona is None:
                raise ValueError("persona must be provided when creating a Mind from a domain string.")
            payload = {
                "domain": str(domain),
                "persona": dict(persona),
            }

        if "customSchema" in payload and isinstance(payload["customSchema"], Mapping):
            payload["customSchema"] = normalize_custom_schema(payload["customSchema"])
        if "safetyPolicy" in payload and isinstance(payload["safetyPolicy"], Mapping):
            payload["safetyPolicy"] = normalize_safety_policy(payload["safetyPolicy"])

        if custom_schema is not None:
            payload["customSchema"] = normalize_custom_schema(custom_schema)
        if safety_policy is not None:
            payload["safetyPolicy"] = normalize_safety_policy(safety_policy)

        return self._request("POST", "/v1/minds", body=payload)

    def get_mind(self, mind_id: str) -> dict[str, Any]:
        """GET /v1/minds/{mindId} — Retrieve Mind metadata and D4-safe telemetry."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")
        return self._request("GET", f"/v1/minds/{encoded_mind}")

    def turn(
        self,
        mind_id: str,
        user_input: Any = None,
        llm: Mapping[str, Any] | None = None,
        *,
        reward_signal: float | None = None,
        outcome_tags: Sequence[str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/minds/{mindId}/turn — Mode A (Proxy BYO-LLM) atomic turn execution."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")

        if body is not None:
            payload = _normalize_mapping_keys(body, _TURN_KEY_MAP)
        elif isinstance(user_input, Mapping):
            payload = _normalize_mapping_keys(user_input, _TURN_KEY_MAP)
        else:
            if user_input is None:
                raise ValueError("user_input is required for client.turn().")
            if llm is None:
                raise ValueError("llm configuration is required for client.turn().")
            payload = {
                "userInput": str(user_input),
                "llm": _normalize_llm_config(llm),
            }

        if "llm" in payload and isinstance(payload["llm"], Mapping):
            payload["llm"] = _normalize_llm_config(payload["llm"])
        if llm is not None and body is not None:
            payload["llm"] = _normalize_llm_config(llm)
        if reward_signal is not None:
            payload["rewardSignal"] = float(reward_signal)
        if outcome_tags is not None:
            payload["outcomeTags"] = [str(tag) for tag in outcome_tags]
        if metadata is not None:
            payload["metadata"] = dict(metadata)

        return self._request("POST", f"/v1/minds/{encoded_mind}/turn", body=payload)

    def prepare(
        self,
        mind_id: str,
        user_input: Any = None,
        *,
        reward_signal: float | None = None,
        outcome_tags: Sequence[str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/minds/{mindId}/prepare — Mode B Step 1 (zero LLM key sent to AME)."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")

        if body is not None:
            payload = _normalize_mapping_keys(body, _PREPARE_KEY_MAP)
        elif isinstance(user_input, Mapping):
            payload = _normalize_mapping_keys(user_input, _PREPARE_KEY_MAP)
        else:
            if user_input is None:
                raise ValueError("user_input is required for client.prepare().")
            payload = {"userInput": str(user_input)}

        if reward_signal is not None:
            payload["rewardSignal"] = float(reward_signal)
        if outcome_tags is not None:
            payload["outcomeTags"] = [str(tag) for tag in outcome_tags]
        if metadata is not None:
            payload["metadata"] = dict(metadata)

        return self._request("POST", f"/v1/minds/{encoded_mind}/prepare", body=payload)

    def settle(
        self,
        mind_id: str,
        turn_ticket_id: Any = None,
        raw_reply: str | None = None,
        *,
        reward_signal: float | None = None,
        outcome_tags: Sequence[str] | None = None,
        provider_used: str | None = None,
        model_used: str | None = None,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/minds/{mindId}/settle — Mode B Step 2 settlement into memory and telemetry."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")

        if body is not None:
            payload = _normalize_mapping_keys(body, _SETTLE_KEY_MAP)
        elif isinstance(turn_ticket_id, Mapping):
            payload = _normalize_mapping_keys(turn_ticket_id, _SETTLE_KEY_MAP)
        else:
            if not turn_ticket_id:
                raise ValueError("turn_ticket_id is required for client.settle().")
            if raw_reply is None:
                raise ValueError("raw_reply is required for client.settle().")
            payload = {
                "turnTicketId": str(turn_ticket_id),
                "rawReply": str(raw_reply),
            }

        if reward_signal is not None:
            payload["rewardSignal"] = float(reward_signal)
        if outcome_tags is not None:
            payload["outcomeTags"] = [str(tag) for tag in outcome_tags]
        if provider_used is not None:
            payload["providerUsed"] = _normalize_provider_name(provider_used)
        elif "providerUsed" in payload and payload["providerUsed"] is not None:
            payload["providerUsed"] = _normalize_provider_name(str(payload["providerUsed"]))
        if model_used is not None:
            payload["modelUsed"] = str(model_used)

        return self._request("POST", f"/v1/minds/{encoded_mind}/settle", body=payload)

    def idle_tick(
        self,
        mind_id: str,
        elapsed_hours: Any = None,
        reason: str | None = None,
        *,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/minds/{mindId}/idle-tick — D2 offline circadian/homeostasis progression."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")

        if body is not None:
            payload = _normalize_mapping_keys(body, _IDLE_TICK_KEY_MAP)
        elif isinstance(elapsed_hours, Mapping):
            payload = _normalize_mapping_keys(elapsed_hours, _IDLE_TICK_KEY_MAP)
        else:
            if elapsed_hours is None:
                raise ValueError("elapsed_hours is required for client.idle_tick().")
            payload = {"elapsedHours": float(elapsed_hours)}

        if reason is not None:
            payload["reason"] = str(reason)

        return self._request("POST", f"/v1/minds/{encoded_mind}/idle-tick", body=payload)

    def revoke_memory(self, mind_id: str, memory_id: str) -> dict[str, Any]:
        """DELETE /v1/minds/{mindId}/memories/{memoryId} — D3 triple atomic memory revocation."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")
        encoded_memory = _encode_path_segment(memory_id, "memory_id")
        return self._request("DELETE", f"/v1/minds/{encoded_mind}/memories/{encoded_memory}")

    def get_telemetry(self, mind_id: str) -> dict[str, Any]:
        """GET /v1/minds/{mindId}/telemetry — D4-filtered public telemetry snapshot."""
        encoded_mind = _encode_path_segment(mind_id, "mind_id")
        return self._request("GET", f"/v1/minds/{encoded_mind}/telemetry")
