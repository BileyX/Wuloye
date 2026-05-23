"""
pricing/dataset.py — Ethiopian price benchmark dataset (2026).

All values are in ETB (Ethiopian Birr).
Use `null` (None) on the upper bound for "and above" tiers.

This dataset is the single source of truth for tier ranges.
Override per-locale by setting environment vars or extending this file.
"""

from __future__ import annotations

# Numeric ranges per (category, tier).  Upper bound = None means open-ended.
PRICE_RANGES: dict[str, dict[str, dict[str, tuple[float, float | None]]]] = {
    # ── Dining ────────────────────────────────────────────────────────────────
    "dining": {
        "cheap": {
            "meal":   (125, 300),
            "coffee": (20, 45),
            "snack":  (40, 100),
        },
        "mid": {
            "meal":   (600, 1500),
            "coffee": (70, 150),
            "snack":  (200, 500),
        },
        "expensive": {
            "meal":   (3500, None),
            "coffee": (250, None),
            "snack":  (800, None),
        },
    },

    # ── Lodging (per night) ────────────────────────────────────────────────────
    "lodging": {
        "cheap":     {"room": (800, 1500)},
        "mid":       {"room": (2500, 7500)},
        "expensive": {"room": (14000, None)},
    },

    # ── Transport (per ride within Addis) ──────────────────────────────────────
    "transport": {
        "cheap":     {"ride": (150, 300)},
        "mid":       {"ride": (400, 700)},
        "expensive": {"ride": (1200, None)},
    },

    # ── Fitness / wellness (per session or day pass) ───────────────────────────
    "fitness": {
        "cheap":     {"session": (100, 250)},
        "mid":       {"session": (350, 800)},
        "expensive": {"session": (1200, None)},
    },

    # ── Events / entertainment (per ticket or cover) ───────────────────────────
    "events": {
        "cheap":     {"ticket": (100, 300)},
        "mid":       {"ticket": (500, 1500)},
        "expensive": {"ticket": (2500, None)},
    },

    # ── Shopping / retail (typical purchase) ───────────────────────────────────
    "shopping": {
        "cheap":     {"item": (50, 500)},
        "mid":       {"item": (1000, 5000)},
        "expensive": {"item": (10000, None)},
    },

    # Coworking / day desk — rough Addis benchmarks
    "workspace": {
        "cheap":     {"day_pass": (150, 400), "coffee": (40, 90)},
        "mid":       {"day_pass": (400, 1200), "coffee": (70, 180)},
        "expensive": {"day_pass": (1500, None), "coffee": (120, None)},
    },
}


# ── Place-type → category map (for picking the right ranges) ─────────────────
PLACE_TYPE_CATEGORY: dict[str, str] = {
    # Dining
    "coffee":     "dining",
    "cafe":       "dining",
    "restaurant": "dining",
    "bakery":     "dining",

    # Lodging
    "hotel":      "lodging",
    "lodge":      "lodging",
    "guesthouse": "lodging",

    # Transport
    "taxi":       "transport",
    "bus":        "transport",
    "ride":       "transport",

    # Fitness
    "gym":        "fitness",
    "yoga":       "fitness",
    "fitness":    "fitness",
    "sports":     "fitness",
    "spa":        "fitness",

    # Events / social
    "event":      "events",
    "events":     "events",
    "concert":    "events",
    "club":       "events",
    "social":     "events",
    "music":      "events",
    "cinema":     "events",

    # Shopping
    "shop":       "shopping",
    "shopping":   "shopping",
    "market":     "shopping",
    "store":      "shopping",
    "mall":       "shopping",

    "workspace":  "workspace",
    "coworking":  "workspace",
    "office":     "workspace",

    # Outdoor / parks → use events tier as proxy (mostly free or low-cost)
    "outdoor":    "events",
    "park":       "events",
    "hiking":     "events",

    # Religious places — typically free; map to events for tier shape
    "church":     "events",
    "mosque":     "events",
    "worship":    "events",
}


def category_for_place_type(place_type: str) -> str:
    """Returns the pricing category for a place_type (defaults to 'dining')."""
    if not place_type:
        return "dining"
    return PLACE_TYPE_CATEGORY.get(place_type.strip().lower(), "dining")


# ── Numeric weeklyBudget → tier mapping (Ethiopian birr) ─────────────────────
# Used to normalise the onboarding `weeklyBudget` field to "cheap|mid|expensive".

def budget_amount_to_tier(weekly_budget_etb: float | int | None) -> str:
    """
    Converts a numeric weekly outing budget (ETB) to a 3-tier label.

    Unified thresholds (aligned with mobile onboarding and backend):
      1 – 2,000   → cheap       (Mercato / local kibat / neighborhood cafes)
      2,001 – 10,000 → mid      (Bole cafes, mid-range restaurants)
      > 10,000    → expensive   (Skylight / Hyatt / Sheraton tier)
    """
    if weekly_budget_etb is None:
        return "mid"
    try:
        amt = float(weekly_budget_etb)
    except (TypeError, ValueError):
        return "mid"
    if amt <= 0:
        return "mid"
    if amt <= 2000:
        return "cheap"
    if amt <= 10000:
        return "mid"
    return "expensive"


# ── Area reputation knowledge (for LLM prompt context) ───────────────────────
# Injected into OpenAI prompts and used as a soft signal.

AREA_REPUTATION: dict[str, str] = {
    # Expensive
    "bole road":            "expensive",
    "bole internacional":   "expensive",
    "bole international":   "expensive",
    "airport":              "expensive",
    # Mid
    "bole":                 "mid",
    "old airport":          "mid",
    "kazanchis":            "mid",
    "sarbet":               "mid",
    "gerji":                "mid",
    "megenagna":            "mid",
    "atlas":                "mid",
    "summit":               "mid",
    "haya hulet":           "mid",
    "edna mall":            "mid",
    # Cheap
    "mercato":              "cheap",
    "merkato":              "cheap",
    "addis ketema":         "cheap",
    "shola":                "cheap",
    "piazza":               "cheap",
    "saris":                "cheap",
    "kality":               "cheap",
    "lideta":               "cheap",
    "kolfe":                "cheap",
    "gulele":               "cheap",
}


def budget_label_normalize(value: str | None) -> str:
    """Maps various budget label aliases to the canonical 'cheap|mid|expensive'."""
    if not value:
        return "mid"
    v = str(value).strip().lower()
    if v in ("cheap", "low", "budget", "affordable"):
        return "cheap"
    if v in ("mid", "medium", "moderate", "standard"):
        return "mid"
    if v in ("expensive", "high", "luxury", "premium", "flexible"):
        return "expensive"
    return "mid"
