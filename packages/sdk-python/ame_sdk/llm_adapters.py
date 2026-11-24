"""Hot-swappable stdlib-only LLM adapters for Mode B local execution."""

from __future__ import annotations

import inspect
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Mapping, Sequence

from .client import AmeApiError, AmeClient

TransportFn = Callable[..., Any]

_OPENAI_COMPAT_PROVIDERS: dict[str, tuple[str, str | None]] = {
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "deepseek": ("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "openai-compat": ("http://127.0.0.1:11434/v1", None),
}

_PROVIDER_ENV_VARS: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def normalize_provider(provider: str) -> str:
    """Normalize provider aliases (e.g., openai_compat -> openai-compat)."""
    cleaned = str(provider).strip().lower()
    if cleaned == "openai_compat":
        return "openai-compat"
    return cleaned


def _default_http_transport(
    url: str,
    headers: Mapping[str, str],
    payload: Mapping[str, Any],
    timeout: float,
) -> dict[str, Any]:
    """Send an HTTP POST JSON request via stdlib urllib and decode the JSON response."""
    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Accept": "application/json", "Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_text = resp.read().decode("utf-8", errors="replace").strip()
            if not raw_text:
                return {}
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError as exc:
                raise AmeApiError(
                    resp.status,
                    "Invalid JSON response from LLM provider.",
                    body=raw_text,
                    endpoint=url,
                ) from exc
            if not isinstance(parsed, dict):
                raise AmeApiError(
                    resp.status,
                    "Expected JSON object from LLM provider.",
                    body=parsed,
                    endpoint=url,
                )
            return parsed
    except urllib.error.HTTPError as exc:
        raw_error = exc.read().decode("utf-8", errors="replace").strip()
        parsed_body: Any = raw_error if raw_error else None
        message = str(exc.reason or f"HTTP {exc.code}")
        if raw_error:
            try:
                decoded = json.loads(raw_error)
                parsed_body = decoded
                if isinstance(decoded, dict):
                    nested_err = decoded.get("error")
                    if isinstance(nested_err, dict) and nested_err.get("message"):
                        message = str(nested_err["message"])
                    elif decoded.get("message"):
                        message = str(decoded["message"])
            except json.JSONDecodeError:
                message = raw_error
        raise AmeApiError(exc.code, message, body=parsed_body, endpoint=url) from exc
    except urllib.error.URLError as exc:
        raise AmeApiError(0, f"LLM transport error: {exc.reason}", body=None, endpoint=url) from exc


def _invoke_transport(
    transport: TransportFn | None,
    url: str,
    headers: Mapping[str, str],
    payload: Mapping[str, Any],
    timeout: float,
) -> dict[str, Any]:
    """Dispatch a request through a custom transport or the default urllib transport."""
    if transport is None:
        return _default_http_transport(url, headers, payload, timeout)

    sig = inspect.signature(transport)
    positional = [
        p
        for p in sig.parameters.values()
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    has_varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in sig.parameters.values())
    if not has_varargs and len(positional) == 3:
        raw_result = transport(url, dict(headers), dict(payload))
    else:
        raw_result = transport(url, dict(headers), dict(payload), timeout)

    if isinstance(raw_result, str):
        return json.loads(raw_result)
    if isinstance(raw_result, Mapping):
        return dict(raw_result)
    raise TypeError(f"Custom LLM transport must return dict or JSON str, got {type(raw_result).__name__}.")


def _combine_system_and_non_system_messages(
    prepared: Mapping[str, Any],
) -> tuple[str, list[dict[str, str]]]:
    """Extract deduplicated system prompt text and ordered non-system messages."""
    system_parts: list[str] = []
    seen_system: set[str] = set()

    top_system = str(prepared.get("systemPrompt") or "").strip()
    if top_system:
        system_parts.append(top_system)
        seen_system.add(top_system)

    chat_messages: list[dict[str, str]] = []
    for item in prepared.get("messages") or []:
        role = str(item.get("role") or "user").strip().lower()
        content = str(item.get("content") or "")
        if role == "system":
            stripped = content.strip()
            if stripped and stripped not in seen_system:
                system_parts.append(stripped)
                seen_system.add(stripped)
        else:
            chat_messages.append({"role": role, "content": content})

    return "\n\n".join(system_parts), chat_messages


class LlmAdapter:
    """Base interface for hot-swappable Mode B LLM adapters."""

    def __init__(
        self,
        provider: str,
        model: str,
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> None:
        self.provider = normalize_provider(provider)
        self.model = str(model)
        self.temperature = float(temperature) if temperature is not None else None
        self.max_tokens = int(max_tokens) if max_tokens is not None else None

    def _resolve_sampling(self, prepared: Mapping[str, Any]) -> tuple[float | None, int | None]:
        hints = prepared.get("samplingHints") or {}
        resolved_temp = (
            self.temperature
            if self.temperature is not None
            else (float(hints["temperature"]) if hints.get("temperature") is not None else None)
        )
        resolved_max_tokens = (
            self.max_tokens
            if self.max_tokens is not None
            else (int(hints["maxTokens"]) if hints.get("maxTokens") is not None else None)
        )
        return resolved_temp, resolved_max_tokens

    def generate(self, prepared: Mapping[str, Any]) -> str:
        """Produce a raw text completion from an AME PrepareTurnResponse."""
        raise NotImplementedError


class MockLlmAdapter(LlmAdapter):
    """Zero-network deterministic adapter reading PrepareTurnResponse directives."""

    def __init__(
        self,
        model: str = "mock-local",
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> None:
        super().__init__("mock", model, temperature=temperature, max_tokens=max_tokens)

    def generate(self, prepared: Mapping[str, Any]) -> str:
        hot_abstention = prepared.get("hotAbstention") or {}
        should_abstain = bool(hot_abstention.get("shouldAbstain"))
        abstain_reason = str(hot_abstention.get("reason") or "insufficient grounded memory")
        domain = str(prepared.get("domain") or "custom")
        fep = prepared.get("fepThoughtLock") or {}
        fep_mode = str(
            fep.get("mode")
            or ("locked_high_fe" if fep.get("locked") else "automatic_low_fe")
        )
        somatic_hint = str(prepared.get("somaticHint") or "").strip()

        last_user_text = ""
        for message in reversed(prepared.get("messages") or []):
            if str(message.get("role") or "").lower() == "user":
                last_user_text = str(message.get("content") or "").strip()
                break

        if should_abstain:
            return (
                f"[ABSTAIN:{domain}] I cannot verify that from active memory "
                f"({abstain_reason})."
            )

        somatic_clause = f" | somatic={somatic_hint}" if somatic_hint else ""
        return (
            f"[MOCK:{domain}:{fep_mode}{somatic_clause}] "
            f"Grounded reply to '{last_user_text}'."
        )


class OpenAiCompatibleAdapter(LlmAdapter):
    """Adapter for OpenAI, DeepSeek, OpenRouter, and OpenAI-compatible local servers."""

    def __init__(
        self,
        provider: str = "openai",
        model: str = "gpt-4o-mini",
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float = 60.0,
        transport: TransportFn | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        canonical = normalize_provider(provider)
        if canonical not in _OPENAI_COMPAT_PROVIDERS:
            raise ValueError(
                f"OpenAiCompatibleAdapter does not support provider '{provider}'."
            )
        super().__init__(canonical, model, temperature=temperature, max_tokens=max_tokens)

        default_base, env_var = _OPENAI_COMPAT_PROVIDERS[canonical]
        self._has_custom_base = base_url is not None
        self.base_url = (base_url or default_base).rstrip("/")
        self.api_key = api_key if api_key is not None else (os.environ.get(env_var) if env_var else None)
        self.env_var = env_var
        self.timeout = float(timeout)
        self.transport = transport
        self.extra_headers = dict(extra_headers or {})

    def _endpoint(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        return f"{self.base_url}/chat/completions"

    def _build_messages(self, prepared: Mapping[str, Any]) -> list[dict[str, str]]:
        system_prompt = str(prepared.get("systemPrompt") or "").strip()
        raw_messages = prepared.get("messages") or []
        messages: list[dict[str, str]] = []
        has_matching_system = False

        for msg in raw_messages:
            role = str(msg.get("role") or "user")
            content = str(msg.get("content") or "")
            if role == "system" and system_prompt and content.strip() == system_prompt:
                has_matching_system = True
            messages.append({"role": role, "content": content})

        if system_prompt and not has_matching_system:
            messages.insert(0, {"role": "system", "content": system_prompt})
        return messages

    def generate(self, prepared: Mapping[str, Any]) -> str:
        if (
            self.provider != "openai-compat"
            and not self.api_key
            and self.transport is None
            and not self._has_custom_base
        ):
            raise ValueError(
                f"Missing API key for provider '{self.provider}'. "
                f"Pass api_key=... or set {self.env_var}."
            )

        temp, max_toks = self._resolve_sampling(prepared)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._build_messages(prepared),
        }
        if temp is not None:
            payload["temperature"] = temp
        if max_toks is not None:
            payload["max_tokens"] = max_toks

        headers = dict(self.extra_headers)
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        data = _invoke_transport(
            self.transport,
            self._endpoint(),
            headers,
            payload,
            self.timeout,
        )
        choices = data.get("choices") or []
        if not choices or not isinstance(choices, list):
            raise ValueError(f"Unexpected {self.provider} response without choices: {data!r}")

        first_choice = choices[0] if isinstance(choices[0], Mapping) else {}
        message = first_choice.get("message")
        if isinstance(message, Mapping):
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [
                    str(part.get("text") or "")
                    for part in content
                    if isinstance(part, Mapping) and "text" in part
                ]
                return "".join(parts)
        if isinstance(first_choice.get("text"), str):
            return first_choice["text"]

        raise ValueError(f"Unable to extract text content from {self.provider} response: {data!r}")


class AnthropicAdapter(LlmAdapter):
    """Adapter for the Anthropic Messages API (/v1/messages)."""

    DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
    ANTHROPIC_VERSION = "2023-06-01"

    def __init__(
        self,
        model: str = "claude-3-5-sonnet-latest",
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float = 60.0,
        transport: TransportFn | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__("anthropic", model, temperature=temperature, max_tokens=max_tokens)
        self._has_custom_base = base_url is not None
        self.base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY")
        self.timeout = float(timeout)
        self.transport = transport
        self.extra_headers = dict(extra_headers or {})

    def _endpoint(self) -> str:
        if self.base_url.endswith("/v1/messages") or self.base_url.endswith("/messages"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/messages"
        return f"{self.base_url}/v1/messages"

    def generate(self, prepared: Mapping[str, Any]) -> str:
        if not self.api_key and self.transport is None and not self._has_custom_base:
            raise ValueError(
                "Missing API key for provider 'anthropic'. Pass api_key=... or set ANTHROPIC_API_KEY."
            )

        system_text, chat_messages = _combine_system_and_non_system_messages(prepared)
        temp, max_toks = self._resolve_sampling(prepared)

        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_toks if max_toks is not None else 1024,
            "messages": chat_messages,
        }
        if system_text:
            payload["system"] = system_text
        if temp is not None:
            payload["temperature"] = temp

        headers = {
            "anthropic-version": self.ANTHROPIC_VERSION,
            **self.extra_headers,
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key

        data = _invoke_transport(
            self.transport,
            self._endpoint(),
            headers,
            payload,
            self.timeout,
        )
        content = data.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list) and content:
            text_chunks = [
                str(block.get("text") or "")
                for block in content
                if isinstance(block, Mapping) and (block.get("type") == "text" or "text" in block)
            ]
            if text_chunks:
                return "".join(text_chunks)
        raise ValueError(f"Unable to extract text content from anthropic response: {data!r}")


class GeminiAdapter(LlmAdapter):
    """Adapter for the Google Gemini generateContent REST API."""

    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(
        self,
        model: str = "gemini-2.5-flash",
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float = 60.0,
        transport: TransportFn | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__("gemini", model, temperature=temperature, max_tokens=max_tokens)
        self._has_custom_base = base_url is not None
        self.base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("GEMINI_API_KEY")
        self.timeout = float(timeout)
        self.transport = transport
        self.extra_headers = dict(extra_headers or {})

    def _endpoint(self) -> str:
        if ":generateContent" in self.base_url:
            return self.base_url
        clean_model = self.model.removeprefix("models/")
        encoded_model = urllib.parse.quote(clean_model, safe="")
        return f"{self.base_url}/models/{encoded_model}:generateContent"

    def generate(self, prepared: Mapping[str, Any]) -> str:
        if not self.api_key and self.transport is None and not self._has_custom_base:
            raise ValueError(
                "Missing API key for provider 'gemini'. Pass api_key=... or set GEMINI_API_KEY."
            )

        system_text, chat_messages = _combine_system_and_non_system_messages(prepared)
        temp, max_toks = self._resolve_sampling(prepared)

        contents = [
            {
                "role": "model" if msg["role"] == "assistant" else "user",
                "parts": [{"text": msg["content"]}],
            }
            for msg in chat_messages
        ]

        payload: dict[str, Any] = {"contents": contents}
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}

        generation_config: dict[str, Any] = {}
        if temp is not None:
            generation_config["temperature"] = temp
        if max_toks is not None:
            generation_config["maxOutputTokens"] = max_toks
        if generation_config:
            payload["generationConfig"] = generation_config

        headers = dict(self.extra_headers)
        if self.api_key:
            headers["x-goog-api-key"] = self.api_key

        data = _invoke_transport(
            self.transport,
            self._endpoint(),
            headers,
            payload,
            self.timeout,
        )
        candidates = data.get("candidates") or []
        if not candidates or not isinstance(candidates, list):
            raise ValueError(f"Unexpected gemini response without candidates: {data!r}")

        first = candidates[0] if isinstance(candidates[0], Mapping) else {}
        content = first.get("content") if isinstance(first.get("content"), Mapping) else {}
        parts = content.get("parts") or []
        text_chunks = [
            str(part.get("text") or "")
            for part in parts
            if isinstance(part, Mapping) and "text" in part
        ]
        if text_chunks:
            return "".join(text_chunks)
        raise ValueError(f"Unable to extract text content from gemini response: {data!r}")


def create_llm_adapter(
    provider: str,
    model: str = "mock-local",
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    timeout: float = 60.0,
    transport: TransportFn | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> LlmAdapter:
    """Instantiate an LlmAdapter for any supported AME provider."""
    canonical = normalize_provider(provider)

    if canonical == "mock":
        return MockLlmAdapter(
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    if canonical in _OPENAI_COMPAT_PROVIDERS:
        return OpenAiCompatibleAdapter(
            provider=canonical,
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            transport=transport,
            extra_headers=extra_headers,
        )
    if canonical == "anthropic":
        return AnthropicAdapter(
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            transport=transport,
            extra_headers=extra_headers,
        )
    if canonical == "gemini":
        return GeminiAdapter(
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            transport=transport,
            extra_headers=extra_headers,
        )

    raise ValueError(
        f"Unsupported LLM provider '{provider}'. Supported providers: "
        "mock, openai, anthropic, gemini, deepseek, openrouter, openai_compat, openai-compat."
    )


def run_turn_with_local_llm(
    client: AmeClient,
    mind_id: str,
    user_input: str,
    adapter: LlmAdapter,
    *,
    reward_signal: float | None = None,
    outcome_tags: Sequence[str] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute Mode B locally: prepare() -> local adapter.generate() -> settle()."""
    tags_list = [str(tag) for tag in outcome_tags] if outcome_tags is not None else None
    prepared = client.prepare(
        mind_id,
        user_input=user_input,
        reward_signal=reward_signal,
        outcome_tags=tags_list,
        metadata=metadata,
    )
    raw_reply = adapter.generate(prepared)
    return client.settle(
        mind_id,
        turn_ticket_id=prepared["turnTicketId"],
        raw_reply=raw_reply,
        reward_signal=reward_signal,
        outcome_tags=tags_list,
        provider_used=adapter.provider,
        model_used=adapter.model,
    )
