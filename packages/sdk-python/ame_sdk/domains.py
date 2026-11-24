"""Domain profile presets and schema builders for Artificial Mind Engine (AME)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

VALID_DOMAINS: tuple[str, ...] = (
    "game_npc",
    "companion_chat",
    "counseling_coach",
    "custom",
)

_SAFETY_POLICY_KEY_MAP: dict[str, str] = {
    "strict_abstention": "strictAbstention",
    "strictAbstention": "strictAbstention",
    "anti_sycophancy": "antiSycophancy",
    "antiSycophancy": "antiSycophancy",
    "crisis_escalation": "crisisEscalation",
    "crisisEscalation": "crisisEscalation",
}


def normalize_safety_policy(policy: Mapping[str, Any] | None) -> dict[str, bool] | None:
    """Normalize snake_case and camelCase keys for AME SafetyPolicy."""
    if policy is None:
        return None
    normalized: dict[str, bool] = {}
    for raw_key, value in policy.items():
        if value is None:
            continue
        canonical_key = _SAFETY_POLICY_KEY_MAP.get(raw_key, raw_key)
        normalized[canonical_key] = bool(value)
    return normalized


def normalize_custom_schema(schema: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Normalize customSchema metadata for AME CreateMindRequest."""
    if schema is None:
        return None
    normalized: dict[str, Any] = {}
    if "name" in schema and schema["name"] is not None:
        normalized["name"] = str(schema["name"])
    if "fields" in schema and schema["fields"] is not None:
        normalized["fields"] = [str(item) for item in schema["fields"]]
    for key, value in schema.items():
        if key not in ("name", "fields") and value is not None:
            normalized[key] = value
    return normalized


@dataclass(frozen=True)
class DomainProfile:
    """Reusable domain and persona configuration compatible with POST /v1/minds."""

    domain: str
    name: str
    role: str
    traits: dict[str, float] = field(default_factory=dict)
    backstory: str = ""
    language: str = "ko"
    custom_schema: dict[str, Any] | None = None
    safety_policy: dict[str, bool] | None = None

    def __post_init__(self) -> None:
        if self.domain not in VALID_DOMAINS:
            raise ValueError(
                f"Unsupported AME domain '{self.domain}'. Must be one of {VALID_DOMAINS}."
            )
        if not self.name.strip():
            raise ValueError("DomainProfile 'name' must be a non-empty string.")
        if not self.role.strip():
            raise ValueError("DomainProfile 'role' must be a non-empty string.")

    def to_create_mind_request(self) -> dict[str, Any]:
        """Serialize this profile into a canonical OpenAPI CreateMindRequest dict."""
        persona: dict[str, Any] = {
            "name": self.name,
            "role": self.role,
            "language": self.language,
        }
        if self.traits:
            persona["traits"] = {str(k): float(v) for k, v in self.traits.items()}
        if self.backstory:
            persona["backstory"] = self.backstory

        payload: dict[str, Any] = {
            "domain": self.domain,
            "persona": persona,
        }
        if self.custom_schema is not None:
            payload["customSchema"] = normalize_custom_schema(self.custom_schema)
        if self.safety_policy is not None:
            payload["safetyPolicy"] = normalize_safety_policy(self.safety_policy)
        return payload


def define_domain_profile(
    name: str,
    role: str,
    domain: str = "custom",
    *,
    traits: Mapping[str, float] | None = None,
    backstory: str = "",
    language: str = "ko",
    custom_schema: Mapping[str, Any] | None = None,
    output_fields: Sequence[str] | None = None,
    safety_policy: Mapping[str, Any] | None = None,
) -> DomainProfile:
    """Create a validated DomainProfile for any AME domain or custom schema."""
    resolved_schema = normalize_custom_schema(custom_schema)
    if output_fields is not None:
        fields_list = [str(item) for item in output_fields]
        if resolved_schema is None:
            slug = "_".join(name.lower().split()) or "custom"
            resolved_schema = {"name": f"{slug}_output", "fields": fields_list}
        elif "fields" not in resolved_schema:
            resolved_schema["fields"] = fields_list

    if safety_policy is None:
        resolved_policy: dict[str, bool] = {
            "strictAbstention": True,
            "antiSycophancy": True,
            "crisisEscalation": domain == "counseling_coach",
        }
    else:
        resolved_policy = normalize_safety_policy(safety_policy) or {}

    return DomainProfile(
        domain=domain,
        name=name,
        role=role,
        traits={str(k): float(v) for k, v in (traits or {}).items()},
        backstory=backstory,
        language=language,
        custom_schema=resolved_schema,
        safety_policy=resolved_policy,
    )


