"""
routers/events.py — POST /events/rank

Ranks candidate events using the user's full onboarding profile.

Scoring pipeline:
  1. Category affinity (typeAffinity)                        weight 0.35
  2. Interest + eventInterest + weeklyActivity keyword match  weight 0.30
  3. Temporal relevance (sooner = better)                    weight 0.20
  4. Religion denomination match / HARD BLOCK                ±bonus
  5. Weekend preference boost                                +bonus
  6. Budget awareness (free vs paid events)                  +bonus / penalty
  7. Gender context (skip gender-exclusive events)           penalty

Hard contradiction rules:
  - Orthodox user → mosque / islamic events scored near-zero
  - Muslim user → church / christian events scored near-zero
  - Protestant / Catholic user → mosque scored near-zero
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Events"])

# ─── Activity → event category mapping ────────────────────────────────────────

ACTIVITY_TO_EVENT_CATEGORIES: dict[str, list[str]] = {
    "gym":        ["fitness", "sports", "health", "wellness"],
    "running":    ["fitness", "sports", "outdoor"],
    "yoga":       ["wellness", "fitness", "health"],
    "hiking":     ["outdoor", "adventure", "nature"],
    "cycling":    ["sports", "outdoor", "fitness"],
    "music":      ["music", "concert", "entertainment"],
    "art":        ["art", "culture", "gallery", "museum"],
    "coding":     ["tech", "technology", "workshop", "education"],
    "studying":   ["education", "workshop", "seminar"],
    "social":     ["social", "networking", "community"],
    "cooking":    ["food", "culinary", "cooking"],
    "movies":     ["cinema", "entertainment", "film"],
    "gaming":     ["gaming", "tech", "entertainment"],
    "prayer":     ["religious", "church", "mosque", "worship", "faith"],
    "meditation": ["wellness", "spiritual", "mindfulness"],
    "shopping":   ["shopping", "market", "sale", "expo"],
    "walking":    ["outdoor", "nature", "community"],
    "sports":     ["sports", "fitness", "athletic"],
    "reading":    ["education", "book", "culture"],
    "travel":     ["travel", "culture", "adventure"],
}

# ─── Religion classification helpers ──────────────────────────────────────────

MOSQUE_KEYWORDS    = frozenset(["mosque", "masjid", "mesjid", "jami", "jamia", "muslim", "islamic", "ramadan", "eid al", "eid ul", "salah", "quran"])
ORTHODOX_KEYWORDS  = frozenset(["orthodox", "debre", "kidus", "kidist", "kiddis", "bete christian", "giorgis", "medhanealem", "timkat", "meskel"])
PROTESTANT_KEYWORDS = frozenset(["protestant", "evangelical", "mekane yesus", "kale hiwot", "seventh", "adventist", "pentecost", "full gospel", "baptist"])
CATHOLIC_KEYWORDS  = frozenset(["catholic", "franciscan", "jesuit", "roman church"])
CHRISTIAN_KEYWORDS = frozenset(["church", "chapel", "worship", "prayer hall", "christian", "christmas", "easter"])


def _classify_event_religion(title: str, description: str, category: str) -> str:
    """Returns 'muslim' | 'orthodox' | 'protestant' | 'catholic' | 'christian' | ''."""
    text = f"{title} {description} {category}".lower()
    if any(k in text for k in MOSQUE_KEYWORDS):
        return "muslim"
    if any(k in text for k in ORTHODOX_KEYWORDS):
        return "orthodox"
    if any(k in text for k in PROTESTANT_KEYWORDS):
        return "protestant"
    if any(k in text for k in CATHOLIC_KEYWORDS):
        return "catholic"
    cat = category.lower()
    if cat in ("religious", "church", "worship", "faith") or any(k in text for k in CHRISTIAN_KEYWORDS):
        return "christian"
    return ""


def _religion_event_score(user_religion: str, event_religion: str) -> float:
    """
    Returns score adjustment for religion matching.
      Match:         +0.10 strong boost
      Compatible:    +0.03 small boost
      No religion:    0.00 neutral
      Contradiction: -0.50 hard penalty (contradictory = near zero)
    """
    if not event_religion:
        return 0.0  # secular event → no religion adjustment

    r = (user_religion or "").lower()
    if not r or r in ("other", "prefer_not_to_say"):
        return 0.0  # user has no preference → all events visible

    if r == "orthodox":
        if event_religion == "orthodox":
            return 0.10
        if event_religion == "christian":
            return 0.03
        return -0.50  # muslim/protestant/catholic events → hard penalty

    if r == "protestant":
        if event_religion == "protestant":
            return 0.10
        if event_religion == "christian":
            return 0.03
        return -0.50

    if r == "catholic":
        if event_religion == "catholic":
            return 0.10
        if event_religion == "christian":
            return 0.03
        return -0.50

    if r == "muslim":
        if event_religion == "muslim":
            return 0.10
        return -0.50  # christian events → hard penalty for muslim users

    return 0.0


# ─── Request / Response schemas ───────────────────────────────────────────────

class UserProfile(BaseModel):
    interests:         list[str]         = Field(default_factory=list)
    typeAffinity:      dict[str, float]  = Field(default_factory=dict)
    religion:          str               = ""
    gender:            str               = ""       # male|female|non_binary|prefer_not_to_say
    weekendPreference: str               = ""
    eventInterests:    list[str]         = Field(default_factory=list)
    weeklyActivities:  list[str]         = Field(default_factory=list)
    dailyRoutine:      dict              = Field(default_factory=dict)
    budgetTier:        str               = ""       # cheap|mid|expensive
    weeklyBudget:      float             = 0.0      # numeric ETB


class InteractionMemory(BaseModel):
    """Lightweight memory derived from the user's recent event interactions."""
    saved_event_ids:      list[str]       = Field(default_factory=list)
    dismissed_event_ids:  list[str]       = Field(default_factory=list)
    opened_event_ids:     list[str]       = Field(default_factory=list)
    liked_categories:     dict[str, float] = Field(default_factory=dict)
    dismissed_categories: dict[str, float] = Field(default_factory=dict)


