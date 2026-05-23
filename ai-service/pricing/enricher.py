"""
pricing/enricher.py — Eligibility-aware enrichment (no fake prices on free venues).

Flow:
  1. resolve_pricing_eligibility (heuristic + signals)
  2. Optional OpenAI refinement when PRICING_LLM_REFINE=1 and (ambiguous OR PRICING_LLM_ALWAYS=1)
  3. If pricing disabled → empty costs, no tier
  4. Else classify + estimate as before
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .classifier import classify_place
from .dataset import category_for_place_type
from .eligibility import resolve_pricing_eligibility
from .estimator import estimate_cost

logger = logging.getLogger(__name__)

# Enabled by default — the LLM refines ambiguous venues with Ethiopian economic context.
# Set PRICING_LLM_REFINE=false to disable (e.g. in low-cost dev environments).
_PRICING_LLM_REFINE = os.getenv("PRICING_LLM_REFINE", "true").lower() in (
    "1", "true", "yes",
)
_PRICING_LLM_ALWAYS = os.getenv("PRICING_LLM_ALWAYS", "false").lower() in (
    "1", "true", "yes",
)


def enrich_place(place: dict[str, Any]) -> dict[str, Any]:
    """
    Returns enrichment for API merge:

      pricing_enabled, pricing_reason,
      priceLevel (optional), priceConfidence, priceSignals,
      estimatedCost, priceCategory
    """
    empty_off = {
        "pricing_enabled": False,
        "pricing_reason":  "Unable to classify place",
        "priceLevel":       None,
        "priceConfidence":  0.0,
        "priceSignals":     [],
        "estimatedCost":    {},
        "priceCategory":    "dining",
    }

    if not isinstance(place, dict):
        return empty_off

    elig = resolve_pricing_eligibility(place)

    if _PRICING_LLM_REFINE and (elig.get("ambiguous") or _PRICING_LLM_ALWAYS):
        try:
            from llm.openai_client import merge_pricing_eligibility_llm

            elig = merge_pricing_eligibility_llm(place, elig)
        except Exception as exc:
            logger.debug("[enricher] pricing LLM refine skipped: %s", exc)

    if not elig.get("pricing_enabled"):
        return {
            "pricing_enabled": False,
            "pricing_reason":  elig.get("reason") or "No consumer pricing context",
            "priceLevel":       None,
            "priceConfidence":  0.0,
            "priceSignals":     list(elig.get("signals") or []),
            "estimatedCost":    {},
            "priceCategory":    category_for_place_type(
                str(place.get("type") or place.get("place_type") or place.get("category") or ""),
            ),
        }

    place_type = place.get("type") or place.get("place_type") or place.get("category", "")
    category   = category_for_place_type(place_type)
    tier, conf, signals = classify_place(place)

    llm_level = elig.get("estimated_price_level")
    llm_conf  = float(elig.get("llm_confidence") or 0.0)
    if llm_level in ("cheap", "mid", "expensive") and llm_conf >= 0.55:
        tier = llm_level
        conf = min(0.95, max(float(conf), llm_conf))

    cost = estimate_cost(category, tier)
    sigs = list(elig.get("signals") or []) + list(signals)

    return {
        "pricing_enabled": True,
        "pricing_reason":  elig.get("reason") or "Typical spend expected for this category",
        "priceLevel":      tier,
        "priceConfidence": float(conf),
        "priceSignals":    sigs,
        "estimatedCost":   cost,
        "priceCategory":   category,
    }
