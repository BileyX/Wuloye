"""
routers/chat.py — Wuloye AI chat assistant.

POST /chat
  Returns a personalized, intent-aware chat reply.

The backend pre-classifies the user's intent (food / cafe / fitness / etc.)
and fetches candidates of the correct type BEFORE calling this endpoint.
The AI selects the best 1–3 from that typed pool and composes a reply.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

import config
from llm.openai_client import _get_client, is_llm_enabled

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["Chat"])

_JSON_RE = re.compile(r"\{[\s\S]*?\}", re.DOTALL)

# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are Wuloye Assistant — a smart lifestyle companion inside the Wuloye app for Addis Ababa, Ethiopia.

PERSONALITY
- Warm, friendly, concise: 1–2 short sentences max per reply. Never robotic.
- Speak directly to the user. Skip greetings on every turn.
- Never identify as ChatGPT or a generic AI.

CORE RULES (CRITICAL — follow every single one)
1. CATEGORY LOCK: The user context includes `detectedIntent` and `requiredPlaceTypes`. You MUST
   only pick candidates whose `type` matches `requiredPlaceTypes`. If NONE of the candidates
   match the required types, return `placeIds: []` and explain you couldn't find a match nearby.
2. NEVER suggest a bar, lounge, club, or nightlife venue unless the user EXPLICITLY asked
   for nightlife/drinks. When user says "eat", "food", "hungry" → only restaurants.
3. NEVER invent place names or IDs. Only return IDs that appear in the `candidatePlaces` list.
4. BUDGET: If user budget is "cheap"/"low", avoid any candidate with price "expensive"/"high".
5. RELIGION: If user is Orthodox Christian, prefer religious/Orthodox-tagged places for faith
   queries. If user is Muslim, never suggest churches.
6. DISLIKES: Never pick a place whose type is in `user.dislikedCategories`.
7. MAX 3 places. Quality > quantity — 1 great match beats 3 mediocre ones.

CANDIDATE SELECTION LOGIC
- Read `detectedIntent` and `requiredPlaceTypes` from the context.
- Filter candidatePlaces: only keep those whose `type` is in `requiredPlaceTypes`.
- Rank by: rating DESC, then distance ASC.
- Return the top 1–3 IDs.
- If filtered list is empty → return placeIds: [] and give a helpful reply.

OUTPUT FORMAT — return ONLY this JSON object, no markdown fences:
{
  "reply": "1-2 sentence conversational text",
  "placeIds": ["id1", "id2"],
  "eventIds": [],
  "suggestedActions": ["Chip 1", "Chip 2", "Chip 3"],
  "intent": "recommendation"
}

suggestedActions: 2–4 short follow-up taps (max 5 words each).
intent: recommendation | planning | info | smalltalk
"""

# ── Models ────────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = []
    userContext: dict[str, Any] = {}
    candidatePlaces: list[dict[str, Any]] = []
    candidateEvents: list[dict[str, Any]] = []
    detectedIntent: str = "general"
    requiredPlaceTypes: list[str] = []


class ChatResponse(BaseModel):
    reply: str
    placeIds: list[str] = []
    eventIds: list[str] = []
    suggestedActions: list[str] = []
    intent: str = "info"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compact_places(places: list[dict[str, Any]], required_types: list[str], limit: int = 14) -> list[dict[str, Any]]:
    """Return compact place dicts, typed candidates first."""
    def sort_key(p: dict) -> tuple:
        ptype = (p.get("type") or p.get("category") or "").lower()
        is_match = 1 if (not required_types or ptype in required_types) else 0
        rating = float(p.get("rating") or 0)
        return (-is_match, -rating)

    sorted_places = sorted(places, key=sort_key)

    out = []
    for p in sorted_places[:limit]:
        out.append({
            "id": p.get("id") or p.get("placeId"),
            "name": p.get("name"),
            "type": (p.get("type") or p.get("category") or "").lower(),
            "price": (p.get("priceLevel") or p.get("priceRange") or "").lower(),
            "rating": p.get("rating"),
            "distanceKm": p.get("distanceKm") or p.get("distance"),
            "tags": (p.get("tags") or [])[:4],
        })
    return out


def _compact_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": e.get("id") or e.get("eventId"),
            "title": e.get("title") or e.get("name"),
            "category": e.get("category") or e.get("type"),
            "when": e.get("dateText") or e.get("startsAt") or e.get("when"),
        }
        for e in events[:8]
    ]


def _compact_context(ctx: dict[str, Any], detected_intent: str, required_types: list[str]) -> dict[str, Any]:
    profile = ctx.get("profile") or {}
    return {
        "name": profile.get("username") or profile.get("name") or "friend",
        "religion": (profile.get("religion") or "").lower(),
        "budget": (profile.get("budgetRange") or profile.get("weeklyBudgetTier") or "").lower(),
        "interests": (profile.get("interests") or [])[:6],
        "weeklyActivities": (profile.get("weeklyActivities") or [])[:4],
        "mealPreferences": (profile.get("mealPreferences") or [])[:4],
        "city": profile.get("city") or "Addis Ababa",
        "topInterests": (ctx.get("topInterests") or [])[:5],
        "dislikedCategories": (ctx.get("dislikedCategories") or [])[:5],
        "savedCategories": (ctx.get("savedCategories") or [])[:4],
        "timeOfDay": ctx.get("timeOfDay") or "",
        "isWeekend": bool(ctx.get("isWeekend")),
        "currentMood": ctx.get("currentMood") or "",
        # Intent signals — explicit for the model to follow
        "detectedIntent": detected_intent,
        "requiredPlaceTypes": required_types,
    }