class EventCandidate(BaseModel):
    id:           str
    title:        str
    category:     str  = "other"
    date:         str  = ""
    location:     str  = ""
    description:  str  = ""
    image:        str  = ""
    source_url:   str  = ""
    source:       str  = ""
    is_paid:      bool = False    # true when the event has an entry fee
    price_tier:   str  = ""       # cheap|mid|expensive (optional)
    ticket_price: str  = ""       # display string (e.g. "ETB 500", "Free")
    organizer:    str  = ""


class RankEventsRequest(BaseModel):
    user_id:      str                = ""
    user_profile: UserProfile        = UserProfile()
    memory:       InteractionMemory  = InteractionMemory()
    events:       list[EventCandidate] = Field(default_factory=list)


# ─── Scoring helpers ──────────────────────────────────────────────────────────

def _days_until(iso_date: str) -> float:
    if not iso_date:
        return 30.0
    try:
        event_dt = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return (event_dt - now).total_seconds() / 86400.0
    except Exception:
        return 30.0


def _activity_event_match(weekly_activities: list[str], event_title: str, event_desc: str, event_cat: str) -> float:
    """Returns 0–0.12 boost based on how many of the user's weekly activities match the event."""
    if not weekly_activities:
        return 0.0
    text = f"{event_title} {event_desc} {event_cat}".lower()
    matched = 0
    total   = len(weekly_activities)
    for activity in weekly_activities:
        related_cats = ACTIVITY_TO_EVENT_CATEGORIES.get(activity.lower(), [activity.lower()])
        if any(cat in text for cat in related_cats):
            matched += 1
    if matched == 0:
        return 0.0
    return min(0.12, (matched / total) * 0.20)


def _trusted_source_score(source: str) -> tuple[float, str]:
    """Boost structured ticketing platforms over Telegram scrapes."""
    s = (source or "").lower()
    if "chapa_events" in s:
        return 0.12, "from Chapa Events"
    if "eventbrite" in s:
        return 0.07, "on Eventbrite"
    if s.startswith("meetup"):
        return 0.06, "on Meetup"
    if "eth_local" in s:
        return 0.04, "local venue listing"
    if s.startswith("telegram_"):
        return -0.04, ""
    return 0.0, ""


