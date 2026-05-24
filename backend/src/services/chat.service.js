/**
 * chat.service.js — AI chat assistant orchestration.
 *
 * Key design:
 *  - Intent classification maps the user's message to specific place types
 *    BEFORE fetching candidates, so the recommendation engine returns
 *    contextually-correct places (restaurant for food queries, gym for
 *    fitness, etc.) rather than a generic personalised feed.
 *  - Falls back to a general feed only when no specific intent is detected.
 *
 * Collections:
 *   chat_messages/{uid}/messages/{msgId}
 */

import { db } from "../config/firebase.js";
import { logger } from "../utils/logger.js";
import { getUserById } from "./user.service.js";
import { getRecommendations } from "./recommendation.service.js";
import { getPlacesByIds } from "./place.service.js";
import { getInteractionsByUser, ACTION_SCORES } from "./interaction.service.js";
import { getAllEvents } from "./event.service.js";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";
const AI_CHAT_TIMEOUT_MS = parseInt(process.env.AI_CHAT_TIMEOUT_MS || "15000", 10);

const COLLECTION = "chat_messages";
const MAX_HISTORY = 30;
const HISTORY_TURNS_FOR_LLM = 10;

// ─── Intent → place-type mapping ──────────────────────────────────────────────
// Each entry: [ regex, placeType[], label ]
// placeType values must match VALID_TYPES in place.service.js:
//   "gym","coffee","restaurant","park","yoga","social","walk","study","outdoor","hotel","church","sports"

const INTENT_MAP = [
  // Gym / fitness — before food so "work out" doesn't lose to generic patterns
  [/\b(gym|gyms|workout|fitness|exercise|lift|weights|cardio|aerobic|crossfit|bodybuilding)\b/, ["gym", "yoga", "sports"], "fitness"],
  // Food / dining
  [/\b(eat|food|noodle|noodles|burger|pizza|pasta|injera|sushi|steak|lunch|dinner|breakfast|brunch|meal|restaurant|dine|cuisine|hungry|snack|kebab|shiro|tibs|kitfo|dining)\b/, ["restaurant"], "food"],
  // Coffee / cafe
  [/\b(coffee|cafe|cafes|latte|cappuccino|macchiato|espresso|tea|buna|juice|smoothie)\b/, ["coffee"], "cafe"],
  // Budget (usually food/cafe refinement)
  [/\b(budget|cheap|affordable|inexpensive|low[\s-]?cost|economical)\b/, ["restaurant", "coffee"], "budget"],
  // Yoga / wellness
  [/\b(yoga|meditat|wellness|spa|massage|stretch|breath)\b/, ["yoga", "park"], "wellness"],
  // Church / religion
  [/\b(church|churches|pray|worship|orthodox|mosque|religious|faith|mezmur|kidist|saint)\b/, ["church"], "church"],
  // Events — places fetched separately; no place type filter
  [/\b(event|events|concert|show|festival|happening|tonight|ticket|celebration)\b/, [], "events"],
  // Workspace / study
  [/\b(work|focus|study|laptop|cowork|workspace|productive|concentrate|quiet place|library)\b/, ["study", "coffee"], "workspace"],
  // Hotel / stay
  [/\b(hotel|hotels|stay|overnight|accommodation|lodge|inn|airbnb|room)\b/, ["hotel"], "hotel"],
  // Social / nightlife — explicit only
  [/\b(bar|nightlife|club|lounge|drinks|beer|wine|cocktail|night out)\b/, ["social"], "nightlife"],
  // Outdoors / nature
  [/\b(park|walk|hike|nature|outdoor|fresh air|green|garden|trail|lake)\b/, ["park", "walk", "outdoor"], "outdoor"],
  // Sports
  [/\b(sport|sports|football|basketball|tennis|pool|swimming|court|pitch)\b/, ["sports", "gym"], "sports"],
  // Shopping
  [/\b(shop|mall|buy|market|store|fashion|clothes|souvenir)\b/, ["social"], "shopping"],
  // Relaxation
  [/\b(relax|calm|peaceful|unwind|stress)\b/, ["park", "coffee", "yoga"], "relaxation"],
  // Tired / mood
  [/\b(tired|exhaust|sleepy|drain|bored)\b/, ["coffee", "park"], "relaxation"],
];

const FOLLOW_UP_RE = /^(budget|more|cheaper|closer|another|nearby|options?|yes|no|show me|similar|that one|those)\b/i;

