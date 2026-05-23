"""
persona/alignment.py — Compare a UserPersona against a PlacePersona and
return a single signed adjustment for the recommendation score.

This is the layer that surgically prevents the "working professional getting
student cafe spam" problem.

Returns a value in roughly [-0.50, +0.18]:

  + Strong alignment (multiple axes match)        → up to +0.18
  + Soft alignment / neutral defaults             → ~0.00
  − One axis contradicts                          → −0.10
  − Two+ axes contradict (e.g. quiet professional → loud student nightclub)
                                                    → up to −0.50 (near-block)

Also exposes a `persona_match_label()` helper that returns a short string
("matches your professional vibe", "doesn't fit your quiet preference", …)
which the explanation generator uses to make recommendations feel personal.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .user_persona import UserPersona
    from .place_persona import PlacePersona


# Axis weights (sum ≈ 1) — multiplied by the per-axis match score
_AXIS_WEIGHTS = {
    "occupation":   0.38,   # bumped: working-pro vs student is the most visible mismatch
    "social":       0.22,
    "productivity": 0.12,
    "nightlife":    0.18,
    "religiosity":  0.06,
    "fitness":      0.04,
}


# ─── Per-axis match logic ────────────────────────────────────────────────────

def _occupation_score(user: "UserPersona", place: "PlacePersona") -> float:
    """+1 strong match, 0 neutral, -1 contradiction (extreme)."""
    served = place.serves_occupation
    if not served or "general" in served:
        return 0.1   # neutral places get a tiny positive (they're for everyone)
    if user.occupation in served:
        return 1.0
    # Mismatch: student-coded place for working professional →
    # this is the prototypical "student cafe spam" bug, so it must
    # produce a clearly visible penalty.
    if user.occupation == "professional" and "student" in served and len(served) == 1:
        return -1.4
    if user.occupation == "student" and "professional" in served and len(served) == 1:
        return -0.8
    if user.occupation == "family" and "professional" in served and "family" not in served:
        return -0.4
    return -0.3


def _social_score(user_social: str, place_social: str) -> float:
    # Mapping: quiet=0, balanced=1, social=2
    o = {"quiet": 0, "balanced": 1, "social": 2}
    u, p = o.get(user_social, 1), o.get(place_social, 1)
    diff = abs(u - p)
    if diff == 0:        return 1.0
    if diff == 1:        return 0.2
    return -1.0   # quiet user at "social" place


def _productivity_score(user_prod: str, place_prod: str) -> float:
    o = {"low": 0, "medium": 1, "high": 2}
    u, p = o.get(user_prod, 1), o.get(place_prod, 1)
    if u == 2:
        # Productivity-focused user → boost high-productivity places strongly
        if p == 2: return 1.0
        if p == 1: return 0.2
        return -0.4
    if u == 0:
        return 0.0    # low-productivity user is indifferent
    return 0.1 if p >= 1 else -0.1


def _nightlife_score(user_night: str, place_night: str) -> float:
    o = {"none": 0, "some": 1, "high": 2}
    u, p = o.get(user_night, 1), o.get(place_night, 1)
    if u == 0 and p == 2: return -1.0       # no-nightlife user + nightclub
    if u == 0 and p == 1: return -0.4
    if u == 2 and p == 2: return 1.0
    if u == p:            return 0.5
    return 0.0


def _religiosity_score(user: str, place: str) -> float:
    if place == "secular":          return 0.0   # most places — neutral
    if user == "secular":           return -0.1  # secular user + religious venue → tiny penalty
    if user == "strict" and place == "strict": return 1.0
    if user == "moderate" and place in ("strict", "moderate"): return 0.4
    return 0.0


def _fitness_score(user: str, place: str) -> float:
    if user == "high" and place == "high": return 1.0
    if user == "low"  and place == "high": return -0.2
    return 0.0


# ─── Public API ───────────────────────────────────────────────────────────────

def persona_alignment_score(
    user: "UserPersona | None",
    place: "PlacePersona | None",
) -> tuple[float, list[str]]:
    """
    Returns (signed adjustment in roughly [-0.50, +0.18], list of reasons).

    `reasons` are short strings used in explanation generation, e.g.:
      "matches your professional vibe", "fits your quiet preference",
      "doesn't fit your no-nightlife preference"
    """
    if user is None or place is None:
        return 0.0, []

    components: list[tuple[str, float, float]] = []  # (axis, raw, weight)

    components.append(("occupation",   _occupation_score(user, place),                       _AXIS_WEIGHTS["occupation"]))
    components.append(("social",       _social_score(user.social, place.social),             _AXIS_WEIGHTS["social"]))
    components.append(("productivity", _productivity_score(user.productivity, place.productivity), _AXIS_WEIGHTS["productivity"]))
    components.append(("nightlife",    _nightlife_score(user.nightlife, place.nightlife),    _AXIS_WEIGHTS["nightlife"]))
    components.append(("religiosity",  _religiosity_score(user.religiosity, place.religiosity), _AXIS_WEIGHTS["religiosity"]))
    components.append(("fitness",      _fitness_score(user.fitness, place.fitness),          _AXIS_WEIGHTS["fitness"]))

    # Weighted sum, scaled into [-0.5, +0.2] band
    total = 0.0
    reasons: list[str] = []
    contradiction_count = 0
    for axis, raw, w in components:
        # Scale per-axis confidence by user side
        user_conf = (user.confidence or {}).get(axis, 0.5)
        place_conf = place.confidence
        eff_w = w * (0.5 + 0.5 * user_conf) * (0.6 + 0.4 * place_conf)
        contribution = raw * eff_w
        total += contribution

        if raw >= 0.8:
            reasons.append(_positive_label(axis, user, place))
        elif raw <= -0.6:
            contradiction_count += 1
            reasons.append(_negative_label(axis, user, place))

    # Cap the band
    if total > 0:
        score = min(0.18, total * 0.18 / max(0.01, sum(w for _, _, w in components)))
    else:
        score = max(-0.50, total * 0.50 / max(0.01, sum(w for _, _, w in components)))

    # Sharp extra penalty when 2+ contradictions fire — these are
    # genuinely bad recommendations the AI should suppress hard.
    if contradiction_count >= 2:
        score = min(score, -0.35)

    return round(score, 4), [r for r in reasons if r]


def persona_match_label(user: "UserPersona | None", place: "PlacePersona | None") -> str:
    """
    Short user-facing label for the alignment quality. Useful for the mobile
    badge / detail page.
    """
    if user is None or place is None:
        return ""
    score, _ = persona_alignment_score(user, place)
    if score >= 0.10:  return "Strong personality match"
    if score >= 0.04:  return "Matches your style"
    if score >= -0.05: return ""
    if score >= -0.20: return "Slight lifestyle mismatch"
    return "Doesn't match your lifestyle"


# ─── Per-axis verbal reasons ──────────────────────────────────────────────────

def _positive_label(axis: str, user: "UserPersona", place: "PlacePersona") -> str:
    if axis == "occupation":
        if user.occupation == "professional": return "matches your professional vibe"
        if user.occupation == "student":      return "popular among students like you"
        if user.occupation == "family":       return "family-friendly atmosphere"
        return ""
    if axis == "social":
        if user.social == "quiet":  return "fits your quiet preference"
        if user.social == "social": return "matches your social vibe"
        return ""
    if axis == "productivity" and user.productivity == "high":
        return "great for your productivity focus"
    if axis == "nightlife" and user.nightlife == "high":
        return "fits your nightlife taste"
    if axis == "religiosity" and user.religiosity != "secular":
        return f"aligns with your {user.religiosity} {axis.replace('religiosity', 'faith')}"
    if axis == "fitness" and user.fitness == "high":
        return "supports your active lifestyle"
    return ""


def _negative_label(axis: str, user: "UserPersona", place: "PlacePersona") -> str:
    if axis == "occupation":
        if user.occupation == "professional" and "student" in place.serves_occupation:
            return "more of a student spot"
        if user.occupation == "student" and "professional" in place.serves_occupation:
            return "feels more corporate than student"
        return "doesn't fit your typical crowd"
    if axis == "social":
        if user.social == "quiet"  and place.social == "social":  return "may be too lively for you"
        if user.social == "social" and place.social == "quiet":   return "may be too quiet for your taste"
        return ""
    if axis == "nightlife" and user.nightlife == "none":
        return "nightlife venue — outside your preference"
    if axis == "productivity" and user.productivity == "high" and place.productivity == "low":
        return "not ideal for productivity"
    return ""