def _parse_etb_price(ticket_price: str) -> float | None:
    """Extract numeric ETB value from a display string like 'ETB 500' or 'USD 20'."""
    if not ticket_price:
        return None
    t = ticket_price.lower().strip()
    if t in ("free", "free entry", "gratis"):
        return 0.0
    import re as _re
    m = _re.search(r"([\d][\d,\.]*)", ticket_price)
    if not m:
        return None
    try:
        val = float(m.group(1).replace(",", ""))
        if "usd" in t or "$" in ticket_price:
            val *= 130.0  # rough ETB conversion
        return val
    except ValueError:
        return None


def _budget_event_score(user_budget_tier: str, event: EventCandidate) -> float:
    """
    Returns a score adjustment for budget fit.

    Thresholds aligned with unified weekly budget tiers:
      cheap     (≤ 2,000 ETB/wk) → free events strongly preferred; expensive = hard block
      mid       (2,001–10,000 ETB/wk) → ETB 0–3000 fine; above ETB 5000 = penalty
      expensive (> 10,000 ETB/wk) → no hard restrictions
    """
    if not user_budget_tier:
        return 0.0

    etb = _parse_etb_price(event.ticket_price)
    is_free = (etb is not None and etb == 0.0) or not event.is_paid

    if user_budget_tier == "cheap":
        if is_free:
            return 0.12   # strong boost for free events
        if etb is not None:
            if etb <= 200:
                return 0.08   # very cheap ticket
            if etb <= 500:
                return 0.04
            if etb <= 1000:
                return -0.08
            if etb <= 2500:
                return -0.25  # too expensive for cheap user
            return -0.50      # hard near-block: luxury event for cheap user
        # No numeric price — fall back to price_tier label
        event_tier = (event.price_tier or "mid").lower()
        if event_tier == "cheap":
            return 0.06
        if event_tier == "mid":
            return -0.12
        return -0.40          # expensive tier for cheap user

    if user_budget_tier == "mid":
        if is_free:
            return 0.06
        if etb is not None:
            if etb <= 1000:
                return 0.06
            if etb <= 3000:
                return 0.03
            if etb <= 5000:
                return -0.05
            if etb <= 8000:
                return -0.12
            return -0.25      # very expensive for mid user
        event_tier = (event.price_tier or "mid").lower()
        if event_tier == "cheap":
            return 0.06
        if event_tier == "mid":
            return 0.03
        return -0.15          # expensive tier for mid user

    # expensive budget — accept everything, small boost for paid premium
    if event.is_paid and (event.price_tier or "").lower() == "expensive":
        return 0.05
    return 0.02


def _gender_event_score(user_gender: str, event_text: str) -> float:
    """Returns penalty when event is clearly for a different gender."""
    if not user_gender or user_gender in ("prefer_not_to_say", "non_binary", ""):
        return 0.0
    text = event_text.lower()
    female_kw = ("ladies only", "women only", "female only", "women's event", "ladies event")
    male_kw   = ("men only", "gents only", "male only", "mens event")
    if user_gender == "male" and any(k in text for k in female_kw):
        return -0.20
    if user_gender == "female" and any(k in text for k in male_kw):
        return -0.20
    return 0.0


def _daily_routine_event_match(daily_routine: dict, event: EventCandidate) -> float:
    """
    Boost events that align with daily routine slots.
    daily_routine keys: morning / afternoon / evening / night → list of activity strings.
    """
    if not daily_routine:
        return 0.0
    all_acts: list[str] = []
    for activities in daily_routine.values():
        if isinstance(activities, list):
            all_acts.extend(activities)
    if not all_acts:
        return 0.0
    return _activity_event_match(all_acts, event.title, event.description, event.category)