def _rule_based_fallback(req: ChatRequest) -> ChatResponse:
    """Fast fallback used when LLM is unavailable."""
    intent = req.detectedIntent or "general"
    required = set(t.lower() for t in (req.requiredPlaceTypes or []))

    candidates = [
        p for p in (req.candidatePlaces or [])
        if not required or (p.get("type") or "").lower() in required
    ] or list(req.candidatePlaces or [])

    # Sort by rating so fallback doesn't always return the same 3.
    candidates.sort(key=lambda p: float(p.get("rating") or 0), reverse=True)

    picked_ids = [
        p.get("id") or p.get("placeId")
        for p in candidates[:3]
        if p.get("id") or p.get("placeId")
    ]

    reply_map = {
        "food": "Here are restaurants nearby based on your request.",
        "budget": "These are the most budget-friendly spots nearby.",
        "cafe": "Here are some cafes near you.",
        "fitness": "These gyms and fitness spots are closest to you.",
        "wellness": "Here are wellness spots to relax.",
        "events": "Here's what's happening around you.",
        "workspace": "Here are quiet spots to work or study.",
        "hotel": "Here are hotels near you.",
        "nightlife": "Here are social spots nearby.",
        "outdoor": "Here are outdoor places worth visiting.",
        "church": "Here are places of worship near you.",
        "relaxation": "Here are calm spots to unwind.",
    }
    reply = reply_map.get(intent, "Based on your question, here are my top picks nearby.")
    if not picked_ids and intent != "events":
        reply = "I couldn't find a match nearby. Try rephrasing or expand your search area."

    actions = {
        "food": ["Find a cafe", "Budget options", "Plan my evening"],
        "budget": ["Find a cafe", "More options", "Plan my evening"],
        "cafe": ["Find food nearby", "Workspace nearby", "Plan my afternoon"],
        "fitness": ["Find a park", "Yoga nearby", "Plan my morning"],
    }.get(intent, ["Find food nearby", "Find a gym", "Plan my evening"])

    return ChatResponse(
        reply=reply,
        placeIds=picked_ids,
        eventIds=[],
        suggestedActions=actions,
        intent="recommendation" if picked_ids else "info",
    )


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if not is_llm_enabled() or _get_client() is None:
        return _rule_based_fallback(req)

    client = _get_client()
    intent = req.detectedIntent or "general"
    required_types = [t.lower() for t in (req.requiredPlaceTypes or [])]

    context_blob = {
        "user": _compact_context(req.userContext or {}, intent, required_types),
        "candidatePlaces": _compact_places(req.candidatePlaces or [], required_types),
        "candidateEvents": _compact_events(req.candidateEvents or []),
    }

    # Build message history (last 12 turns).
    history_messages: list[dict[str, str]] = []
    for m in (req.messages or [])[-12:]:
        role = m.role if m.role in ("user", "assistant") else "user"
        content = (m.content or "").strip()[:1200]
        if content:
            history_messages.append({"role": role, "content": content})

    if not history_messages:
        return _rule_based_fallback(req)

    final_messages: list[dict[str, str]] = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "system",
            "content": (
                f"CURRENT REQUEST CONTEXT (use silently):\n"
                f"detectedIntent = {intent}\n"
                f"requiredPlaceTypes = {json.dumps(required_types)}\n"
                f"You MUST only pick candidatePlaces whose type is in requiredPlaceTypes "
                f"(unless requiredPlaceTypes is empty).\n\n"
                + json.dumps(context_blob, ensure_ascii=False)
            ),
        },
        *history_messages,
    ]

    try:
        resp = client.chat.completions.create(
            model=config.OPENAI_LLM_MODEL or "gpt-4o-mini",
            max_tokens=350,
            temperature=0.45,  # lower = more precise selection
            timeout=12.0,
            response_format={"type": "json_object"},
            messages=final_messages,
        )
        text = (resp.choices[0].message.content or "").strip()
        m = _JSON_RE.search(text)
        if m:
            text = m.group(0)
        data = json.loads(text)
    except Exception as exc:
        logger.warning("[chat] LLM call failed: %s", exc)
        return _rule_based_fallback(req)

    # ── Validate returned IDs ─────────────────────────────────────────────────
    valid_place_ids = {
        (p.get("id") or p.get("placeId"))
        for p in (req.candidatePlaces or [])
        if p.get("id") or p.get("placeId")
    }
    valid_event_ids = {
        (e.get("id") or e.get("eventId"))
        for e in (req.candidateEvents or [])
        if e.get("id") or e.get("eventId")
    }

    # Secondary guard: re-check returned IDs against required types.
    place_type_map = {
        (p.get("id") or p.get("placeId")): (p.get("type") or p.get("category") or "").lower()
        for p in (req.candidatePlaces or [])
    }

    raw_place_ids = [pid for pid in (data.get("placeIds") or []) if pid in valid_place_ids]
    if required_types:
        place_ids = [
            pid for pid in raw_place_ids
            if place_type_map.get(pid, "") in required_types
        ][:3]
    else:
        place_ids = raw_place_ids[:3]

    event_ids = [eid for eid in (data.get("eventIds") or []) if eid in valid_event_ids][:3]

    reply = str(data.get("reply") or "").strip()[:600]
    if not reply:
        reply = "Tell me what you're looking for and I'll find something."

    actions = [str(a)[:40] for a in (data.get("suggestedActions") or [])][:4]
    intent_out = str(data.get("intent") or "info")
    if intent_out not in {"recommendation", "planning", "info", "smalltalk"}:
        intent_out = "info"

    return ChatResponse(
        reply=reply,
        placeIds=place_ids,
        eventIds=event_ids,
        suggestedActions=actions,
        intent=intent_out,
    )
