"""
persona/place_persona.py — Classify places by lifestyle persona.

Mirrors UserPersona but applied to venues, so the alignment scorer can compare
"who this place is for" with "who this user is".

PlacePersona axes (same as user):
    serves_occupation : set[str]  — {"student", "professional", "family", "general"}
    social            : "quiet" | "balanced" | "social"
    productivity      : "high"  | "medium"   | "low"
    nightlife_intensity: "none" | "some"     | "high"
    religiosity       : "strict" | "moderate" | "secular"
    fitness           : "high"  | "medium"   | "low"

Classification uses:
  - name / description / tags keywords
  - place_type → default persona
  - review snippets (when available)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


# ─── Static type → default persona map ────────────────────────────────────────

_TYPE_DEFAULTS: dict[str, dict[str, Any]] = {
    "coffee":     {"social": "balanced", "productivity": "medium"},
    "cafe":       {"social": "balanced", "productivity": "medium"},
    "restaurant": {"social": "balanced", "productivity": "low"},
    "bakery":     {"social": "balanced", "productivity": "low"},
    "bar":        {"social": "social",   "nightlife": "high",  "productivity": "low"},
    "lounge":     {"social": "social",   "nightlife": "high",  "productivity": "low"},
    "night_club": {"social": "social",   "nightlife": "high",  "productivity": "low"},
    "club":       {"social": "social",   "nightlife": "high",  "productivity": "low"},
    "music":      {"social": "social",   "nightlife": "some"},
    "gym":        {"fitness": "high",    "social": "balanced"},
    "yoga":       {"fitness": "high",    "social": "quiet"},
    "fitness":    {"fitness": "high"},
    "spa":        {"social": "quiet"},
    "park":       {"social": "balanced", "nightlife": "none"},
    "hiking":     {"fitness": "high",    "social": "balanced"},
    "outdoor":    {"fitness": "medium",  "nightlife": "none"},
    "workspace":  {"productivity": "high",  "social": "quiet"},
    "coworking":  {"productivity": "high",  "social": "quiet", "occupation": {"professional"}},
    "library":    {"productivity": "high",  "social": "quiet"},
    "museum":     {"social": "quiet"},
    "art":        {"social": "balanced"},
    "cinema":     {"social": "balanced"},
    "shop":       {"social": "balanced"},
    "shopping":   {"social": "balanced"},
    "mall":       {"social": "balanced"},
    "church":     {"religiosity": "strict", "occupation": {"general"}},
    "mosque":     {"religiosity": "strict"},
    "worship":    {"religiosity": "strict"},
    "hotel":      {"social": "balanced"},
}

# ─── Keyword bundles ──────────────────────────────────────────────────────────

_STUDENT_KW = (
    r"\bstudent\b", r"university", r"college", r"campus", r"student[- ]friendly",
    r"study spot", r"study area", r"affordable for students",
)
_PROFESSIONAL_KW = (
    r"executive", r"business meeting", r"business lounge", r"corporate",
    r"professional", r"upscale", r"premium", r"vip", r"private dining",
    r"power lunch", r"networking", r"high[- ]end",
)
_FAMILY_KW = (
    r"family[- ]friendly", r"kids menu", r"children's", r"playground", r"play area",
    r"family restaurant", r"family\b",
)
_QUIET_KW = (
    r"quiet", r"peaceful", r"calm", r"serene", r"tranquil", r"silent",
    r"relax", r"cozy", r"intimate", r"reading corner",
)
_SOCIAL_KW = (
    r"lively", r"vibrant", r"buzzing", r"trendy", r"happening", r"party",
    r"crowded", r"popular spot", r"hot spot", r"night out",
)
_NIGHT_KW = (
    r"nightlife", r"late night", r"after hours", r"24/7", r"open till late",
    r"dj", r"dance floor", r"shisha", r"hookah", r"cocktail bar",
)
_PRODUCTIVE_KW = (
    r"wifi", r"wi-?fi", r"plug[- ]in", r"work[- ]friendly", r"laptop[- ]friendly",
    r"co[- ]?working", r"coworking", r"productive", r"study spot",
)


def _compile(words: tuple[str, ...]) -> re.Pattern:
    return re.compile("|".join(words), re.IGNORECASE)


_STUDENT_RE      = _compile(_STUDENT_KW)
_PROFESSIONAL_RE = _compile(_PROFESSIONAL_KW)
_FAMILY_RE       = _compile(_FAMILY_KW)
_QUIET_RE        = _compile(_QUIET_KW)
_SOCIAL_RE       = _compile(_SOCIAL_KW)
_NIGHT_RE        = _compile(_NIGHT_KW)
_PRODUCTIVE_RE   = _compile(_PRODUCTIVE_KW)


@dataclass
class PlacePersona:
    serves_occupation: set[str]  = field(default_factory=lambda: {"general"})
    social:            str       = "balanced"
    productivity:      str       = "medium"
    nightlife:         str       = "none"
    religiosity:       str       = "secular"
    fitness:           str       = "low"
    confidence:        float     = 0.5
    signals:           list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "serves_occupation": sorted(self.serves_occupation),
            "social":            self.social,
            "productivity":      self.productivity,
            "nightlife":         self.nightlife,
            "religiosity":       self.religiosity,
            "fitness":           self.fitness,
            "confidence":        self.confidence,
            "signals":           self.signals,
        }


def _gather(place: dict[str, Any]) -> str:
    parts: list[str] = []
    for k in ("name", "title", "description", "summary", "address", "vicinity"):
        v = place.get(k)
        if isinstance(v, str):
            parts.append(v)
    for k in ("tags", "categories", "types"):
        v = place.get(k)
        if isinstance(v, list):
            parts.extend(str(x) for x in v)
    for k in ("reviews", "user_reviews"):
        v = place.get(k)
        if isinstance(v, list):
            for r in v[:5]:
                if isinstance(r, dict):
                    parts.append(str(r.get("text", "")))
                elif isinstance(r, str):
                    parts.append(r)
    return " ".join(parts)


def classify_place_persona(place: dict[str, Any]) -> PlacePersona:
    """
    Classify a place by lifestyle persona using its type, name, description,
    tags, and reviews.

    Returns a PlacePersona with axis labels and a list of triggering signals.
    """
    if not isinstance(place, dict):
        return PlacePersona()

    text = _gather(place)
    ptype = str(place.get("type") or place.get("place_type") or place.get("category") or "").strip().lower()

    # Start with the type's default persona
    defaults = _TYPE_DEFAULTS.get(ptype, {})
    occ: set[str] = set(defaults.get("occupation", set()))
    if not occ:
        occ = {"general"}

    social       = defaults.get("social",       "balanced")
    productivity = defaults.get("productivity", "medium")
    nightlife    = defaults.get("nightlife",    "none")
    religiosity  = defaults.get("religiosity",  "secular")
    fitness      = defaults.get("fitness",      "low")

    signals: list[str] = []

    # ── Keyword overrides ─────────────────────────────────────────────────────
    if _STUDENT_RE.search(text):
        occ = {"student"} | (occ - {"general"})
        signals.append("student_keywords")
    if _PROFESSIONAL_RE.search(text):
        occ.add("professional")
        signals.append("professional_keywords")
        # Premium / corporate signals tilt nightlife down + social up slightly
        social = "social" if social == "quiet" else social
    if _FAMILY_RE.search(text):
        occ.add("family")
        signals.append("family_keywords")

    if _QUIET_RE.search(text):
        social = "quiet"
        productivity = "medium" if productivity == "low" else productivity
        signals.append("quiet_keywords")
    if _SOCIAL_RE.search(text):
        social = "social"
        signals.append("social_keywords")

    if _NIGHT_RE.search(text):
        nightlife = "high"
        signals.append("nightlife_keywords")

    if _PRODUCTIVE_RE.search(text):
        productivity = "high"
        social = "quiet" if social == "balanced" else social
        signals.append("productivity_keywords")

    # ── Religious place inference (loose) ─────────────────────────────────────
    if ptype in ("church", "mosque", "worship", "chapel"):
        religiosity = "strict"
    elif re.search(r"\bcathedral|chapel|monastery|synagogue|temple\b", text, re.I):
        religiosity = "moderate"
        signals.append("religious_keywords")

    confidence = 0.55 + 0.05 * min(len(signals), 5)

    return PlacePersona(
        serves_occupation = occ if occ else {"general"},
        social            = social,
        productivity      = productivity,
        nightlife         = nightlife,
        religiosity       = religiosity,
        fitness           = fitness,
        confidence        = round(min(0.92, confidence), 3),
        signals           = signals,
    )