/** Match intent against a single text string (no history bleed). */
function matchIntent(text) {
  const lower = (text || "").toLowerCase();
  for (const [re, types, label] of INTENT_MAP) {
    if (re.test(lower)) {
      return { placeTypes: types, intentLabel: label };
    }
  }
  return null;
}

/**
 * Detect intent from the CURRENT message first.
 * History is only used for short follow-ups like "Budget options" or "Show more".
 */
function detectIntent(userText, history = []) {
  const text = (userText || "").trim();
  const direct = matchIntent(text);
  if (direct) return direct;

  // Short follow-up chips inherit intent from the last user question.
  if (FOLLOW_UP_RE.test(text) && history.length > 0) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (lastUser?.content) {
      const inherited = matchIntent(lastUser.content);
      if (inherited) return inherited;
    }
  }

  return null;
}

// ─── Query-aware ranking & reply generation ───────────────────────────────────

const PRICE_RANK = { free: 0, low: 1, cheap: 1, medium: 2, mid: 2, high: 3, expensive: 3 };

function extractKeywords(text) {
  const stop = new Set(["where", "can", "the", "for", "and", "with", "that", "this", "what", "which", "some", "near", "nearby", "now", "right", "please", "find", "show", "good", "best", "any", "are", "you", "eat", "go", "get", "want", "need", "looking", "place", "places", "spot", "spots"]);
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function placeSearchText(place) {
  return [
    place.name,
    place.type,
    place.category,
    ...(place.tags || []),
    place.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scorePlaceForQuery(place, userText, intentLabel, profile) {
  let score = Number(place.rating) || 0;
  const keywords = extractKeywords(userText);
  const blob = placeSearchText(place);

  for (const kw of keywords) {
    if (blob.includes(kw)) score += 4;
  }

  if (intentLabel === "budget") {
    const price = (place.priceLevel || place.priceRange || "").toLowerCase();
    score += 5 - (PRICE_RANK[price] ?? 2);
  }

  const userBudget = (profile?.budgetRange || profile?.weeklyBudgetTier || "").toLowerCase();
  if (["cheap", "low", "budget"].some((b) => userBudget.includes(b))) {
    const price = (place.priceLevel || place.priceRange || "").toLowerCase();
    if (price === "high" || price === "expensive") score -= 3;
    if (price === "low" || price === "cheap") score += 2;
  }

  if (place.distanceKm != null) {
    score -= Math.min(Number(place.distanceKm) * 0.3, 3);
  }

  return score;
}

function selectBestPlaces(candidates, userText, intentLabel, profile, requiredTypes, limit = 3) {
  let pool = [...(candidates || [])];

  if (requiredTypes?.length) {
    const allowed = new Set(requiredTypes.map((t) => t.toLowerCase()));
    const typed = pool.filter((p) => allowed.has((p.type || p.category || "").toLowerCase()));
    if (typed.length > 0) pool = typed;
  }

  return pool
    .sort((a, b) => scorePlaceForQuery(b, userText, intentLabel, profile) - scorePlaceForQuery(a, userText, intentLabel, profile))
    .slice(0, limit);
}

function buildContextualReply(userText, intentLabel, places) {
  const t = (userText || "").toLowerCase();
  const names = places.slice(0, 2).map((p) => p.name).filter(Boolean);

  if (/noodle/.test(t)) {
    if (places.length) {
      return names.length
        ? `For noodles, ${names.join(" and ")} ${places.length === 1 ? "is" : "are"} worth a look nearby.`
        : "Here are some restaurants nearby that may have noodle dishes.";
    }
    return "I couldn't find a dedicated noodle spot nearby, but these restaurants are your best nearby options.";
  }

  const replies = {
    food: places.length
      ? `Here are ${places.length} restaurant${places.length > 1 ? "s" : ""} nearby for you.`
      : "I couldn't find restaurants nearby right now.",
    budget: places.length
      ? "These are the most budget-friendly spots I found nearby."
      : "I couldn't find budget-friendly places nearby right now.",
    cafe: places.length
      ? "Here are some cafes near you."
      : "I couldn't find cafes nearby right now.",
    fitness: places.length
      ? "These gyms and fitness spots are closest to you."
      : "I couldn't find gyms nearby right now. Try expanding your search area.",
    wellness: "Here are some wellness and relaxation spots nearby.",
    church: "Here are places of worship near you.",
    events: "Here's what's happening around you.",
    workspace: "These spots are good for working or studying.",
    hotel: "Here are hotels near you.",
    nightlife: "Here are some social spots nearby.",
    outdoor: "Here are outdoor places worth visiting.",
    sports: "Here are sports and activity spots nearby.",
    relaxation: "Here are some calm spots to unwind.",
  };

  if (replies[intentLabel]) return replies[intentLabel];

  if (/gym/.test(t)) {
    return places.length
      ? "These gyms and fitness spots are closest to you."
      : "I couldn't find gyms nearby right now.";
  }

  return places.length
    ? "Based on what you asked, here are my top picks nearby."
    : "Tell me what you're looking for — food, gym, cafe, events — and I'll find something.";
}

const GENERIC_REPLY_RES = [
  /here are some places to eat/i,
  /here are some places where you can eat/i,
  /i picked a few places that match your vibe/i,
  /here are a few places that might interest you/i,
];

function isGenericReply(reply) {
  return GENERIC_REPLY_RES.some((re) => re.test(reply || ""));
}

// ─── Context builders ─────────────────────────────────────────────────────────

const NEGATIVE_ACTIONS = new Set([
  "dislike", "dismiss", "skip", "not_interested",
  "feedback_poor", "feedback_not_relevant", "remove_save", "quick_exit",
]);
const POSITIVE_ACTIONS = new Set([
  "save", "like", "revisit", "directions", "feedback_excellent", "feedback_good",
  "mark_interested", "view_long", "click",
]);

function timeOfDay(hour) {
  if (hour < 5) return "late_night";
  if (hour < 11) return "morning";
  if (hour < 15) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late_night";
}

function buildBehavioralSignals(interactions = []) {
  const liked = new Map();
  const disliked = new Map();
  const saved = new Map();

  for (const i of interactions) {
    const type = (i.placeType || i.type || "").toLowerCase();
    if (!type) continue;
    const action = i.actionType || i.action;
    if (!action) continue;

    if (action === "save" || action === "revisit") {
      saved.set(type, (saved.get(type) ?? 0) + (ACTION_SCORES[action] ?? 1));
    }
    if (POSITIVE_ACTIONS.has(action)) {
      liked.set(type, (liked.get(type) ?? 0) + (ACTION_SCORES[action] ?? 1));
    }
    if (NEGATIVE_ACTIONS.has(action)) {
      disliked.set(type, (disliked.get(type) ?? 0) + Math.abs(ACTION_SCORES[action] ?? 1));
    }
  }

  const topN = (m, n = 5) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  return {
    savedCategories: topN(saved, 5),
    topInterests: topN(liked, 5),
    dislikedCategories: topN(disliked, 5),
  };
}

function detectMood(text) {
  const lower = (text || "").toLowerCase();
  if (/tired|exhaust|sleepy|drain/.test(lower)) return "tired";
  if (/bored|nothing to do/.test(lower)) return "bored";
  if (/stress|anxious|overwhelm/.test(lower)) return "stressed";
  if (/sad|down|lonely/.test(lower)) return "sad";
  if (/happy|excited|productive/.test(lower)) return "energetic";
  if (/hungry|eat/.test(lower)) return "hungry";
  if (/work|focus|study|productive/.test(lower)) return "focused";
  if (/relax|chill|calm|quiet/.test(lower)) return "calm";
  return "";
}

async function buildUserContext(uid, latestUserText, location, intentLabel) {
  const [profile, interactions] = await Promise.all([
    getUserById(uid).catch(() => null),
    getInteractionsByUser(uid, 60).catch(() => []),
  ]);

  const signals = buildBehavioralSignals(interactions);
  const now = new Date();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;

  return {
    profile: profile ?? {},
    ...signals,
    timeOfDay: timeOfDay(now.getHours()),
    dayOfWeek: ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][day],
    isWeekend,
    currentMood: detectMood(latestUserText),
    detectedIntent: intentLabel ?? "general",
    location: location ?? null,
  };
}

// ─── Candidate fetchers ───────────────────────────────────────────────────────

async function fetchCandidatePlaces(uid, location, placeTypes) {
  const userLocation = location?.lat != null && location?.lng != null
    ? { lat: location.lat, lng: location.lng, radiusMeters: 5000 }
    : null;

  const typeFilter = placeTypes?.length ? placeTypes : null;

  try {
    const result = await getRecommendations(
      uid,
      false,
      16,
      userLocation,
      true,
      typeFilter,
      null,
      null,
      true, // forceRefresh — avoid returning stale cached results from prior queries
    );
    const typed = result?.recommendations ?? [];

    // Never mix unrelated categories into a typed query.
    if (typeFilter) return typed.slice(0, 14);

    return typed.slice(0, 14);
  } catch (err) {
    logger.warn(`[chat] fetchCandidatePlaces failed: ${err.message}`);
    try {
      const fallback = await getRecommendations(
        uid, false, 12, userLocation, true, typeFilter, null, null, true,
      );
      return fallback?.recommendations ?? [];
    } catch {
      return [];
    }
  }
}

async function fetchCandidateEvents() {
  try {
    return (await getAllEvents({ limit: 8 })).slice(0, 8);
  } catch {
    return [];
  }
}

// ─── Firestore history ────────────────────────────────────────────────────────

function messagesRef(uid) {
  return db.collection(COLLECTION).doc(uid).collection("messages");
}

export async function appendMessage(uid, role, content, extra = {}) {
  const ref = messagesRef(uid).doc();
  const doc = {
    id: ref.id,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  await ref.set(doc);
  return doc;
}

export async function getChatHistory(uid, limit = MAX_HISTORY) {
  const snap = await messagesRef(uid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data()).reverse();
}

export async function clearChatHistory(uid) {
  const snap = await messagesRef(uid).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return { deleted: snap.size };
}

// ─── AI service proxy ─────────────────────────────────────────────────────────

async function callAiChat(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_SERVICE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(`[chat] AI service ${res.status}: ${await res.text().catch(() => "").then((t) => t.slice(0, 200))}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn(`[chat] AI service unreachable: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackActions(intentLabel) {
  switch (intentLabel) {
    case "food":
    case "budget":
      return ["Find a cafe", "Budget options", "Plan my evening"];
    case "cafe":
      return ["Find food nearby", "Quiet workspace", "Plan my afternoon"];
    case "fitness":
      return ["Find a park", "Yoga nearby", "Plan my morning"];
    case "events":
      return ["Restaurants nearby", "Find a cafe", "Plan my evening"];
    case "workspace":
      return ["Find a cafe", "Plan my afternoon", "Show trending"];
    default:
      return ["Find food nearby", "Find a gym", "Plan my evening"];
  }
}

/**
 * Build the final chat result — works with or without AI service.
 * Always picks places locally based on the user's actual question.
 */
function composeChatResult(userText, candidatePlaces, candidateEvents, intentLabel, placeTypes, profile, aiResponse) {
  const effectiveIntent = intentLabel === "budget" ? "budget" : intentLabel;
  const requiredTypes = placeTypes ?? [];

  // Local selection is the source of truth for WHICH places to show.
  const bestPlaces = selectBestPlaces(
    candidatePlaces,
    userText,
    effectiveIntent,
    profile,
    requiredTypes,
    3,
  );

  let placeIds = bestPlaces.map((p) => p.id ?? p.placeId).filter(Boolean);
  let eventIds = [];
  let reply;
  let suggestedActions = buildFallbackActions(effectiveIntent);
  let intent = effectiveIntent === "general" ? "info" : "recommendation";

  // Events intent: prefer events over places
  if (effectiveIntent === "events" && candidateEvents.length > 0) {
    eventIds = candidateEvents.slice(0, 3).map((e) => e.id ?? e.eventId).filter(Boolean);
    placeIds = [];
    reply = buildContextualReply(userText, "events", []);
    return { reply, placeIds, eventIds, suggestedActions, intent: "recommendation" };
  }

  // Use AI reply text only if it's specific and non-generic; places always from local ranker.
  if (aiResponse?.reply && !isGenericReply(aiResponse.reply)) {
    reply = aiResponse.reply;
    if (Array.isArray(aiResponse.suggestedActions) && aiResponse.suggestedActions.length) {
      suggestedActions = aiResponse.suggestedActions;
    }
    if (aiResponse.intent) intent = aiResponse.intent;
  } else {
    reply = buildContextualReply(userText, effectiveIntent, bestPlaces);
  }

  // If local ranker found nothing but AI picked valid typed IDs, honour those.
  if (placeIds.length === 0 && aiResponse?.placeIds?.length) {
    const allowed = new Set(requiredTypes.map((t) => t.toLowerCase()));
    const aiPlaces = (aiResponse.placeIds ?? [])
      .map((id) => candidatePlaces.find((p) => (p.id ?? p.placeId) === id))
      .filter(Boolean)
      .filter((p) => !requiredTypes.length || allowed.has((p.type || "").toLowerCase()));
    if (aiPlaces.length) {
      placeIds = aiPlaces.map((p) => p.id ?? p.placeId);
      reply = buildContextualReply(userText, effectiveIntent, aiPlaces);
    }
  }

  return { reply, placeIds, eventIds, suggestedActions, intent };
}

function fallbackReply(userText, candidatePlaces, intentLabel, profile, placeTypes) {
  return composeChatResult(
    userText,
    candidatePlaces,
    [],
    intentLabel,
    placeTypes,
    profile,
    null,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendChatMessage(uid, userText, { location = null } = {}) {
  if (!userText?.trim()) {
    const err = new Error("Message cannot be empty");
    err.statusCode = 400;
    throw err;
  }
  const trimmed = userText.trim().slice(0, 1000);

  // Load history first (needed for intent detection context).
  const history = await getChatHistory(uid, HISTORY_TURNS_FOR_LLM);

  // Detect intent BEFORE fetching candidates so we get the right place types.
  const intentResult = detectIntent(trimmed, history);
  const placeTypes = intentResult?.placeTypes ?? null;
  const intentLabel = intentResult?.intentLabel ?? "general";

  logger.info(`[chat] uid=${uid} intent=${intentLabel} types=${placeTypes?.join(",") ?? "general"} msg="${trimmed.slice(0, 60)}"`);

  const [userContext, candidatePlaces, candidateEvents] = await Promise.all([
    buildUserContext(uid, trimmed, location, intentLabel),
    fetchCandidatePlaces(uid, location, placeTypes),
    fetchCandidateEvents(),
  ]);

  await appendMessage(uid, "user", trimmed);

  const llmMessages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: trimmed },
  ];

  const aiResponse = await callAiChat({
    messages: llmMessages,
    userContext,
    candidatePlaces,
    candidateEvents,
    detectedIntent: intentLabel,
    requiredPlaceTypes: placeTypes ?? [],
  });

  const profile = userContext.profile ?? {};
  const result = composeChatResult(
    trimmed,
    candidatePlaces,
    candidateEvents,
    intentLabel,
    placeTypes,
    profile,
    aiResponse,
  );

  // Hydrate place cards by ID.
  const placeMap = new Map(
    candidatePlaces.map((p) => [p.id ?? p.placeId, p]).filter(([k]) => k),
  );

  const places = (result.placeIds ?? [])
    .map((id) => placeMap.get(id))
    .filter(Boolean);

  // Top up from Firestore if AI selected IDs we trimmed from the pool.
  const missingIds = (result.placeIds ?? []).filter((id) => !placeMap.has(id));
  if (missingIds.length) {
    try {
      const extra = await getPlacesByIds(missingIds);
      for (const p of extra) places.push(p);
    } catch { /* ignore */ }
  }

  const eventMap = new Map(
    candidateEvents.map((e) => [e.id ?? e.eventId, e]).filter(([k]) => k),
  );
  const events = (result.eventIds ?? [])
    .map((id) => eventMap.get(id))
    .filter(Boolean);

  const assistantDoc = await appendMessage(uid, "assistant", result.reply, {
    intent: result.intent ?? intentLabel,
    placeIds: places.map((p) => p.id ?? p.placeId).filter(Boolean),
    eventIds: events.map((e) => e.id ?? e.eventId).filter(Boolean),
    suggestedActions: result.suggestedActions ?? [],
  });

  return {
    message: assistantDoc,
    reply: result.reply,
    intent: result.intent ?? intentLabel,
    places,
    events,
    suggestedActions: result.suggestedActions ?? [],
  };
}

// ─── Default suggestions ──────────────────────────────────────────────────────

export function getDefaultSuggestions(profile = {}) {
  const hour = new Date().getHours();
  const base = [];

  if (hour < 11) {
    base.push("Find a good breakfast spot", "Good cafe nearby", "Quick workout place");
  } else if (hour < 15) {
    base.push("Where can I eat lunch?", "Quiet place to work", "Affordable food nearby");
  } else if (hour < 18) {
    base.push("Coffee break spot", "Plan my afternoon", "Find a workspace");
  } else if (hour < 22) {
    base.push("Plan my evening", "Restaurant ideas", "Events happening tonight");
  } else {
    base.push("Calm spots open now", "Late-night food", "Plan tomorrow morning");
  }

  if (profile?.religion) {
    base.push(`${profile.religion} church near me`);
  }
  const budgetKey = profile?.weeklyBudgetTier ?? profile?.budgetRange ?? "";
  if (["cheap", "low", "budget"].some((k) => budgetKey.toLowerCase().includes(k))) {
    base.push("Budget-friendly places");
  }

  return base.slice(0, 6);
}
