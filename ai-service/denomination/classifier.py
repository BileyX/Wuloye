"""
denomination/classifier.py — Weighted denomination classifier for religious venues.

Scoring approach
────────────────
Each denomination (orthodox, protestant, catholic, muslim) accumulates a
weighted score from multiple evidence sources:

  1. Place name keyword hit       — highest weight  (3.0)
  2. Tags / type string hit       — high weight     (2.0)
  3. Description keyword hit      — medium weight   (1.5)
  4. Review text hit              — medium weight   (1.0)
  5. Website URL domain hit       — medium weight   (1.5)
  6. OpenAI semantic confirmation — confidence bump (0–2.0 scaled)

The denomination with the highest cumulative score wins, but only if it
exceeds a minimum threshold (MIN_SCORE_TO_CLASSIFY = 1.0).  Below that
threshold the place is labelled "christian" (generic) so the filter
behaves conservatively rather than incorrectly.

Graceful degradation
────────────────────
If OPENAI_API_KEY is absent the module works in pure keyword-scoring mode
which is already highly accurate for Ethiopian church names.

Public API
──────────
  classify(place_dict) → DenominationResult
  is_religious_venue(place_dict) → bool
  denomination_allowed_for_user(place_dict, user_religion) → bool
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ─── Minimum evidence score needed to commit to a denomination ────────────────
MIN_SCORE_TO_CLASSIFY = 1.0

# ─── Cache TTL (seconds): denomination rarely changes for a given place ───────
_CACHE_TTL_SEC = 24 * 3600  # 24 hours
_cache: dict[str, tuple[float, "DenominationResult"]] = {}
_cache_lock = threading.Lock()


# ─── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class DenominationResult:
    denomination: str          # "orthodox" | "protestant" | "catholic" | "muslim" | "christian" | "other"
    confidence: float          # 0.0 – 1.0
    scores: dict[str, float]   # raw per-denomination scores
    evidence: list[str]        # human-readable evidence list (for debugging)
    is_religious: bool         # True when the place is a religious venue at all


# ─── Keyword lists ────────────────────────────────────────────────────────────
# Tuples of (keyword, weight) — longer / more specific keywords carry more weight.

_ORTHODOX_NAME = [
    # Amharic/Geez-romanised titles
    ("tewahedo",          4.0),
    ("tewahido",          4.0),
    ("medhanealem",       3.5),
    ("medhane alem",      3.5),
    ("medhane-alem",      3.5),
    ("debre",             3.0),
    ("kidus",             3.0),
    ("kidist",            3.0),
    ("kiddis",            3.0),
    ("qidus",             3.0),
    ("qiddis",            3.0),
    ("bete christian",    3.0),
    ("bete kristiyan",    3.0),
    ("giorgis",           2.5),
    ("gebriel",           2.5),
    ("mikael",            2.5),
    ("mikail",            2.5),
    ("urael",             2.5),
    ("urail",             2.5),
    ("gabriel orthodox",  4.0),
    ("mariam orthodox",   4.0),
    ("mariam church",     2.5),   # "Mariam" alone is strong in Ethiopian context
    ("selassie",          2.5),
    ("kidane mehret",     3.5),
    ("kidane mehrete",    3.5),
    ("kidane-mehret",     3.5),
    ("gedam",             2.5),
    ("gedam church",      3.5),
    ("abune",             2.5),
    ("patriarch",         2.0),
    ("etchege",           3.0),
    ("qesis",             2.5),
    # Amharic script
    ("ቅዱስ",              4.0),
    ("ቅድስት",             4.0),
    ("ማርያም",             3.0),
    ("ቅዱሳን",             3.0),
    ("መድሀኒዓለም",          4.0),
    ("ቅዱስ ሚካኤል",        4.0),
    ("ቅዱስ ጊዮርጊስ",       4.0),
    ("ቅዱስ ገብርኤል",       4.0),
    ("ቅዱሰ ኡራኤል",        4.0),
    ("ደብረ",              3.5),
    ("ምዕራፍ",             2.0),
    ("ጽዮን",              2.5),
    # Generic English
    ("orthodox",          3.5),
    ("ethiopian orthodox", 4.0),
    ("st. mariam",        3.0),
    ("saint mariam",      3.0),
    ("st mariam",         3.0),
    ("kidane",            2.5),
]

_ORTHODOX_REVIEW = [
    ("kidase",            3.0),
    ("qidase",            3.0),
    ("timket",            3.0),
    ("meskel",            2.5),
    ("holy water",        2.0),
    ("liturgy",           2.0),
    ("incense",           1.5),
    ("chanting",          1.5),
    ("deacon",            2.0),
    ("priest orthodox",   3.0),
    ("tsebel",            2.5),
]

_PROTESTANT_NAME = [
    ("eecmy",              4.5),
    ("eec my",             4.5),
    ("evangelical church", 4.0),
    ("mekane yesus",       4.0),
    ("mekane-yesus",       4.0),
    ("kale heywet",        4.0),
    ("kale hiwot",         4.0),
    ("meserete kristos",   4.0),
    ("meseret kristos",    4.0),
    ("meseret kirstos",    4.0),
    ("beteseb",            3.0),
    ("full gospel",        3.5),
    ("evangelical",        3.5),
    ("latter-day saints",  4.5),
    ("latter day saints",  4.5),
    ("latter-day",         4.0),
    ("latter day",         4.0),
    ("jesus christ of",    3.5),
    ("mormon",             3.5),
    ("lds church",         4.0),
    ("pentecostal",        3.5),
    ("pentecost",          3.5),
    ("assemblies of god",  4.0),
    ("assembly of god",    4.0),
    ("baptist",            3.5),
    ("lutheran",           3.5),
    ("adventist",          3.5),
    ("seventh day",        3.0),
    ("sda church",         4.0),
    ("methodist",          3.5),
    ("reformed church",    3.0),
    ("protestant",         4.0),
    ("fellowship",         2.0),
    ("worship center",     2.0),
    ("worship centre",     2.0),
    ("bethel church",      2.5),
    ("grace church",       2.0),
    ("life church",        2.0),
    ("mission church",     2.0),
    ("revival church",     2.5),
    ("salvation army",     3.5),
]

_PROTESTANT_REVIEW = [
    ("pastor",             2.0),
    ("sermon",             2.0),
    ("worship team",       2.5),
    ("praise and worship", 2.5),
    ("gospel teaching",    2.0),
    ("fellowship",         1.5),
]

_CATHOLIC_NAME = [
    ("catholic",           4.0),
    ("roman catholic",     4.5),
    ("basilica",           3.5),
    ("parish",             3.0),
    ("diocese",            3.5),
    ("sacred heart",       3.5),
    ("immaculate",         3.5),
    ("our lady",           3.0),
    ("notre dame",         3.0),
    ("st. joseph",         2.5),
    ("saint joseph",       2.5),
    ("franciscan",         3.5),
    ("jesuit",             3.5),
    ("dominican",          3.5),
    ("capuchin",           3.5),
]

_CATHOLIC_REVIEW = [
    ("mass",               2.0),
    ("confession",         2.0),
    ("eucharist",          2.5),
    ("rosary",             2.5),
    ("adoration",          2.0),
    ("bishop",             1.5),
]

_MUSLIM_NAME = [
    ("mosque",             4.0),
    ("masjid",             4.0),
    ("mesjid",             4.0),
    ("jami",               3.0),
    ("jamia",              3.0),
    ("islamic",            4.0),
    ("muslim",             4.0),
    ("salah",              3.0),
    ("musalla",            3.5),
    ("juma",               3.0),
]

_MUSLIM_REVIEW = [
    ("salat",              2.5),
    ("jummah",             2.5),
    ("imam",               2.0),
    ("friday prayer",      3.0),
    ("quran",              2.5),
    ("mosque",             2.0),
]

# Quick-check: a place must contain at least one of these to be considered
# a religious venue at all (avoids scoring coffee shops with "grace" in the name).
_RELIGIOUS_VENUE_ANCHORS = frozenset([
    "church", "chapel", "mosque", "masjid", "mesjid", "temple",
    "synagogue", "hindu_temple", "cathedral", "parish", "monastery",
    "jami", "jamia", "musalla", "prayer hall", "worship hall",
    "worship center", "worship centre",
    "tewahedo", "tewahido", "orthodox", "protestant", "catholic",
    "mekane yesus", "kale heywet", "kale hiwot",
    "meserete kristos", "meseret kristos", "full gospel",
    "evangelical", "pentecostal", "adventist", "islamic",
    "gedam", "kidane", "debre",
    "ቅዱስ", "ቅድስት", "ደብረ", "ቤተ ክርስቲያን", "ቤ/ክ",
])


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _gather_text(place: dict) -> tuple[str, str, str, str, str]:
    """Return (name, tags_type, description, reviews_text, website_url) all lowercased."""
    name    = (place.get("name") or "").lower()
    tags    = " ".join(str(t).lower() for t in (place.get("tags") or []))
    ptype   = (place.get("type") or place.get("category") or "").lower()
    desc    = (place.get("description") or place.get("summary") or "").lower()
    reviews_raw = place.get("reviews") or []
    rev_parts: list[str] = []
    for r in reviews_raw[:8]:
        if isinstance(r, dict):
            rev_parts.append(str(r.get("text", "")).lower())
        elif isinstance(r, str):
            rev_parts.append(r.lower())
    reviews = " ".join(rev_parts)
    website = (place.get("website") or "").lower()
    return name, f"{tags} {ptype}", desc, reviews, website


def _score_keywords(text: str, keyword_weights: list[tuple[str, float]]) -> tuple[float, list[str]]:
    """Return (total_score, list_of_matched_keywords)."""
    total   = 0.0
    matched = []
    for kw, w in keyword_weights:
        if kw in text:
            total += w
            matched.append(kw)
    return total, matched


def _cache_key(place: dict) -> str:
    pid = place.get("id") or place.get("place_id") or place.get("googlePlaceId") or ""
    raw = f"{pid}:{place.get('name','')}"
    return hashlib.sha1(raw.encode()).hexdigest()


def _cache_get(key: str) -> Optional["DenominationResult"]:
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, val = entry
        if time.time() - ts > _CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        return val


def _cache_set(key: str, val: "DenominationResult") -> None:
    with _cache_lock:
        if len(_cache) > 10_000:
            _cache.clear()
        _cache[key] = (time.time(), val)


# ─── OpenAI boost (optional) ──────────────────────────────────────────────────

def _llm_classify(name: str, description: str) -> Optional[dict]:
    """
    Ask GPT to classify the denomination of an ambiguous church.
    Returns {"denomination": str, "confidence": float} or None on failure.
    Only called when keyword scores are ambiguous (leading score < 3).
    """
    try:
        from llm.openai_client import _get_client, is_llm_enabled
        if not is_llm_enabled():
            return None
        client = _get_client()
        if client is None:
            return None
        prompt = (
            "You classify Ethiopian religious venues by denomination.\n"
            "Denominations: orthodox, protestant, catholic, muslim, other.\n"
            "Return ONLY JSON: {\"denomination\": \"...\", \"confidence\": 0.0-1.0}\n\n"
            "Rules:\n"
            "- Tewahedo / Kidus / Debre / Mariam / Selassie / Gebriel / Mikael / "
            "Medhanealem / Kidane Mehret / Ethiopian Orthodox = orthodox\n"
            "- Mekane Yesus / Kale Heywet / Meserete Kristos / Full Gospel / "
            "Evangelical / Pentecostal / Baptist / Lutheran / Adventist = protestant\n"
            "- Catholic / Sacred Heart / Parish / Diocese / Franciscan / Jesuit = catholic\n"
            "- Mosque / Masjid / Jami / Islamic = muslim\n"
            "- If truly unclear, denomination = 'christian', confidence = 0.4\n\n"
            f"Name: {name}\nDescription: {description[:300]}"
        )
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=60,
            temperature=0.0,
            timeout=3.0,
            messages=[
                {"role": "system", "content": "Return only valid JSON."},
                {"role": "user", "content": prompt},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        m = re.search(r"\{[\s\S]*?\}", text)
        if m:
            data = json.loads(m.group(0))
            denom = str(data.get("denomination", "")).lower()
            conf  = float(data.get("confidence", 0.0))
            if denom in ("orthodox", "protestant", "catholic", "muslim", "christian", "other"):
                return {"denomination": denom, "confidence": min(1.0, max(0.0, conf))}
    except Exception as exc:
        logger.debug("[denomination] LLM classify failed: %s", exc)
    return None


# ─── Main classifier ──────────────────────────────────────────────────────────

def classify(place: dict) -> DenominationResult:
    """
    Classify the denomination of a place using weighted keyword scoring.
    OpenAI is used as an optional confidence booster for ambiguous cases.

    Always returns a DenominationResult — never raises.
    """
    ck = _cache_key(place)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    name, tags_type, desc, reviews, website = _gather_text(place)
    full_text = f"{name} {tags_type} {desc} {reviews} {website}"

    # ── Is it even a religious venue? ────────────────────────────────────────
    is_religious = any(anchor in full_text for anchor in _RELIGIOUS_VENUE_ANCHORS)

    if not is_religious:
        result = DenominationResult(
            denomination="other",
            confidence=1.0,
            scores={},
            evidence=["not_a_religious_venue"],
            is_religious=False,
        )
        _cache_set(ck, result)
        return result

    # ── Score each denomination from name + tags ──────────────────────────────
    scores: dict[str, float] = {
        "orthodox": 0.0, "protestant": 0.0, "catholic": 0.0, "muslim": 0.0,
    }
    evidence: list[str] = []

    # Name (highest weight source)
    for denom, kwlist in (
        ("orthodox",   _ORTHODOX_NAME),
        ("protestant", _PROTESTANT_NAME),
        ("catholic",   _CATHOLIC_NAME),
        ("muslim",     _MUSLIM_NAME),
    ):
        s, matched = _score_keywords(name, kwlist)
        if s > 0:
            scores[denom] += s
            evidence.extend(f"name:{kw}" for kw in matched)

    # Tags / type  (scaled down from name)
    for denom, kwlist in (
        ("orthodox",   _ORTHODOX_NAME),
        ("protestant", _PROTESTANT_NAME),
        ("catholic",   _CATHOLIC_NAME),
        ("muslim",     _MUSLIM_NAME),
    ):
        s, matched = _score_keywords(tags_type, kwlist)
        if s > 0:
            scores[denom] += s * 0.7
            evidence.extend(f"tags:{kw}" for kw in matched)

    # Description
    for denom, kwlist in (
        ("orthodox",   _ORTHODOX_NAME),
        ("protestant", _PROTESTANT_NAME),
        ("catholic",   _CATHOLIC_NAME),
        ("muslim",     _MUSLIM_NAME),
    ):
        s, matched = _score_keywords(desc, kwlist)
        if s > 0:
            scores[denom] += s * 0.5
            evidence.extend(f"desc:{kw}" for kw in matched)

    # Reviews
    for denom, kwlist in (
        ("orthodox",   _ORTHODOX_REVIEW),
        ("protestant", _PROTESTANT_REVIEW),
        ("catholic",   _CATHOLIC_REVIEW),
        ("muslim",     _MUSLIM_REVIEW),
    ):
        s, matched = _score_keywords(reviews, kwlist)
        if s > 0:
            scores[denom] += s * 0.4
            evidence.extend(f"review:{kw}" for kw in matched)

    # Website
    website_hits = {
        "orthodox":   any(k in website for k in ("orthodox", "tewahedo", "eotc")),
        "protestant": any(k in website for k in ("mekane", "kale", "meserete", "evangelical")),
        "catholic":   any(k in website for k in ("catholic", "diocese")),
        "muslim":     any(k in website for k in ("mosque", "islamic", "masjid")),
    }
    for denom, hit in website_hits.items():
        if hit:
            scores[denom] += 1.5
            evidence.append(f"website:{denom}")

    # ── Determine winner ─────────────────────────────────────────────────────
    best_denom = max(scores, key=lambda d: scores[d])
    best_score = scores[best_denom]
    total_score = sum(scores.values())

    # Confidence = best / total  (ranges [0.25, 1.0] when 4 categories compete)
    confidence = best_score / total_score if total_score > 0 else 0.0

    # ── OpenAI boost for ambiguous cases ────────────────────────────────────
    # Only call the LLM when leading score is weak (< 3.0) OR close competitor
    second_scores = sorted(scores.values(), reverse=True)
    runner_up = second_scores[1] if len(second_scores) > 1 else 0.0
    is_ambiguous = best_score < 3.0 or (runner_up > 0 and best_score / max(runner_up, 0.01) < 2.0)

    if is_ambiguous:
        llm = _llm_classify(name, desc)
        if llm:
            llm_denom = llm["denomination"]
            llm_conf  = llm["confidence"]
            # If LLM agrees → scale confidence up; if disagrees strongly → trust LLM
            if llm_denom == best_denom:
                confidence = min(1.0, confidence + llm_conf * 0.5)
                evidence.append(f"llm_confirm:{llm_denom}@{llm_conf:.2f}")
            elif llm_conf > 0.80:
                # Strong LLM signal overrides weak keyword result
                best_denom = llm_denom
                confidence = llm_conf
                evidence.append(f"llm_override:{llm_denom}@{llm_conf:.2f}")
            else:
                evidence.append(f"llm_disagree:{llm_denom}@{llm_conf:.2f}")

    # ── Final classification ────────────────────────────────────────────────
    if best_score < MIN_SCORE_TO_CLASSIFY:
        # Not enough evidence — label generic Christian so filter is conservative
        final_denom = "christian"
        confidence  = 0.35
    else:
        final_denom = best_denom

    result = DenominationResult(
        denomination=final_denom,
        confidence=round(confidence, 3),
        scores={k: round(v, 2) for k, v in scores.items()},
        evidence=evidence[:20],   # cap for storage
        is_religious=True,
    )
    _cache_set(ck, result)
    return result


def is_religious_venue(place: dict) -> bool:
    """Quick check without full scoring."""
    name      = (place.get("name") or "").lower()
    ptype     = (place.get("type") or place.get("category") or "").lower()
    combined  = f"{name} {ptype}"
    return any(anchor in combined for anchor in _RELIGIOUS_VENUE_ANCHORS)


def denomination_allowed_for_user(place: dict, user_religion: Optional[str]) -> bool:
    """
    Returns True when the place is allowed for a user with the given religion.

    For non-religious places:       always True.
    For unknown / other religion:   always True (no filter applied).
    Strict rules for Orthodox / Protestant / Catholic / Muslim.
    """
    if not user_religion or user_religion.lower() in ("", "other", "prefer_not_to_say"):
        return True

    result = classify(place)
    if not result.is_religious:
        return True

    u = user_religion.lower().strip()
    d = result.denomination

    if u == "orthodox":
        return d == "orthodox"
    if u == "protestant":
        return d == "protestant"
    if u == "catholic":
        return d == "catholic"
    if u == "muslim":
        return d == "muslim"

    # Fallback: unknown user religion → allow all
    return True
