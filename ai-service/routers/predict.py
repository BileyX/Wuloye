"""
routers/predict.py — POST /predict

Receives a list of candidate places + rich user context (including all
onboarding signals: budget, religion, gender, activities, schedule, lifestyle)
and returns ranked aiScores with match percentages and personalisation insights.

  aiScore = (0.4 × banditScore) + (0.3 × sequenceScore) + (0.3 × embeddingScore)
            + budget_fit_adj + religion_adj + lifestyle_adj + gender_adj + schedule_adj
            + weekend_adj + rag_quality_bump

Contradiction filter: hard-penalises logically invalid combinations
  (cheap user + luxury place, orthodox user + mosque, etc.)

Match percentage: 0–100 score reflecting how many onboarding criteria align.

Graceful degradation:
  Per-candidate failures still emit ai_score=0.5 so the backend can rank
  with rawScore alone and never crashes.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional, Union

from fastapi import APIRouter
from pydantic import BaseModel, Field

import config
from models.bandit     import get_bandit
from models.embeddings import embedding_score
from models.sequence   import get_sequence_model
from store.model_store import get_meta

from pricing import enrich_place
from pricing.dataset import budget_amount_to_tier, budget_label_normalize
from llm import generate_recommendation_reason, is_llm_enabled
from rag import score_keywords as rag_score
from learning.realtime import (
    get_preference_vector,
    get_top_categories,
    generate_explanation as pref_generate_explanation,
)
from denomination.classifier import classify as denom_classify

logger = logging.getLogger(__name__)
router = APIRouter()

# ─── Onboarding-to-place-type intelligence maps ───────────────────────────────

# Maps user's weekly activity keywords → place types that are relevant
ACTIVITY_TO_PLACE_TYPES: dict[str, list[str]] = {
    "gym":         ["gym", "fitness", "sports"],
    "running":     ["gym", "outdoor", "park"],
    "yoga":        ["yoga", "gym", "spa"],
    "hiking":      ["outdoor", "hiking", "park"],
    "cycling":     ["outdoor", "gym", "park"],
    "swimming":    ["gym", "outdoor", "sports"],
    "coffee":      ["coffee", "cafe"],
    "reading":     ["coffee", "cafe", "library"],
    "coding":      ["coffee", "cafe", "workspace", "coworking"],
    "studying":    ["coffee", "cafe", "library", "workspace"],
    "social":      ["social", "restaurant", "bar"],
    "cooking":     ["restaurant", "market"],
    "music":       ["music", "social", "concert"],
    "movies":      ["cinema", "theater"],
    "gaming":      ["social", "cafe"],
    "prayer":      ["church", "mosque", "worship"],
    "meditation":  ["yoga", "outdoor", "park"],
    "shopping":    ["shop", "mall", "market"],
    "art":         ["art", "museum", "gallery"],
    "sports":      ["gym", "sports", "outdoor"],
    "walking":     ["park", "outdoor"],
    "work":        ["workspace", "coworking", "coffee", "cafe"],
    "relax":       ["spa", "coffee", "cafe", "park"],
    "fitness":     ["gym", "yoga", "sports", "outdoor"],
    "travel":      ["hotel", "restaurant", "outdoor"],
}

# Gender-sensitive place types and which gender they lean toward
# Only used to AVOID clearly inappropriate recommendations, not to stereotype
GENDER_SENSITIVE_TYPES: dict[str, str] = {
    "nail_salon":      "female",
    "beauty_salon":    "female",
    "women_salon":     "female",
    "ladies_salon":    "female",
    "barbershop":      "male",
    "barber":          "male",
    "mens_salon":      "male",
}

# Keywords in place name/description that indicate gender-specific venue
FEMALE_PLACE_KEYWORDS = frozenset([
    "ladies only", "women only", "female only", "ladies salon",
    "women's spa", "ladies spa", "girl", "womens",
])
MALE_PLACE_KEYWORDS = frozenset([
    "men only", "gents only", "male only", "barber shop",
    "barbershop", "gents salon", "mens salon",
])

# ─── Request / Response schemas ──────────────────────────────────────────────

class CandidateIn(BaseModel):
    place_id:          str
    place_type:        str
    place_name:        Optional[str] = ""
    place_description: Optional[str] = ""
    rating:            Optional[float] = 3.0
    raw_score:         Optional[float] = 0.0
    address:           Optional[str] = ""
    user_ratings_total: Optional[int] = 0
    price_level:       Optional[Any] = None    # Google priceLevel (0–4 or string)
    tags:              Optional[list[str]] = Field(default_factory=list)
    reviews:           Optional[list[Any]] = Field(default_factory=list)
    image:             Optional[str] = ""

    model_config = {"extra": "ignore"}


class ContextIn(BaseModel):
    time_of_day:        Optional[str]              = "morning"
    session_intent:     Optional[str]              = "explore"
    recent_types:       Optional[list[str]]        = Field(default_factory=list)
    type_affinity:      Optional[dict[str, float]] = Field(default_factory=dict)
    # Onboarding signals — keep in sync with recommendation.service.js callAiService
    budget:             Optional[str]              = ""    # cheap|mid|expensive
    weekly_budget:      Optional[float]            = None  # numeric ETB
    budget_range:       Optional[str]              = ""    # legacy alias
    religion:           Optional[str]              = ""
    gender:             Optional[str]              = ""    # male|female|non_binary|prefer_not_to_say
    weekend_preference: Optional[str]              = ""
    event_interests:    Optional[list[str]]        = Field(default_factory=list)
    interests:          Optional[list[str]]        = Field(default_factory=list)
    weekly_activities:  Optional[list[str]]        = Field(default_factory=list)
    daily_routine:      Optional[dict]             = Field(default_factory=dict)
    # Schedule context (from merged time onboarding step)
    wake_time:          Optional[str]              = ""    # "HH:mm"
    sleep_time:         Optional[str]              = ""    # "HH:mm"
    # working_hours may arrive as a string ("flexible", "09:00-17:00") or as the
    # raw JS object from the profile doc — accept both and normalise to str.
    working_hours:      Optional[Union[str, dict]] = ""
    # Extra pass-through fields from backend (ignored by scoring logic)
    discover_category:  Optional[str]              = None
    # Display
    explain:            Optional[bool]             = False  # set true to fill `reason`

    # Be permissive about unknown keys from future backend versions so a new
    # field never throws 422 and breaks the whole recommendation pipeline.
    model_config = {"extra": "ignore"}


class PredictRequest(BaseModel):
    user_id:    str
    candidates: list[CandidateIn]
    context:    Optional[ContextIn] = None


class RankedPlace(BaseModel):
    place_id:        str
    ai_score:        float
    bandit_score:    float
    sequence_score:  float
    embedding_score: float
    match_percent:   int   = 0      # 0–100 onboarding compatibility score
    # Context-aware pricing
    pricing_enabled: bool           = False
    pricing_reason: Optional[str]  = None
    # Present only when pricing_enabled (optional for JSON null)
    price_level:     Optional[str] = None
    price_confidence: float          = 0.0
    price_signals:   list[str] = Field(default_factory=list)
    estimated_cost:  dict[str, str] = Field(default_factory=dict)
    price_category:  str = "dining"
    # Optional explanation (only populated when context.explain == true)
    reason:          Optional[str] = None
    # Personalisation match flags
    budget_fit:      bool = True
    religion_match:  bool = True
    lifestyle_match: bool = False
    # Denomination classification (for religious venues)
    denomination_type:       Optional[str]   = None  # "orthodox"|"protestant"|"catholic"|"muslim"|"christian"
    denomination_confidence: Optional[float] = None  # 0.0–1.0


class PredictResponse(BaseModel):
    ranked_places:  list[RankedPlace]
    model_version:  str
    inference_ms:   int
    predicted_type: Optional[str]  = None
    confidence:     float          = 0.0
    llm_enabled:    bool           = False


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _resolve_budget_tier(ctx: ContextIn) -> str:
    """Normalise the various budget inputs to 'cheap|mid|expensive'."""
    if ctx.budget:
        return budget_label_normalize(ctx.budget)
    if ctx.weekly_budget is not None:
        return budget_amount_to_tier(ctx.weekly_budget)
    if ctx.budget_range:
        return budget_label_normalize(ctx.budget_range)
    return "mid"


def _budget_fit_score(user_tier: str, place_tier: str) -> tuple[float, bool]:
    """
    Returns (score_adjustment, strictly_in_budget_flag).
    Same tier → +0.06 boost.  One tier above → −0.10 penalty.  Two tiers above → −0.30 penalty.
    """
    if not place_tier or not user_tier:
        return 0.0, True
    order = {"cheap": 0, "mid": 1, "expensive": 2}
    a = order.get(user_tier, 1)
    b = order.get(place_tier, 1)
    diff = b - a  # positive = place is more expensive than user can afford
    if diff <= 0:
        return 0.06, True     # same tier or cheaper → positive fit signal
    if diff == 1:
        return -0.10, False   # one tier above → noticeable penalty
    return -0.30, False       # two tiers above (cheap user at luxury) → strong penalty


def _get_place_religion(place_text: str, ptype: str) -> str:
    """
    Classify a place's religion from its text + type.
    Delegates to the denomination classifier for full accuracy.
    """
    result = denom_classify({"name": place_text, "type": ptype, "description": ""})
    return result.denomination if result.is_religious else ""


def _religion_allowed(user_religion: str, place_religion: str) -> bool:
    """Returns True if the place's religion is compatible with the user's."""
    if not place_religion or place_religion == "other":
        return True  # non-religious place → always allowed
    r = user_religion.lower()
    if r in ("", "other", "prefer_not_to_say"):
        return True
    if r == "orthodox":
        return place_religion == "orthodox"
    if r == "protestant":
        return place_religion == "protestant"
    if r == "catholic":
        return place_religion == "catholic"
    if r == "muslim":
        return place_religion == "muslim"
    return True


def _lifestyle_score(place_type: str, weekly_activities: list[str], interests: list[str]) -> float:
    """
    Returns a boost in [0.0, 0.12] when the place type aligns with the user's
    declared weekly activities or interests.
    """
    if not weekly_activities and not interests:
        return 0.0
    ptype = place_type.lower()
    combined = [a.lower() for a in (weekly_activities or []) + (interests or [])]
    matched_activities = 0
    for activity in combined:
        related_types = ACTIVITY_TO_PLACE_TYPES.get(activity, [])
        if ptype in related_types:
            matched_activities += 1
    if matched_activities == 0:
        return 0.0
    # Each matching activity contributes up to 0.04, capped at 0.12
    return min(0.12, matched_activities * 0.04)


def _gender_score(candidate: "CandidateIn", gender: str) -> float:
    """
    Returns a penalty in [-0.20, 0.0] when the place is clearly gender-specific
    and mismatches the user's gender. Never penalises neutral places.
    """
    if not gender or gender in ("prefer_not_to_say", "non_binary", ""):
        return 0.0

    ptype = candidate.place_type.lower()
    place_text = f"{(candidate.place_name or '').lower()} {(candidate.place_description or '').lower()}"

    # Check type-level sensitivity
    lean = GENDER_SENSITIVE_TYPES.get(ptype, "")

    # Check keyword-level sensitivity
    has_female_kw = any(kw in place_text for kw in FEMALE_PLACE_KEYWORDS)
    has_male_kw   = any(kw in place_text for kw in MALE_PLACE_KEYWORDS)

    user_gender = gender.lower()
    is_female_place = lean == "female" or has_female_kw
    is_male_place   = lean == "male"   or has_male_kw

    if is_female_place and user_gender == "male":
        return -0.20
    if is_male_place and user_gender == "female":
        return -0.20

    return 0.0


def _schedule_fit_score(ptype: str, time_of_day: str, wake_time: str, sleep_time: str) -> float:
    """
    Returns a penalty in [-0.08, 0.0] when the recommended place type conflicts
    with the user's sleep/wake schedule.
    E.g. a gym recommendation late at night when the user sleeps at 22:00.
    """
    if not wake_time and not sleep_time:
        return 0.0

    def parse_hour(t: str) -> Optional[int]:
        try:
            parts = t.strip().split(":")
            return int(parts[0])
        except Exception:
            return None

    tod = (time_of_day or "").lower()
    if tod not in ("night", "evening"):
        return 0.0  # only care about late hours

    sleep_h = parse_hour(sleep_time) if sleep_time else None

    # If user sleeps early (before 23:00) and we are recommending at night
    if sleep_h is not None and sleep_h < 23 and tod == "night":
        if ptype in ("gym", "yoga", "outdoor", "hiking"):
            return -0.08  # gym at midnight for early-sleeper = wrong
        if ptype in ("coffee", "cafe") and sleep_h < 21:
            return -0.05  # coffee at midnight for very early sleeper

    return 0.0


def _compute_match_percent(
    budget_fit: bool,
    religion_match: bool,
    lifestyle_match: bool,
    gender_adj: float,
    schedule_adj: float,
    ai_score: float,
) -> int:
    """
    Computes a human-readable 0–100 compatibility percentage from individual signals.
    """
    score = 0
    total = 0

    # Budget (weight 25)
    total += 25
    if budget_fit:
        score += 25

    # Religion (weight 25)
    total += 25
    if religion_match:
        score += 25

    # Lifestyle / activity match (weight 20)
    total += 20
    if lifestyle_match:
        score += 20

    # Gender fit (weight 10)
    total += 10
    if gender_adj >= 0:
        score += 10

    # Schedule fit (weight 10)
    total += 10
    if schedule_adj >= 0:
        score += 10

    # AI model quality (weight 10)
    total += 10
    score += int(ai_score * 10)

    return min(100, round(score / total * 100))


# ─── Per-candidate scoring ────────────────────────────────────────────────────

def _preference_boost(user_id: str, place_type: str, time_of_day: str) -> float:
    """
    Boost derived from the user's dynamic in-memory preference vector.
    Returns a value in [-0.10, +0.15].

    Positive affinity (> 0.65) → small boost.
    Negative affinity (< 0.35) → penalty.
    Time-slotted affinity is blended in for time-aware recommendations.
    """
    vec = get_preference_vector(user_id)
    if not vec:
        return 0.0

    base = vec.get(place_type, 0.5)
    slot_key = f"{place_type}_{time_of_day}" if time_of_day else None
    slot_val = vec.get(slot_key, base) if slot_key else base

    # Blend base + time slot
    blended = 0.6 * base + 0.4 * slot_val

    if blended >= 0.80:
        return 0.12
    if blended >= 0.65:
        return 0.07
    if blended >= 0.55:
        return 0.03
    if blended <= 0.25:
        return -0.10
    if blended <= 0.38:
        return -0.05
    return 0.0


def _score_candidate(
    user_id:           str,
    candidate:         CandidateIn,
    context:           ContextIn,
    seq_dist:          dict[str, float],
    interaction_types: list[str],
    user_budget_tier:  str,
) -> RankedPlace:
    """
    Full onboarding-driven + adaptive scoring pipeline.

    Steps:
      1. Bandit + sequence + embedding base scores
      2. Dynamic preference vector boost (real-time interaction learning)
      3. Budget fit / contradiction penalty
      4. Religion hard filter (contradiction → near-zero)
      5. Lifestyle / activity alignment boost
      6. Gender context scoring
      7. Schedule awareness (sleep/wake time)
      8. Weekend preference boost
      9. RAG quality bump
      10. Match percentage calculation
      11. Adaptive explanation (preference vector → LLM fallback)
    """
    try:
        ptype = candidate.place_type.lower()

        # ── 1. Bandit score ─────────────────────────────────────────────────
        bandit  = get_bandit()
        b_score = bandit.bandit_score(user_id, candidate.place_type)

        # ── 2. Sequence score ───────────────────────────────────────────────
        s_score = seq_dist.get(candidate.place_type, 1.0 / max(len(config.PLACE_TYPES), 1))

        # ── 3. Embedding score (with type-affinity fallback) ────────────────
        type_aff = (context.type_affinity or {}).get(candidate.place_type, 0.5)
        e_score  = embedding_score(
            user_id,
            candidate.place_id,
            candidate.place_name or "",
            candidate.place_description or "",
            interaction_types,
        )
        if e_score == 0.5 and type_aff != 0.5:
            e_score = type_aff

        # ── 4. Weighted combination ─────────────────────────────────────────
        ai = (
            config.BANDIT_WEIGHT    * b_score +
            config.SEQUENCE_WEIGHT  * s_score +
            config.EMBEDDING_WEIGHT * e_score
        )

        # ── 4b. Dynamic preference vector boost (real-time learning) ────────
        pref_adj = _preference_boost(user_id, ptype, context.time_of_day or "morning")
        ai = max(0.0, min(1.0, ai + pref_adj))

        # ── 5. Pricing enrichment ───────────────────────────────────────────
        place_dict: dict[str, Any] = {
            "id":               candidate.place_id,
            "name":             candidate.place_name or "",
            "type":             candidate.place_type,
            "description":      candidate.place_description or "",
            "address":          candidate.address or "",
            "rating":           candidate.rating,
            "userRatingsTotal": candidate.user_ratings_total or 0,
            "priceLevel":       candidate.price_level,
            "tags":             candidate.tags or [],
            "reviews":          candidate.reviews or [],
        }
        enrichment = enrich_place(place_dict)
        pricing_on = bool(enrichment.get("pricing_enabled"))
        place_tier = enrichment.get("priceLevel") or "mid"

        # ── 6. Budget-fit scoring ───────────────────────────────────────────
        if pricing_on:
            budget_adj, in_budget = _budget_fit_score(user_budget_tier, place_tier)
            ai += budget_adj
            in_budget_final = in_budget
        else:
            in_budget_final = True

        # ── 7. Religion matching — denomination-aware contradiction filter ─────
        religion = (context.religion or "").lower()
        religion_match_flag = True
        denom_type: Optional[str] = None
        denom_confidence: float = 0.0

        place_for_denom = {
            "id":          candidate.place_id,
            "name":        candidate.place_name or "",
            "type":        ptype,
            "description": candidate.place_description or "",
            "tags":        candidate.tags or [],
        }
        denom_result = denom_classify(place_for_denom)
        denom_type        = denom_result.denomination
        denom_confidence  = denom_result.confidence

        if denom_result.is_religious and religion and religion not in ("", "prefer_not_to_say", "other"):
            religion_allowed = _religion_allowed(religion, denom_type)

            if religion_allowed:
                # Matching denomination → boost proportional to classifier confidence
                boost = 0.06 + 0.06 * denom_confidence
                ai = min(1.0, ai + boost)
                religion_match_flag = True
            else:
                # CONTRADICTION: wrong denomination → hard penalty
                # Scaled by confidence so a weak "catholic?" label doesn't crush ambiguous places
                penalty = 0.30 + 0.20 * denom_confidence
                ai = max(0.0, ai - penalty)
                religion_match_flag = False

        # ── 8. Lifestyle / activity alignment ──────────────────────────────
        lifestyle_adj = _lifestyle_score(
            ptype,
            context.weekly_activities or [],
            (context.interests or []) + (context.event_interests or []),
        )
        lifestyle_match_flag = lifestyle_adj > 0.0
        ai = min(1.0, ai + lifestyle_adj)

        # ── 9. Gender context scoring ───────────────────────────────────────
        gender_adj = _gender_score(candidate, context.gender or "")
        ai = max(0.0, ai + gender_adj)

        # ── 10. Schedule fit (wake/sleep awareness) ─────────────────────────
        schedule_adj = _schedule_fit_score(
            ptype,
            context.time_of_day or "morning",
            context.wake_time or "",
            context.sleep_time or "",
        )
        ai = max(0.0, ai + schedule_adj)

        # ── 11. Weekend preference boost ────────────────────────────────────
        wp = (context.weekend_preference or "").lower()
        if wp == "outdoor" and ptype in ("outdoor", "hiking", "park", "sports"):
            ai = min(1.0, ai + 0.05)
        elif wp == "hiking" and ptype in ("hiking", "outdoor", "park"):
            ai = min(1.0, ai + 0.06)
        elif wp == "indoor" and ptype in ("cinema", "museum", "art", "coffee", "cafe", "workspace"):
            ai = min(1.0, ai + 0.04)
        elif wp == "coffee" and ptype in ("coffee", "cafe"):
            ai = min(1.0, ai + 0.05)
        elif wp == "social" and ptype in ("social", "restaurant", "bar"):
            ai = min(1.0, ai + 0.04)

        # ── 12. RAG quality bump ────────────────────────────────────────────
        rag = rag_score(place_dict)
        ai  = min(1.0, ai + 0.02 * rag.get("quality_score", 0.0))

        ai = round(max(0.0, min(1.0, ai)), 4)

        # ── 13. Match percentage ─────────────────────────────────────────────
        match_pct = _compute_match_percent(
            budget_fit      = in_budget_final,
            religion_match  = religion_match_flag,
            lifestyle_match = lifestyle_match_flag,
            gender_adj      = gender_adj,
            schedule_adj    = schedule_adj,
            ai_score        = ai,
        )

        # ── 14. Explanation: preference vector first, LLM fallback ──────────
        reason: Optional[str] = None
        if context.explain:
            # Try fast preference-vector based explanation first
            reason = pref_generate_explanation(user_id, ptype)

            # Fallback: generate from onboarding signals via LLM/template
            if not reason:
                top_cats = get_top_categories(user_id, 3)
                user_signals = {
                    "budget":             user_budget_tier,
                    "interests":          context.interests or [c for c, _ in top_cats],
                    "weeklyActivities":   context.weekly_activities or [],
                    "weekendPreference":  context.weekend_preference or "",
                    "religion":           context.religion or "",
                    "gender":             context.gender or "",
                    "session_intent":     context.session_intent or "",
                    "time_of_day":        context.time_of_day or "",
                    "wake_time":          context.wake_time or "",
                    "sleep_time":         context.sleep_time or "",
                    "top_categories":     [c for c, _ in top_cats],
                }
                place_for_llm = {
                    **place_dict,
                    "pricing_enabled": pricing_on,
                    "priceLevel":     enrichment.get("priceLevel"),
                    "estimatedCost":  enrichment["estimatedCost"] if pricing_on else {},
                }
                reason = generate_recommendation_reason(user_signals, place_for_llm, max_chars=180)

        return RankedPlace(
            place_id         = candidate.place_id,
            ai_score         = ai,
            bandit_score     = round(b_score, 4),
            sequence_score   = round(s_score, 4),
            embedding_score  = round(e_score, 4),
            match_percent    = match_pct,
            pricing_enabled  = pricing_on,
            pricing_reason   = enrichment.get("pricing_reason"),
            price_level      = enrichment["priceLevel"] if pricing_on else None,
            price_confidence = round(enrichment["priceConfidence"], 3),
            price_signals    = enrichment["priceSignals"],
            estimated_cost   = enrichment["estimatedCost"],
            price_category   = enrichment["priceCategory"],
            reason           = reason,
            budget_fit       = in_budget_final,
            religion_match   = religion_match_flag,
            lifestyle_match  = lifestyle_match_flag,
            denomination_type        = denom_type if denom_result.is_religious else None,
            denomination_confidence  = round(denom_confidence, 3) if denom_result.is_religious else None,
        )

    except Exception as exc:
        logger.warning("[predict] candidate %s failed: %s", candidate.place_id, exc)
        return RankedPlace(
            place_id=candidate.place_id,
            ai_score=0.5,
            bandit_score=0.5,
            sequence_score=0.5,
            embedding_score=0.5,
            match_percent=50,
            pricing_enabled=False,
            budget_fit=True,
            religion_match=True,
            lifestyle_match=False,
        )


# ─── Route ───────────────────────────────────────────────────────────────────

@router.post("/predict", response_model=PredictResponse, tags=["Inference"])
def predict(req: PredictRequest) -> PredictResponse:
    """
    Score and rank candidate places.

    The backend should merge:
      finalScore = 0.7 × rawScore + 0.3 × aiScore
    """
    t0 = time.perf_counter()

    ctx  = req.context or ContextIn()
    meta = get_meta()
    user_budget_tier = _resolve_budget_tier(ctx)

    # Pre-compute sequence distribution once for this request
    seq_model    = get_sequence_model()
    recent_types = ctx.recent_types or []
    seq_dist     = seq_model.predict_distribution(recent_types)
    interaction_types = recent_types

    results = [
        _score_candidate(
            req.user_id, cand, ctx, seq_dist, interaction_types, user_budget_tier,
        )
        for cand in req.candidates
    ]

    # Sort descending by ai_score
    results.sort(key=lambda r: r.ai_score, reverse=True)

    # Top predicted type from sequence model
    predicted_type: Optional[str] = None
    confidence: float = 0.0
    if seq_dist:
        predicted_type = max(seq_dist, key=seq_dist.__getitem__)
        confidence     = round(seq_dist[predicted_type], 4)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    if elapsed_ms > 800:
        logger.warning(
            "[predict] slow inference: %d ms for %d candidates (explain=%s)",
            elapsed_ms, len(results), bool(ctx.explain),
        )

    logger.info(
        "[predict] uid=%s candidates=%d top=%.3f match=%d%% budget=%s religion=%s gender=%s "
        "activities=%d weekend=%s elapsed=%dms",
        req.user_id, len(results),
        results[0].ai_score if results else 0.0,
        results[0].match_percent if results else 0,
        user_budget_tier or "—",
        ctx.religion or "—",
        ctx.gender or "—",
        len(ctx.weekly_activities or []),
        ctx.weekend_preference or "—",
        elapsed_ms,
    )

    return PredictResponse(
        ranked_places  = results,
        model_version  = meta.get("version", "v0"),
        inference_ms   = elapsed_ms,
        predicted_type = predicted_type,
        confidence     = confidence,
        llm_enabled    = is_llm_enabled(),
    )
