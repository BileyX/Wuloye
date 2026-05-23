"""
persona/user_persona.py — Infer a user's lifestyle persona from onboarding +
behaviour signals.

A "persona" is a coarse 6-axis label that lets the recommendation engine
reason about WHO the user is, not just WHAT they like:

    occupation_band   : "professional" | "student" | "family" | "general"
    social_intensity  : "quiet"        | "balanced" | "social"
    productivity_focus: "high"         | "medium"   | "low"
    nightlife_tolerance: "none"        | "some"     | "high"
    religiosity       : "strict"       | "moderate" | "secular"
    fitness_focus     : "high"         | "medium"   | "low"

Inference order (cheapest → strongest):
  1. Direct onboarding signals (wake/sleep, weeklyActivities, religion)
  2. Numeric budget anchors (very-high budget → "professional")
  3. Working hours / schedule
  4. Behavioural learning vector (interactions) — currently passed in
     externally because it lives in learning/realtime.py

Pure heuristic — no LLM, no external data. Runs in microseconds.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional


# ─── Type aliases for clarity ─────────────────────────────────────────────────

OccupationBand    = str  # "professional" | "student" | "family" | "general"
SocialIntensity   = str  # "quiet" | "balanced" | "social"
ProductivityFocus = str  # "high"  | "medium"   | "low"
Nightlife         = str  # "none"  | "some"     | "high"
Religiosity       = str  # "strict" | "moderate" | "secular"
FitnessFocus      = str  # "high"  | "medium"   | "low"


@dataclass
class UserPersona:
    occupation:        OccupationBand    = "general"
    social:            SocialIntensity   = "balanced"
    productivity:      ProductivityFocus = "medium"
    nightlife:         Nightlife         = "some"
    religiosity:       Religiosity       = "secular"
    fitness:           FitnessFocus      = "medium"
    # Confidence in [0, 1] for each axis — used by alignment scoring
    confidence:        dict[str, float]  = field(default_factory=dict)
    # Short human-readable summary for explanations
    summary:           str               = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "occupation":   self.occupation,
            "social":       self.social,
            "productivity": self.productivity,
            "nightlife":    self.nightlife,
            "religiosity":  self.religiosity,
            "fitness":      self.fitness,
            "confidence":   self.confidence,
            "summary":      self.summary,
        }


# ─── Vocabularies for heuristic matching ──────────────────────────────────────

_QUIET_ACTIVITIES   = frozenset(["reading", "studying", "meditation", "writing", "yoga", "prayer", "walking"])
_SOCIAL_ACTIVITIES  = frozenset(["social", "music", "movies", "gaming", "shopping", "dancing", "nightlife", "clubbing"])
_FITNESS_ACTIVITIES = frozenset(["gym", "running", "cycling", "yoga", "hiking", "sports", "fitness"])
_PRODUCTIVITY_INT   = frozenset(["coding", "studying", "reading", "writing", "tech"])
_FAMILY_INT         = frozenset(["family", "kids", "parenting", "cooking", "children"])
_STUDENT_INT        = frozenset(["studying", "tech", "coding", "reading", "education"])


def _to_hours(t: str | None) -> Optional[int]:
    """Parse 'HH:mm' or 'HH' to integer hour 0-23."""
    if not t:
        return None
    try:
        parts = str(t).strip().split(":")
        h = int(parts[0])
        return h if 0 <= h <= 23 else None
    except (TypeError, ValueError, IndexError):
        return None


def _normalize(items: Iterable[Any]) -> set[str]:
    out: set[str] = set()
    for x in items or []:
        if not x:
            continue
        out.add(str(x).strip().lower())
    return out


# ─── Main inference ───────────────────────────────────────────────────────────

def infer_user_persona(
    profile: dict[str, Any] | None,
    learned_top_categories: list[tuple[str, float]] | None = None,
) -> UserPersona:
    """
    Build a UserPersona from a backend profile dict (and optional learned
    category affinities).

    The profile dict mirrors the AI service ContextIn — keys may be in either
    snake_case or camelCase form.  We tolerate both.
    """
    if not profile:
        return UserPersona(summary="No profile data — defaults applied.")

    # Normalise camel/snake variants
    def _get(*keys: str, default: Any = None) -> Any:
        for k in keys:
            if k in profile and profile[k] not in (None, ""):
                return profile[k]
        return default

    wake_h          = _to_hours(_get("wake_time", "wakeTime"))
    sleep_h         = _to_hours(_get("sleep_time", "sleepTime"))
    weekly          = _normalize(_get("weekly_activities", "weeklyActivities", default=[]))
    interests       = _normalize(_get("interests", default=[]))
    event_interests = _normalize(_get("event_interests", "eventInterests", default=[]))
    religion        = str(_get("religion", default="") or "").lower()
    weekend_pref    = str(_get("weekend_preference", "weekendPreference", default="") or "").lower()
    working_hours   = _get("working_hours", "workingHours", default="")
    weekly_budget   = _get("weekly_budget", "weeklyBudget")
    budget_tier     = str(_get("budget", "budget_range", "budgetRange", default="") or "").lower()
    age_group       = str(_get("age_group", "ageGroup", default="") or "").lower()

    all_interests = weekly | interests | event_interests

    confidence: dict[str, float] = {}

    # ── 1. Occupation band ────────────────────────────────────────────────────
    occupation: OccupationBand = "general"
    occ_conf = 0.4
    # Fixed working hours → professional
    if isinstance(working_hours, str) and "-" in working_hours:
        occupation = "professional"; occ_conf = 0.8
    elif isinstance(working_hours, dict):
        if not working_hours.get("flexible") and (working_hours.get("morning") or working_hours.get("afternoon")):
            occupation = "professional"; occ_conf = 0.75
        elif working_hours.get("flexible"):
            occupation = "general"; occ_conf = 0.45
    # Student signal — explicit interests
    if _STUDENT_INT & all_interests and occupation != "professional":
        occupation = "student"; occ_conf = 0.7
    # Family signal
    if _FAMILY_INT & all_interests:
        occupation = "family"; occ_conf = max(occ_conf, 0.6)
    # Numeric budget anchor
    try:
        wb = float(weekly_budget) if weekly_budget is not None else None
    except (TypeError, ValueError):
        wb = None
    if wb is not None:
        if wb >= 15000 and occupation == "general":
            occupation = "professional"; occ_conf = max(occ_conf, 0.7)
        elif wb <= 1500 and not (_STUDENT_INT & all_interests) and occupation == "general":
            # Low budget alone is NOT a student signal (could be cheap professional)
            pass
    # Age group override (when provided)
    if age_group in ("18-24", "student"):
        occupation = "student"; occ_conf = max(occ_conf, 0.8)
    elif age_group in ("25-34", "35-44", "45-54", "55+", "professional"):
        if occupation == "general":
            occupation = "professional"; occ_conf = max(occ_conf, 0.65)

    confidence["occupation"] = occ_conf

    # ── 2. Social intensity ──────────────────────────────────────────────────
    quiet_score  = len(_QUIET_ACTIVITIES  & all_interests)
    social_score = len(_SOCIAL_ACTIVITIES & all_interests)
    if weekend_pref in ("indoor",):     quiet_score  += 1
    if weekend_pref in ("social",):     social_score += 2
    if weekend_pref in ("outdoor",):    quiet_score  += 0  # neutral
    # Learned affinities — if user repeatedly engages with "social" / "club" types
    if learned_top_categories:
        for cat, aff in learned_top_categories[:5]:
            if cat in ("social", "club", "music", "bar"):
                social_score += 1 if aff >= 0.6 else 0
            if cat in ("workspace", "coffee", "cafe") and aff >= 0.7:
                quiet_score += 1

    if quiet_score > social_score + 1:
        social: SocialIntensity = "quiet"; soc_conf = 0.7
    elif social_score > quiet_score + 1:
        social = "social"; soc_conf = 0.7
    else:
        social = "balanced"; soc_conf = 0.5
    confidence["social"] = soc_conf

    # ── 3. Productivity focus ────────────────────────────────────────────────
    prod_hits = len(_PRODUCTIVITY_INT & all_interests)
    productivity: ProductivityFocus = "medium"
    if prod_hits >= 2 or "coding" in all_interests:
        productivity = "high"
    elif occupation == "professional":
        productivity = "medium" if productivity == "low" else productivity
    elif social == "social":
        productivity = "low"
    confidence["productivity"] = 0.6 if prod_hits else 0.4

    # ── 4. Nightlife tolerance ───────────────────────────────────────────────
    nightlife: Nightlife = "some"
    night_words = {"nightlife", "clubbing", "dancing", "bar", "club"}
    if night_words & all_interests:
        nightlife = "high"; night_conf = 0.8
    elif religion in ("orthodox", "protestant", "muslim", "catholic"):
        nightlife = "none"; night_conf = 0.7
    elif sleep_h is not None and sleep_h < 23:
        nightlife = "none" if sleep_h <= 21 else "some"
        night_conf = 0.7
    else:
        night_conf = 0.4
    confidence["nightlife"] = night_conf

    # ── 5. Religiosity ───────────────────────────────────────────────────────
    religiosity: Religiosity = "secular"
    if religion and religion not in ("", "other", "prefer_not_to_say"):
        religiosity = "moderate"
        # Strong signal: "prayer" or "meditation" or "church" / "mosque" in interests
        if {"prayer", "religious", "worship", "church", "mosque"} & all_interests:
            religiosity = "strict"
    confidence["religiosity"] = 0.85 if religion else 0.4

    # ── 6. Fitness focus ─────────────────────────────────────────────────────
    fit_hits = len(_FITNESS_ACTIVITIES & all_interests)
    if fit_hits >= 2:
        fitness: FitnessFocus = "high"
    elif fit_hits == 1:
        fitness = "medium"
    else:
        fitness = "low"
    confidence["fitness"] = 0.6 if fit_hits else 0.4

    # ── Human-readable summary ───────────────────────────────────────────────
    bits: list[str] = []
    if occupation != "general": bits.append(occupation)
    if social      != "balanced": bits.append(f"{social} lifestyle")
    if productivity == "high":    bits.append("productivity-focused")
    if nightlife    == "none":    bits.append("no nightlife")
    if religiosity  != "secular": bits.append(f"{religion} faith")
    if fitness      == "high":    bits.append("fitness-active")
    summary = ", ".join(bits) if bits else "general lifestyle"

    return UserPersona(
        occupation   = occupation,
        social       = social,
        productivity = productivity,
        nightlife    = nightlife,
        religiosity  = religiosity,
        fitness      = fitness,
        confidence   = confidence,
        summary      = summary,
    )