def _score_event(
    event: EventCandidate,
    profile: UserProfile,
    memory: "InteractionMemory",
) -> tuple[float, list[str]]:
    """
    Full onboarding-driven event scoring.
    Returns (score, reasons[]) where reasons describe which boosts fired.

    Weight budget:
      0.30 — category affinity (typeAffinity)
      0.25 — interest + eventInterest keyword match
      0.18 — temporal relevance (sooner = better)
      0.12 — trusted source signal
      0.15 — religion / budget / gender / weekly routine bonuses
    """
    score = 0.0
    reasons: list[str] = []

    # 1. Type affinity (from onboarding place-type + explicit event affinity)
    raw_affinity = profile.typeAffinity.get(event.category, 0.0)
    # Normalise: backend sometimes sends -100..100 Elo-style scores
    if raw_affinity > 1.0 or raw_affinity < 0.0:
        affinity = (raw_affinity + 50.0) / 100.0
    else:
        affinity = raw_affinity
    affinity = max(0.0, min(affinity, 1.0))
    score += 0.30 * affinity
    if affinity >= 0.55:
        reasons.append(f"matches your {event.category} interests")

    # 2. Interest keyword match (interests + eventInterests combined)
    text = f"{event.title} {event.description} {event.category}".lower()
    all_interests = list(profile.interests) + list(profile.eventInterests)
    matched_terms: list[str] = []
    if all_interests:
        for i in all_interests:
            kw = (i or "").lower()
            if kw and len(kw) >= 3 and kw in text:
                matched_terms.append(i)
        interest_ratio = min(len(matched_terms) / max(len(all_interests), 1), 1.0)
        score += 0.25 * interest_ratio
        if matched_terms:
            head = ", ".join(matched_terms[:2])
            reasons.append(f"aligns with {head}")

    # 3. Weekly activity alignment
    act_boost = _activity_event_match(
        profile.weeklyActivities, event.title, event.description, event.category
    )
    # Daily routine alignment (additive)
    routine_boost = _daily_routine_event_match(profile.dailyRoutine, event)
    combined_act = min(0.14, act_boost + routine_boost * 0.5)
    if combined_act > 0:
        score = min(1.0, score + combined_act)
        reasons.append("fits your daily routine")

    # 4. Temporal relevance — sooner is better, capped at 18% contribution
    days = _days_until(event.date)
    if days < 0:
        temporal = 0.0
    elif days <= 3:
        temporal = 1.0
    elif days <= 14:
        temporal = 0.85 - (days / 14.0) * 0.25
    elif days <= 30:
        temporal = 0.55
    elif days <= 60:
        temporal = 0.35
    else:
        temporal = 0.15
    score += 0.18 * temporal
    if 0 <= days <= 2:
        reasons.append("happening very soon")
    elif 0 <= days <= 7:
        reasons.append("this week")
    elif 0 <= days <= 14:
        reasons.append("coming up soon")

    # 5. Religion match / hard filter
    event_religion = _classify_event_religion(event.title, event.description, event.category)
    rel_adj = _religion_event_score(profile.religion, event_religion)
    if rel_adj <= -0.4:
        reasons.append("filtered by faith preference")
    elif rel_adj >= 0.05 and event_religion:
        reasons.append(f"matches your {event_religion} community")
    score = max(0.0, min(1.0, score + rel_adj))

    # 6. Weekend preference boost
    wp  = (profile.weekendPreference or "").lower()
    cat = event.category.lower()
    weekend_kw = {
        "outdoor":  ("outdoor", "hiking", "sports", "nature", "fitness"),
        "hiking":   ("hiking", "outdoor", "nature", "fitness"),
        "indoor":   ("indoor", "cinema", "art", "museum", "workshop", "tech", "food", "music"),
        "social":   ("social", "networking", "community", "food", "music"),
    }
    if wp in weekend_kw and cat in weekend_kw[wp]:
        bonus = 0.07 if wp in ("outdoor", "hiking") else 0.06
        score = min(1.0, score + bonus)
        reasons.append("ideal for your weekends")

    # 7. Budget awareness (stronger penalty for mismatches)
    budget_tier = (profile.budgetTier or "").lower()
    if not budget_tier and profile.weeklyBudget:
        if profile.weeklyBudget <= 2000:
            budget_tier = "cheap"
        elif profile.weeklyBudget <= 10000:
            budget_tier = "mid"
        else:
            budget_tier = "expensive"
    bud_adj = _budget_event_score(budget_tier, event)
    if bud_adj <= -0.35:
        reasons.append("over budget")
    elif bud_adj <= -0.08:
        reasons.append("may be over budget")
    elif bud_adj >= 0.06 and not event.is_paid:
        reasons.append("free to attend")
    elif bud_adj >= 0.03:
        reasons.append("within your budget")
    score = max(0.0, min(1.0, score + bud_adj))

    # Hard caps: cheap users must never receive high scores for expensive events
    _budget_order = {"cheap": 0, "mid": 1, "expensive": 2}
    _u_level = _budget_order.get(budget_tier, 1)
    _e_tier  = (event.price_tier or "mid").lower()
    _e_level = _budget_order.get(_e_tier, 1)
    if _u_level == 0 and _e_level == 2:
        score = min(score, 0.10)
    elif _u_level == 0 and _e_level == 1 and event.is_paid:
        score = min(score, 0.40)

    # 8. Gender context
    gender_adj = _gender_event_score(profile.gender, text)
    score = max(0.0, score + gender_adj)

    # 9. Interaction memory — boost saved categories, dampen dismissed ones
    if memory.saved_event_ids and event.id in memory.saved_event_ids:
        score = min(1.0, score + 0.06)
        reasons.append("saved earlier")
    if memory.dismissed_event_ids and event.id in memory.dismissed_event_ids:
        score = max(0.0, score - 0.50)
    if memory.opened_event_ids and event.id in memory.opened_event_ids:
        score = min(1.0, score + 0.03)
    if memory.liked_categories:
        boost = memory.liked_categories.get(event.category, 0.0)
        if boost > 0:
            score = min(1.0, score + min(boost, 0.10))
            if boost >= 0.20:
                reasons.append("similar to events you've saved")
    if memory.dismissed_categories:
        pen = memory.dismissed_categories.get(event.category, 0.0)
        if pen > 0:
            score = max(0.0, score - min(pen, 0.18))

    # 10. Trusted source signal (Chapa Events, Eventbrite, Meetup > Telegram)
    trust_adj, trust_reason = _trusted_source_score(event.source)
    if trust_adj > 0:
        score = min(1.0, score + trust_adj)
        if trust_reason:
            reasons.append(trust_reason)
    elif trust_adj < 0:
        score = max(0.0, score + trust_adj)

    return round(min(score, 1.0), 4), reasons