def build_game_npc_profile(
    name: str = "Kaelen",
    role: str = "Guild Quartermaster & Master Smith",
    *,
    traits: Mapping[str, float] | None = None,
    backstory: str = "Veteran frontier artificer tracking player reputation, debts, and faction loyalty.",
    language: str = "ko",
    safety_policy: Mapping[str, Any] | None = None,
) -> DomainProfile:
    """Build a preset profile tailored for persistent Game NPCs."""
    default_traits: dict[str, float] = {
        "vigilance": 0.75,
        "warmth": 0.45,
        "pragmatism": 0.80,
    }
    return define_domain_profile(
        name=name,
        role=role,
        domain="game_npc",
        traits=traits if traits is not None else default_traits,
        backstory=backstory,
        language=language,
        safety_policy=safety_policy
        or {
            "strictAbstention": True,
            "antiSycophancy": True,
            "crisisEscalation": False,
        },
    )


def build_companion_chat_profile(
    name: str = "Sora",
    role: str = "Attentive Everyday Companion",
    *,
    traits: Mapping[str, float] | None = None,
    backstory: str = "Warm, honest conversational partner maintaining episodic continuity without sycophancy.",
    language: str = "ko",
    safety_policy: Mapping[str, Any] | None = None,
) -> DomainProfile:
    """Build a preset profile tailored for long-horizon Companion Chat."""
    default_traits: dict[str, float] = {
        "empathy": 0.85,
        "curiosity": 0.72,
        "candor": 0.78,
    }
    return define_domain_profile(
        name=name,
        role=role,
        domain="companion_chat",
        traits=traits if traits is not None else default_traits,
        backstory=backstory,
        language=language,
        safety_policy=safety_policy
        or {
            "strictAbstention": True,
            "antiSycophancy": True,
            "crisisEscalation": False,
        },
    )


def build_counseling_coach_profile(
    name: str = "Dr. Han",
    role: str = "Reflective Counseling & Behavioral Coach",
    *,
    traits: Mapping[str, float] | None = None,
    backstory: str = "Structured cognitive-behavioral coach enforcing healthy boundaries and crisis escalation.",
    language: str = "ko",
    safety_policy: Mapping[str, Any] | None = None,
) -> DomainProfile:
    """Build a preset profile tailored for Counseling & Coaching with crisis escalation."""
    default_traits: dict[str, float] = {
        "calmness": 0.90,
        "boundaryAwareness": 0.95,
        "warmth": 0.75,
    }
    return define_domain_profile(
        name=name,
        role=role,
        domain="counseling_coach",
        traits=traits if traits is not None else default_traits,
        backstory=backstory,
        language=language,
        safety_policy=safety_policy
        or {
            "strictAbstention": True,
            "antiSycophancy": True,
            "crisisEscalation": True,
        },
    )


DOMAIN_PROFILES: dict[str, DomainProfile] = {
    "game_npc": build_game_npc_profile(),
    "companion_chat": build_companion_chat_profile(),
    "counseling_coach": build_counseling_coach_profile(),
    "custom": define_domain_profile(
        name="Nova",
        role="Structured Custom Domain Assistant",
        domain="custom",
        traits={"precision": 0.88, "consistency": 0.85},
        backstory="Configurable domain adapter emitting deterministic custom structured fields.",
        output_fields=["summary", "confidence", "nextAction"],
    ),
}
