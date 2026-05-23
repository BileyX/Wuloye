"""
llm/openai_client.py — Thin wrapper around OpenAI Chat Completions.

Design rules:
  - **Always degrade gracefully.** If OPENAI_API_KEY is empty or the API
    is unreachable, return a deterministic template-based string so the
    backend never has to handle "AI down" specially.
  - **Cap latency.** Hard timeout (default 4 seconds) so /predict can
    still meet its 3 s SLO when the LLM is enabled but slow.
  - **Cache aggressively.** Same (user_signals, place_id) → cached for
    `LLM_REASON_CACHE_TTL_SEC` seconds; 1-hour default.
  - **Tiny prompts.** We send only a structured, anonymised summary,
    not raw user data — saves tokens and protects privacy.

Public API:
    is_llm_enabled() -> bool
    generate_recommendation_reason(user_signals, place, max_chars=160) -> str
    summarize_reviews(reviews: list[str], max_chars=240) -> str
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from typing import Any, Optional

import config

logger = logging.getLogger(__name__)

# ─── Configuration (read once) ────────────────────────────────────────────────

_MODEL               = os.getenv("OPENAI_LLM_MODEL", "gpt-4o-mini")
_TIMEOUT_S           = float(os.getenv("OPENAI_LLM_TIMEOUT_S", "4.0"))
_CACHE_TTL_SEC       = int(os.getenv("LLM_REASON_CACHE_TTL_SEC", "3600"))
_MAX_TOKENS          = int(os.getenv("OPENAI_LLM_MAX_TOKENS", "120"))
_MAX_PRICING_TOKENS  = int(os.getenv("OPENAI_PRICING_LLM_MAX_TOKENS", "200"))
_TEMPERATURE         = float(os.getenv("OPENAI_LLM_TEMPERATURE", "0.4"))
_PRICING_LLM_TEMP    = float(os.getenv("OPENAI_PRICING_LLM_TEMPERATURE", "0.2"))

# ─── Lazy client ──────────────────────────────────────────────────────────────

_client = None
_client_lock = threading.Lock()


def is_llm_enabled() -> bool:
    """LLM features are on when OPENAI_API_KEY is configured."""
    return bool(config.OPENAI_API_KEY)


def _get_client():
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            try:
                from openai import OpenAI
                _client = OpenAI(api_key=config.OPENAI_API_KEY, timeout=_TIMEOUT_S)
            except Exception as exc:
                logger.warning("[llm] OpenAI client init failed: %s", exc)
                _client = None
    return _client


# ─── In-memory TTL cache (shared by both helpers) ─────────────────────────────

_cache: dict[str, tuple[float, str]] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str) -> Optional[str]:
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, val = entry
        if time.time() - ts > _CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        return val


def _cache_set(key: str, val: str) -> None:
    with _cache_lock:
        # bound cache size so it doesn't grow forever
        if len(_cache) > 5000:
            _cache.clear()
        _cache[key] = (time.time(), val)


def _hash_key(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


# ─── Template fallbacks (used when LLM disabled / fails) ──────────────────────

_BUDGET_LABEL: dict[str, str] = {
    "cheap":     "budget-friendly",
    "mid":       "mid-range",
    "expensive": "premium",
}
_PRICE_LABEL: dict[str, str] = {
    "cheap":     "affordable",
    "mid":       "mid-range priced",
    "expensive": "premium priced",
}


def _template_reason(user_signals: dict[str, Any], place: dict[str, Any]) -> str:
    """Deterministic explanation that uses available data only — no LLM."""
    name        = place.get("name") or "this place"
    p_type      = (place.get("type") or place.get("category") or "spot").lower()
    pricing_on  = place.get("pricing_enabled") is not False
    price_level = (place.get("priceLevel") or "mid").lower()
    weekend     = (user_signals.get("weekendPreference") or "").lower()
    intent      = (user_signals.get("session_intent") or "").lower()
    interests   = user_signals.get("interests") or []
    budget      = (user_signals.get("budget") or user_signals.get("budgetRange") or "").lower()

    if not pricing_on:
        intent_bit = f"for your {intent} mood" if intent and intent != "explore" else "worth visiting"
        return f"A {p_type} {intent_bit} — no entry cost required. {name.capitalize()} is a free venue."

    bits: list[str] = []

    # Core activity / mood signal
    if intent and intent != "explore":
        bits.append(f"fits your {intent} mood")
    elif p_type in ("gym", "yoga", "fitness"):
        bits.append("great for staying active")
    elif p_type in ("coffee", "cafe"):
        bits.append("a solid café pick")
    elif p_type == "restaurant":
        bits.append("a good dining option")
    else:
        bits.append(f"a recommended {p_type}")

    # Budget alignment — always mentioned when we have both signals
    if budget and price_level:
        budget_norm  = budget if budget in _BUDGET_LABEL else "mid"
        price_norm   = price_level if price_level in _PRICE_LABEL else "mid"
        budget_str   = _BUDGET_LABEL[budget_norm]
        price_str    = _PRICE_LABEL[price_norm]

        if budget_norm == price_norm:
            bits.append(f"matches your {budget_str} weekly budget")
        elif budget_norm == "cheap" and price_norm == "mid":
            bits.append("slightly above your budget range")
        elif budget_norm == "cheap" and price_norm == "expensive":
            bits.append("note: priced above your budget")
        elif budget_norm == "mid" and price_norm == "expensive":
            bits.append("on the higher end of your budget")
        else:
            bits.append(f"priced {price_str}, fits your spending range")

    # Weekend preference
    if weekend == "outdoor" and p_type in ("outdoor", "park", "hiking"):
        bits.append("ideal for your outdoor weekends")
    elif weekend == "indoor" and p_type in ("cafe", "coffee", "cinema", "workspace"):
        bits.append("suits your indoor weekend preference")

    # Interest match
    if interests:
        matched = [i for i in interests if str(i).lower() in p_type or p_type in str(i).lower()]
        if matched:
            bits.append(f"aligns with your {matched[0]} interest")

    reason = "; ".join(bits)
    if not reason:
        reason = f"Recommended {p_type} for your profile"
    return f"{reason.capitalize()}. {name} suits the moment."


def _template_summary(reviews: list[str]) -> str:
    """Plain pick-the-shortest summary fallback."""
    if not reviews:
        return ""
    pruned = [r.strip() for r in reviews if isinstance(r, str) and r.strip()]
    if not pruned:
        return ""
    pruned.sort(key=len)
    s = pruned[0]
    return s[:240]


# ─── Public API ───────────────────────────────────────────────────────────────

def generate_recommendation_reason(
    user_signals: dict[str, Any],
    place: dict[str, Any],
    *,
    max_chars: int = 160,
) -> str:
    """
    Returns one short sentence explaining why this place suits this user.

    Always returns a string — falls back to a template when LLM is off
    or the API call fails.
    """
    if not is_llm_enabled():
        return _template_reason(user_signals, place)[:max_chars]

    cache_key = _hash_key({
        "kind":  "reason",
        "place_id": place.get("id") or place.get("place_id"),
        "place_type": place.get("type") or place.get("category"),
        "pricing_off": place.get("pricing_enabled") is False,
        "price": place.get("priceLevel"),
        "user":  {
            "intent":  user_signals.get("session_intent"),
            "budget":  user_signals.get("budget") or user_signals.get("budgetRange"),
            "interests_top3": (user_signals.get("interests") or [])[:3],
            "weekend": user_signals.get("weekendPreference"),
            "religion": user_signals.get("religion"),
        },
    })
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    client = _get_client()
    if client is None:
        return _template_reason(user_signals, place)[:max_chars]

    # Build a tiny structured prompt — no PII, no raw user IDs.
    prompt_user = {
        "budget":           user_signals.get("budget") or user_signals.get("budgetRange") or "mid",
        "interests":        (user_signals.get("interests") or [])[:5],
        "weekendPreference": user_signals.get("weekendPreference") or "",
        "religion":         user_signals.get("religion") or "",
        "session_intent":   user_signals.get("session_intent") or "",
        "time_of_day":      user_signals.get("time_of_day") or "",
    }
    prompt_place = {
        "name":           place.get("name") or "",
        "type":           place.get("type") or place.get("category") or "",
        "pricingEnabled": place.get("pricing_enabled") if isinstance(place.get("pricing_enabled"), bool) else True,
        "priceLevel":     place.get("priceLevel") or "mid",
        "estimatedCost":  place.get("estimatedCost") or {},
        "highlights":     place.get("highlights") or [],
    }

    try:
        resp = client.chat.completions.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS,
            temperature=_TEMPERATURE,
            timeout=_TIMEOUT_S,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You write one short, friendly sentence (<= 28 words) that "
                        "explains why a specific place is recommended to a user. "
                        "Context: Addis Ababa, Ethiopia. "
                        "BUDGET RULES (critical): "
                        "- When user budget is 'cheap' and place is 'cheap': say it fits their budget. "
                        "- When user budget is 'cheap' and place is 'mid': mention it's slightly above budget. "
                        "- When user budget is 'cheap' and place is 'expensive': warn it's above their budget. "
                        "- When user budget is 'mid' and place is 'mid' or 'cheap': say it matches their budget. "
                        "- When user budget is 'expensive': mention premium quality. "
                        "When pricingEnabled is false, do NOT mention prices or budget — focus on "
                        "experience, vibe, beliefs, or timing. "
                        "Area hints: Bole Road = expensive; Kazanchis = mid; Mercato/Piazza = cheap. "
                        "Speak directly to the user. No emojis, no greetings, no bullet points. "
                        "Reference budget alignment first, then one place trait. Do not invent prices."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"User: {json.dumps(prompt_user)}\n"
                        f"Place: {json.dumps(prompt_place)}\n"
                        "Write the explanation now."
                    ),
                },
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        text = text.strip('"').strip()
        if not text:
            text = _template_reason(user_signals, place)
        text = text[:max_chars]
        _cache_set(cache_key, text)
        return text
    except Exception as exc:
        logger.warning("[llm] reason generation failed: %s", exc)
        return _template_reason(user_signals, place)[:max_chars]


def summarize_reviews(reviews: list[str], *, max_chars: int = 240) -> str:
    """One-sentence summary of the most useful information from reviews."""
    if not reviews:
        return ""

    if not is_llm_enabled():
        return _template_summary(reviews)[:max_chars]

    cache_key = _hash_key({
        "kind": "review_summary",
        "snippets": [str(r)[:200] for r in reviews[:6]],
    })
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    client = _get_client()
    if client is None:
        return _template_summary(reviews)[:max_chars]

    joined = " | ".join(str(r)[:280] for r in reviews[:6])
    try:
        resp = client.chat.completions.create(
            model=_MODEL,
            max_tokens=80,
            temperature=0.2,
            timeout=_TIMEOUT_S,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Summarize multiple short user reviews into ONE neutral, "
                        "factual sentence (<= 30 words). Do not add greetings, "
                        "bullets, or quotation marks. If reviews disagree, mention "
                        "both perspectives briefly."
                    ),
                },
                {"role": "user", "content": f"Reviews: {joined}"},
            ],
        )
        text = (resp.choices[0].message.content or "").strip().strip('"')
        if not text:
            text = _template_summary(reviews)
        text = text[:max_chars]
        _cache_set(cache_key, text)
        return text
    except Exception as exc:
        logger.warning("[llm] review summary failed: %s", exc)
        return _template_summary(reviews)[:max_chars]


_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")


def _compact_place_for_pricing_llm(place: dict[str, Any]) -> dict[str, Any]:
    rev = place.get("reviews") or []
    snippets: list[str] = []
    if isinstance(rev, list):
        for r in rev[:4]:
            if isinstance(r, dict):
                snippets.append(str(r.get("text", ""))[:240])
            elif isinstance(r, str):
                snippets.append(r[:240])
    return {
        "name": (place.get("name") or place.get("title") or "")[:120],
        "type": place.get("type") or place.get("category") or place.get("place_type") or "",
        "description": str(place.get("description") or place.get("summary") or "")[:400],
        "address": str(place.get("address") or place.get("vicinity") or "")[:200],
        "review_snippets": snippets,
        "tags": (place.get("tags") or [])[:8],
    }


def _apply_pricing_llm_dict(heuristic_out: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    pe = data.get("pricing_enabled")
    if isinstance(pe, bool):
        heuristic_out["pricing_enabled"] = pe
    reason = data.get("reason")
    if isinstance(reason, str) and reason.strip():
        heuristic_out["reason"] = reason.strip()[:240]
    try:
        c = float(data.get("confidence"))
        heuristic_out["llm_confidence"] = max(0.0, min(1.0, c))
    except (TypeError, ValueError):
        heuristic_out["llm_confidence"] = 0.65
    level = data.get("estimated_price_level")
    if level in ("cheap", "mid", "expensive"):
        heuristic_out["estimated_price_level"] = level
    else:
        heuristic_out.pop("estimated_price_level", None)
    heuristic_out["ambiguous"] = False
    sigs = list(heuristic_out.get("signals") or [])
    sigs.append("llm_pricing_refine")
    heuristic_out["signals"] = sigs
    return heuristic_out


def merge_pricing_eligibility_llm(place: dict[str, Any], heuristic: dict[str, Any]) -> dict[str, Any]:
    """
    OpenAI refinement for pricing eligibility (ambiguous venues).

    Returns a copy of `heuristic` with optional overrides:
      pricing_enabled, reason, estimated_price_level, llm_confidence.
    """
    if not is_llm_enabled():
        return heuristic

    out = dict(heuristic)
    payload = {
        "kind": "pricing_eligibility",
        "place_id": place.get("id") or place.get("place_id"),
        "heuristic": {
            "pricing_enabled": heuristic.get("pricing_enabled"),
            "reason": heuristic.get("reason"),
            "ambiguous": heuristic.get("ambiguous"),
        },
        "place": _compact_place_for_pricing_llm(place),
    }
    cache_key = _hash_key(payload)
    cached_raw = _cache_get(cache_key)
    if cached_raw:
        try:
            data = json.loads(cached_raw)
            return _apply_pricing_llm_dict(out, data)
        except json.JSONDecodeError:
            pass

    client = _get_client()
    if client is None:
        return heuristic

    prev = json.dumps(
        {
            "pricing_enabled": heuristic.get("pricing_enabled"),
            "reason": heuristic.get("reason"),
            "ambiguous": heuristic.get("ambiguous"),
        },
        ensure_ascii=False,
    )
    user_blob = json.dumps(_compact_place_for_pricing_llm(place), ensure_ascii=False)

    prompt = (
        "You classify venues in Addis Ababa, Ethiopia for a consumer app.\n"
        "Decide whether the place USUALLY involves spending money "
        "(meals, tickets, lodging, coworking, museum admission, gym, shopping purchase, paid event).\n"
        "Use pricing_enabled=false for: churches, mosques, ordinary public parks, playgrounds, hiking trails, "
        "free street events, volunteer gatherings, typical public libraries, monuments.\n"
        "pricing_enabled=true for: restaurants, cafes, hotels, gyms, cinemas, paid events, "
        "coworking spaces, stores, museums with admission, paid sports clubs.\n\n"
        "PRICE TIER GUIDE for Addis Ababa (weekly budget context):\n"
        "  cheap (≤ 2,000 ETB/wk): local tej bets, fatira stalls, neighborhood kitfo spots, "
        "small local cafes (Tomoca branch, buna bet), community gyms, Mercato vendors, Shola market.\n"
        "  mid (2,001–10,000 ETB/wk): Bole cafes (Kaldi's), mid-range Kazanchis restaurants, "
        "standard hotel gyms, boutique workspaces, average cinema tickets, Edna Mall food court.\n"
        "  expensive (> 10,000 ETB/wk): Skylight Hotel, Hyatt Regency, Sheraton Addis, Radisson Blu, "
        "Hilton, Marriott, rooftop bars, VIP lounges, fine dining, premium spas.\n"
        "Review language: 'affordable/cheap/local/budget' → cheap; 'overpriced/luxury/premium/5-star' → expensive.\n"
        "Area hints: Bole Road strip / airport = expensive; Kazanchis / Sarbet = mid; "
        "Mercato / Piazza / Shola = cheap.\n"
        "Return ONE JSON object only, no markdown code fences:\n"
        '{"pricing_enabled":true|false,"reason":"one short sentence",'
        '"estimated_price_level":"cheap"|"mid"|"expensive"|null,'
        '"confidence":0.0}\n'
        f"Prior heuristic: {prev}\n"
        f"Place: {user_blob}\n"
    )

    try:
        resp = client.chat.completions.create(
            model=_MODEL,
            max_tokens=_MAX_PRICING_TOKENS,
            temperature=_PRICING_LLM_TEMP,
            timeout=_TIMEOUT_S,
            messages=[
                {"role": "system", "content": "Return only valid JSON. No other text."},
                {"role": "user", "content": prompt},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        m = _JSON_OBJ_RE.search(text)
        if m:
            text = m.group(0)
        data = json.loads(text)
        _cache_set(cache_key, json.dumps(data, sort_keys=True, default=str))
        return _apply_pricing_llm_dict(out, data)
    except Exception as exc:
        logger.warning("[llm] pricing eligibility merge failed: %s", exc)
        return heuristic
