"""Artificial Mind Engine (AME) zero-dependency Python SDK."""

from __future__ import annotations

from .client import AmeApiError, AmeClient
from .domains import (
    DOMAIN_PROFILES,
    DomainProfile,
    build_companion_chat_profile,
    build_counseling_coach_profile,
    build_game_npc_profile,
    define_domain_profile,
)
from .llm_adapters import (
    AnthropicAdapter,
    GeminiAdapter,
    LlmAdapter,
    MockLlmAdapter,
    OpenAiCompatibleAdapter,
    create_llm_adapter,
    run_turn_with_local_llm,
)

__version__ = "1.0.0"

__all__ = [
    "__version__",
    "AmeClient",
    "AmeApiError",
    "create_llm_adapter",
    "run_turn_with_local_llm",
    "LlmAdapter",
    "MockLlmAdapter",
    "OpenAiCompatibleAdapter",
    "AnthropicAdapter",
    "GeminiAdapter",
    "DomainProfile",
    "define_domain_profile",
    "build_game_npc_profile",
    "build_companion_chat_profile",
    "build_counseling_coach_profile",
    "DOMAIN_PROFILES",
]