def _format_explain(reasons: list[str], event: EventCandidate) -> str:
    """Build a short, human-readable recommendation reason."""
    if not reasons:
        return ""
    # Prioritise stronger signals first
    priority = (
        "filtered by faith preference",
        "over budget",
        "similar to events you've saved",
        "matches your",
        "aligns with",
        "fits your weekly routine",
        "ideal for your weekends",
        "free to attend",
        "within your budget",
        "happening very soon",
        "this week",
    )
    ordered: list[str] = []
    used: set[str] = set()
    for prefix in priority:
        for r in reasons:
            if r in used:
                continue
            if r.startswith(prefix):
                ordered.append(r)
                used.add(r)
    for r in reasons:
        if r not in used:
            ordered.append(r)
            used.add(r)
    head = ordered[:2]
    if not head:
        return ""
    return "Recommended because it " + " and ".join(head) + "."


# ─── Route ───────────────────────────────────────────────────────────────────

@router.post("/events/rank", summary="Rank events by user preferences")
def rank_events(body: RankEventsRequest):
    """
    Score and rank candidate events.
    Returns events sorted by descending score.
    Contradictory events (wrong denomination for user's religion) are scored near-zero.
    """
    if not body.events:
        return {"ranked": []}

    scored = []
    for ev in body.events:
        s, reasons = _score_event(ev, body.user_profile, body.memory)
        scored.append({
            "id":           ev.id,
            "title":        ev.title,
            "category":     ev.category,
            "date":         ev.date,
            "location":     ev.location,
            "image":        ev.image,
            "source_url":   ev.source_url,
            "is_paid":      ev.is_paid,
            "price_tier":   ev.price_tier,
            "ticket_price": ev.ticket_price,
            "organizer":    ev.organizer,
            "score":        s,
            "reasons":      reasons,
            "explain":      _format_explain(reasons, ev),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)

    logger.info(
        "[events/rank] user=%s candidates=%d top_score=%.3f religion=%s gender=%s "
        "budget=%s weekend=%s activities=%d saved=%d dismissed=%d",
        body.user_id, len(scored), scored[0]["score"] if scored else 0,
        body.user_profile.religion or "—",
        body.user_profile.gender or "—",
        body.user_profile.budgetTier or "—",
        body.user_profile.weekendPreference or "—",
        len(body.user_profile.weeklyActivities),
        len(body.memory.saved_event_ids),
        len(body.memory.dismissed_event_ids),
    )

    return {"ranked": scored}
