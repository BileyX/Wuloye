/**
 * services/aiSchedule.service.js — Adaptive AI Daily Planner (v2)
 *
 * Builds a deeply personalized daily plan that learns continuously from:
 *
 *   • Onboarding         — wake/sleep, religion, gender, budget, weekly activities,
 *                          daily routine block, weekend preference, food preferences.
 *   • Routines           — explicit user-scheduled blocks for today's weekday.
 *   • Behaviour          — likes, saves, dislikes, dismisses, recent interactions
 *                          (action-weighted affinity over a decay window).
 *   • Persistent memory  — dislikedPlaceIds + notInterestedPlaceIds never resurface.
 *   • Real-time learning — Python AI service preference vectors (top categories &
 *                          time-slot affinity), bandit reward signals.
 *   • Planner usage      — activity_complete / activity_skipped / planner_card_click
 *                          counters from the interactions stream.
 *
 * Output structure (per slot):
 *   {
 *     id, period, time, duration, activityType, icon, color,
 *     title, reason, badges,
 *     source:        "routine" | "habit" | "onboarding" | "ai_inferred",
 *     confidence:    0..1,                          — planner's belief this slot fits
 *     places:        [ {…enriched place w/ match%}, … up to 3 ],
 *     place:         legacy alias for places[0]     — keeps old clients working
 *   }
 *
 * Anti-repetition: the schedule key includes today's date + a hash of the
 * places shown; ?refresh=true forces a new mix.
 *
 * Performance: all per-slot recommendation calls run concurrently via
 * Promise.all and share the user-profile cache from recommendation.service.
 */

import { db }                       from "../config/firebase.js";
import { getUserById }              from "./user.service.js";
import { getRecommendations }       from "./recommendation.service.js";
import { logger }                   from "../utils/logger.js";

// ─── External configuration ───────────────────────────────────────────────────

const AI_SERVICE_URL     = process.env.AI_SERVICE_URL     || "http://localhost:8000";
const AI_PREF_TIMEOUT_MS = parseInt(process.env.AI_PREF_TIMEOUT_MS || "400", 10);

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAY_KEYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

const PERIOD_ORDER = { morning: 0, afternoon: 1, evening: 2, night: 3 };

/** Max number of suggested places to attach to a single planner slot. */
const PLACES_PER_SLOT = 3;

/** How many candidate types the planner considers when filling free slots. */
const SLOT_DIVERSITY_CAP = 5;

/** Daily TTL — planner is "stable" within the day unless the user refreshes. */
const PLAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Maximum cached plans (per uid + date + location). */
const PLAN_CACHE_MAX = 256;

/** Window of recent interactions used to compute habit signals. */
const HABIT_INTERACTION_WINDOW = 80;

/** Half-life (days) for action recency weight. */
const HABIT_HALF_LIFE_DAYS = 7;

/** Minimum free gap (minutes) before inserting a micro-activity */
const MICRO_GAP_MIN = 90;
const MICRO_GAP_MAX = 300;
const MICRO_DAILY_CAP = 2;

/** Negative interaction types that suppress a category from the planner. */
const NEGATIVE_ACTIONS = new Set([
  "dislike", "dismiss", "skip", "not_interested",
  "feedback_poor", "feedback_not_relevant", "remove_save",
]);

/** Positive interaction types that boost a category in the planner. */
const POSITIVE_ACTIONS = new Set([
  "view_long", "click", "directions", "call", "share",
  "like", "save", "mark_interested", "revisit",
  "open_event", "join_event", "schedule_complete", "activity_complete",
  "feedback_excellent", "feedback_good",
]);

/** Per-action affinity weight (positive boosts, negative suppresses). */
const ACTION_WEIGHTS = {
  view: 0.5, click: 1, view_long: 2,
  directions: 3, call: 2, share: 2,
  like: 2, save: 3, mark_interested: 1, revisit: 3,
  open_event: 1, join_event: 3,
  schedule_complete: 3, activity_complete: 3,
  feedback_excellent: 3, feedback_good: 1.5, feedback_neutral: 0,
  dislike: -3, dismiss: -2, skip: -1, not_interested: -4,
  feedback_poor: -2, feedback_not_relevant: -3, remove_save: -1,
};

const ACTIVITY_ICON_MAP = {
  gym: "barbell-outline", yoga: "body-outline", coffee: "cafe",
  reading: "book", hiking: "map-outline", shopping: "bag",
  restaurant: "restaurant", study: "school", work: "laptop-outline",
  walk: "footsteps-outline", cinema: "film-outline", social: "people",
  church: "business-outline", mosque: "business-outline", temple: "business-outline",
  meditation: "leaf-outline", prayer: "sparkles-outline",
  music: "musical-notes-outline", art: "color-palette-outline",
  events: "calendar-outline", networking: "people-circle-outline",
  outdoor: "leaf-outline", park: "flower-outline",
  default: "ellipse-outline",
};

const ACTIVITY_DURATION = {
  gym: "60 min", yoga: "45 min", coffee: "30 min", reading: "45 min",
  hiking: "90 min", shopping: "60 min", restaurant: "60 min", study: "90 min",
  work: "120 min", walk: "30 min", cinema: "120 min", social: "75 min",
  meditation: "20 min", prayer: "30 min", events: "90 min",
  music: "45 min", art: "60 min", default: "45 min",
};

/** activityType → catalogue discoverKey (used by getRecommendations filter). */
const ACTIVITY_TO_DISCOVER_KEY = {
  gym: "gym", yoga: "gym", hiking: "gym", fitness: "gym",
  coffee: "cafe", reading: "cafe", study: "cafe",
  restaurant: "restaurant", food: "restaurant", lunch: "restaurant", dinner: "restaurant",
  shopping: "shopping",
  cinema: "events", events: "events", music: "events", networking: "events",
  social: "restaurant",
  church: "church", mosque: "mosque", temple: null,
  outdoor: "park", park: "park", walk: "park", meditation: "park",
  prayer: null, // covered by church/mosque resolution
  art: "events", work: "cafe",
  hotel: "restaurant",
};

/** Activity types that are valid for the planner — anything else is filtered out. */
const VALID_PLANNER_ACTIVITIES = new Set([
  "gym", "yoga", "hiking", "fitness", "meditation", "walk", "running",
  "coffee", "reading", "study", "work",
  "restaurant", "food", "lunch", "dinner", "shopping",
  "cinema", "events", "music", "networking", "art", "social",
  "church", "mosque", "temple", "prayer",
  "outdoor", "park",
]);

const ACTIVITY_COLORS = [
  "#14B8A6", "#8B5CF6", "#F472B6", "#FB923C",
  "#38BDF8", "#A3E635", "#F59E0B", "#6366F1",
];

const RELIGION_TO_ACTIVITY = {
  christian: "church", protestant: "church", catholic: "church", orthodox: "church",
  muslim: "mosque", buddhist: "temple", hindu: "temple", jewish: "synagogue",
};

const FREE_PLACE_TYPES = new Set([
  "church", "mosque", "temple", "shrine", "place_of_worship",
  "park", "library", "public_space", "beach", "museum_free",
]);

const BUDGET_PRICE_CAP = { low: 1, cheap: 1, medium: 2, mid: 2, high: 4, expensive: 4 };

/** Default candidate activity pool when onboarding gives nothing useful. */
const FALLBACK_ACTIVITY_POOL = [
  "walk", "coffee", "reading", "work", "gym", "restaurant", "park", "social",
];

// ─── Plan cache (per uid + locationKey + dateKey) ─────────────────────────────

const planCache = new Map();

function getCachedPlan(key) {
  const entry = planCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    planCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedPlan(key, value) {
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest) planCache.delete(oldest);
  }
  planCache.set(key, { value, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
}

function invalidatePlan(uid) {
  for (const k of planCache.keys()) {
    if (k.startsWith(`plan:${uid}:`)) planCache.delete(k);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseHHmm(str, fallbackHour = 7) {
  if (!str || typeof str !== "string") return { h: fallbackHour, m: 0 };
  const [a, b] = str.split(":").map((x) => parseInt(x, 10));
  return { h: Number.isFinite(a) ? a : fallbackHour, m: Number.isFinite(b) ? b : 0 };
}

function minutesToHHmm(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutes(timeStr) {
  const { h, m } = parseHHmm(timeStr ?? "00:00");
  return h * 60 + m;
}

function determinePeriodFromHour(hour) {
  if (hour >= 5  && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

function determinePeriod(timeOfDay) {
  switch ((timeOfDay || "").toLowerCase()) {
    case "morning":   return "morning";
    case "afternoon": return "afternoon";
    case "evening":   return "evening";
    case "night":     return "night";
    default:          return "morning";
  }
}

function activityIcon(type) {
  return ACTIVITY_ICON_MAP[(type || "").toLowerCase()] ?? ACTIVITY_ICON_MAP.default;
}

function activityDuration(type) {
  return ACTIVITY_DURATION[(type || "").toLowerCase()] ?? ACTIVITY_DURATION.default;
}

function pricingEnabled(place) {
  if (!place) return false;
  const t = `${place.type ?? ""} ${place.category ?? ""}`.toLowerCase();
  for (const ft of FREE_PLACE_TYPES) {
    if (t.includes(ft)) return false;
  }
  return place.pricingEnabled !== false;
}

function budgetCapFor(budget) {
  return BUDGET_PRICE_CAP[(budget || "").toLowerCase()] ?? 4;
}

function passesBudgetFilter(place, profile) {
  if (!profile?.budgetRange) return true;
  const cap = budgetCapFor(profile.budgetRange);
  if (place.priceLevel != null && place.priceLevel > cap) return false;
  return true;
}

function buildDisplayTitle(activityType, period) {
  const a = (activityType || "").toLowerCase();
  const p = (period || "morning").toLowerCase();
  const MAP = {
    "morning-gym":           "Morning workout",
    "morning-yoga":          "Morning yoga",
    "morning-meditation":    "Morning meditation",
    "morning-coffee":        "Quick coffee break",
    "morning-work":          "Morning focus block",
    "morning-study":         "Morning study",
    "morning-walk":          "Sunrise walk",
    "morning-hiking":        "Morning hike",
    "morning-reading":       "Morning reading",
    "morning-prayer":        "Morning prayer",
    "morning-church":        "Morning service",
    "morning-mosque":        "Morning prayer",
    "afternoon-restaurant":  "Lunch break",
    "afternoon-coffee":      "Afternoon recharge",
    "afternoon-work":        "Deep work session",
    "afternoon-study":       "Study session",
    "afternoon-shopping":    "Quick errand run",
    "afternoon-walk":        "Walking break",
    "afternoon-meditation":  "Mindful pause",
    "afternoon-social":      "Afternoon meetup",
    "evening-restaurant":    "Dinner plans",
    "evening-social":        "Evening with friends",
    "evening-cinema":        "Movie night",
    "evening-walk":          "Sunset walk",
    "evening-hiking":        "Evening trail",
    "evening-church":        "Evening service",
    "evening-mosque":        "Evening prayer",
    "evening-events":        "Local event",
    "evening-networking":    "Networking mixer",
    "night-restaurant":      "Late bite",
    "night-social":          "Night out",
    "night-music":           "Live music",
    "night-walk":            "Calm night walk",
  };
  const key = `${p}-${a}`;
  if (MAP[key]) return MAP[key];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(p)} ${a}`;
}

// ─── Context engine — load every signal we will need ──────────────────────────

async function loadInteractions(uid) {
  try {
    const snap = await db.collection("interactions")
      .where("userId", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(HABIT_INTERACTION_WINDOW)
      .get();
    return snap.docs.map((d) => d.data());
  } catch {
    // Composite index issue → unordered fallback.
    try {
      const snap = await db.collection("interactions")
        .where("userId", "==", uid)
        .limit(HABIT_INTERACTION_WINDOW)
        .get();
      return snap.docs.map((d) => d.data());
    } catch (err) {
      logger.warn(`[aiSchedule] loadInteractions error: ${err.message}`);
      return [];
    }
  }
}

async function loadRoutinesForToday(uid) {
  try {
    const todayKey = WEEKDAY_KEYS[new Date().getDay()];
    const snap = await db.collection("routines").where("userId", "==", uid).get();
    return snap.docs
      .map((d) => d.data())
      .filter((r) => (r.weekday || "").toLowerCase() === todayKey);
  } catch (err) {
    logger.warn(`[aiSchedule] loadRoutines error: ${err.message}`);
    return [];
  }
}

async function loadPreferenceVector(uid) {
  if (!AI_SERVICE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_PREF_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_SERVICE_URL}/preferences/${encodeURIComponent(uid)}`, {
      method: "GET", signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build per-category affinity from the recent interaction window.
 * Uses exponential decay so older signals fade.
 */
function summariseInteractions(interactions) {
  const now = Date.now();
  const HALF_LIFE_MS = HABIT_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  const score = {};
  const counts = {};
  const slotScore = { morning: {}, afternoon: {}, evening: {}, night: {} };
  const completed = new Set();   // place ids the user has acted on positively
  const negativePlaces = new Set();
  let plannerCardClicks = 0;
  let plannerCompletions = 0;
  let plannerSkips = 0;

  for (const ix of interactions) {
    const type = ix?.metadata?.place?.type ?? ix?.metadata?.activityType ?? null;
    const action = ix?.actionType;
    if (!action) continue;
    const w = ACTION_WEIGHTS[action] ?? 0;
    if (!w) continue;

    // Time decay weight
    const ts = ix.createdAt ? new Date(ix.createdAt).getTime() : now;
    const ageMs = Math.max(0, now - ts);
    const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);

    // Planner usage analytics
    const src = ix?.metadata?.source ?? "";
    if (src.startsWith("ai_schedule")) {
      if (action === "click") plannerCardClicks += 1;
      if (action === "activity_complete" || action === "schedule_complete") plannerCompletions += 1;
      if (action === "dismiss" || action === "skip") plannerSkips += 1;
    }

    // Track per-place memory for diversity
    if (ix?.placeId) {
      if (w > 0) completed.add(ix.placeId);
      if (NEGATIVE_ACTIONS.has(action)) negativePlaces.add(ix.placeId);
    }

    if (!type) continue;
    const lt = String(type).toLowerCase();

    const slotKey = (() => {
      try {
        const hour = new Date(ts).getHours();
        return determinePeriodFromHour(hour);
      } catch { return "morning"; }
    })();

    score[lt] = (score[lt] ?? 0) + w * decay;
    counts[lt] = (counts[lt] ?? 0) + 1;
    slotScore[slotKey][lt] = (slotScore[slotKey][lt] ?? 0) + w * decay;
  }

  return {
    scoreByType: score,
    countsByType: counts,
    slotScoreByType: slotScore,
    completedPlaceIds: completed,
    negativePlaceIds: negativePlaces,
    plannerUsage: {
      cardClicks: plannerCardClicks,
      completions: plannerCompletions,
      skips: plannerSkips,
    },
  };
}

// ─── Adaptive slot selection ──────────────────────────────────────────────────

/** Period-appropriate suggestion pools. */
const PERIOD_DEFAULTS = {
  morning:   ["gym", "yoga", "coffee", "meditation", "walk", "work", "reading", "study"],
  afternoon: ["restaurant", "coffee", "work", "study", "walk", "shopping"],
  evening:   ["restaurant", "walk", "social", "events", "cinema", "music", "art", "park"],
  night:     ["walk", "social", "restaurant", "music"],
};

/**
 * Decide the activity types the planner will surface today.
 * Honours user routines first, then habits, then onboarding, then sensible defaults.
 * Suppresses any category with strongly negative signal and prevents the same
 * activity from being repeated across periods (unless it is a routine).
 */
function selectActivitiesForPeriod({
  period,
  routinesByPeriod,
  habitScoreByType,
  slotHabitScore,
  profile,
  globalUsed,            // Set<string> — activity types already placed today (non-routine)
  dailyCategoryCap,      // Map<string, number> — global occurrence cap per category
}) {
  const out = [];
  const defaultPool = PERIOD_DEFAULTS[period] ?? FALLBACK_ACTIVITY_POOL;

  // Helper: a category may appear at most once globally (non-routine path)
  // and only if it's a valid planner activity (not e.g. "hotel").
  const isUsable = (type) =>
    VALID_PLANNER_ACTIVITIES.has(type) &&
    !globalUsed.has(type) &&
    (dailyCategoryCap.get(type) ?? 0) < 1 &&
    (habitScoreByType[type] ?? 0) > -2;

  // 1. Routines for this period (always honoured — these CAN repeat).
  for (const r of routinesByPeriod[period] ?? []) {
    const t = (r.activityType || "social").toLowerCase();
    out.push({ type: t, source: "routine", routine: r, score: 5 });
  }

  // 2. Top habit categories — period-aware blend then global, must fit the pool.
  const habitEntries = [
    ...Object.entries(slotHabitScore[period] ?? {}).map(([t, s]) => [t, s + 0.5]),
    ...Object.entries(habitScoreByType).map(([t, s]) => [t, s]),
  ].filter(([t, _s]) => defaultPool.includes(t));
  habitEntries.sort((a, b) => b[1] - a[1]);

  for (const [type, score] of habitEntries) {
    if (out.length >= 3) break;
    if (score <= 0.5) break;
    if (!isUsable(type)) continue;
    if (out.find((s) => s.type === type)) continue;
    out.push({ type, source: "habit", score });
  }

  // 3. Onboarding signals — weeklyActivities + dailyRoutine + interests, scoped to pool.
  const wanted = new Set();
  if (Array.isArray(profile?.weeklyActivities)) {
    profile.weeklyActivities.forEach((a) => wanted.add(String(a).toLowerCase()));
  }
  if (Array.isArray(profile?.interests)) {
    profile.interests.forEach((a) => wanted.add(String(a).toLowerCase()));
  }
  const dailyBlock = profile?.dailyRoutine?.[period];
  if (Array.isArray(dailyBlock?.activities)) {
    dailyBlock.activities.forEach((a) => wanted.add(String(a).toLowerCase()));
  }

  for (const t of wanted) {
    if (out.length >= 3) break;
    if (out.find((s) => s.type === t)) continue;
    if (!defaultPool.includes(t)) continue;
    if (!isUsable(t)) continue;
    out.push({ type: t, source: "onboarding", score: 0.5 });
  }

  // 4. Religion injection — only added once during evening, ignores caps.
  const relAct = RELIGION_TO_ACTIVITY[(profile?.religion ?? "").toLowerCase()];
  if (relAct && period === "evening" && !globalUsed.has(relAct) && !out.find((s) => s.type === relAct)) {
    out.push({ type: relAct, source: "onboarding_religion", score: 1.5 });
  }

  // 5. Fill empty period with at least one default activity that hasn't been used.
  if (out.length === 0) {
    const fallback = defaultPool.find((t) => isUsable(t)) ?? defaultPool[0];
    if (fallback) out.push({ type: fallback, source: "default", score: 0.2 });
  }

  const final = out.slice(0, 3);
  for (const a of final) {
    if (a.source !== "routine") globalUsed.add(a.type);
    dailyCategoryCap.set(a.type, (dailyCategoryCap.get(a.type) ?? 0) + 1);
  }
  return final;
}

/**
 * Spread activities across the day using wake/sleep boundaries.
 */
function distributeActivities(activitiesByPeriod, profile) {
  const { h: wakeH, m: wakeM } = parseHHmm(profile?.wakeTime ?? "07:00");
  const { h: bedH }            = parseHHmm(profile?.sleepTime ?? "23:00");

  const wakeMin = wakeH * 60 + wakeM;
  const bedMin  = bedH  * 60;

  const periodBounds = {
    morning:   { start: Math.max(wakeMin, 5 * 60), end: 12 * 60 },
    afternoon: { start: 12 * 60, end: 17 * 60 },
    evening:   { start: 17 * 60, end: Math.max(18 * 60, Math.min(21 * 60, bedMin - 60)) },
    night:     { start: 21 * 60, end: Math.max(22 * 60, bedMin) },
  };

  const slots = [];
  let colorIdx = 0;

  for (const period of ["morning", "afternoon", "evening", "night"]) {
    const list  = activitiesByPeriod[period] ?? [];
    if (list.length === 0) continue;
    const { start, end } = periodBounds[period];
    const span = Math.max(60, end - start);
    const step = Math.max(45, Math.floor(span / list.length));

    list.forEach((a, idx) => {
      const t = start + idx * step;
      const time = minutesToHHmm(Math.min(t, end - 30));
      const title = buildDisplayTitle(a.type, period);
      slots.push({
        id:           a.routine?.id ?? `${period}-${a.type}-${idx}-${a.source}`,
        period,
        time,
        activityType: a.type,
        title,
        icon:         activityIcon(a.type),
        color:        ACTIVITY_COLORS[colorIdx++ % ACTIVITY_COLORS.length],
        duration:     activityDuration(a.type),
        source:       a.source === "habit" ? "ai_inferred" : a.source,
        routineId:    a.routine?.id ?? null,
        locationPreference: (a.routine?.locationPreference || profile?.locationPreference || "any").toLowerCase(),
        budgetRange:        (a.routine?.budgetRange         || profile?.budgetRange        || "medium").toLowerCase(),
        score:        a.score ?? 0.5,
      });
    });
  }

  return slots;
}

function insertMicroActivities(slots, profile, habitScoreByType) {
  if (slots.length < 2) return slots;
  const result = [];
  let microCount = 0;

  const microCandidates = [
    { id: "micro-coffee",    activityType: "coffee",     title: "Quick coffee break",  duration: "20 min", icon: "cafe",            color: "#F472B6", baseReason: "Short recharge between activities" },
    { id: "micro-walk",      activityType: "walk",       title: "Short walk",          duration: "20 min", icon: "footsteps-outline", color: "#38BDF8", baseReason: "Movement keeps your energy and focus up" },
    { id: "micro-workspace", activityType: "study",      title: "Quiet work spot",     duration: "45 min", icon: "laptop-outline",   color: "#A3E635", baseReason: "Make the most of your free time" },
    { id: "micro-reading",   activityType: "reading",    title: "Reading break",       duration: "30 min", icon: "book-outline",     color: "#6366F1", baseReason: "A calm spot nearby to reset your mind" },
    { id: "micro-meditate",  activityType: "meditation", title: "Mindful pause",       duration: "10 min", icon: "leaf-outline",     color: "#10B981", baseReason: "A few breathing minutes to reset" },
  ];

  const isBlocked = (type) => (habitScoreByType[type] ?? 0) < -1.5;

  for (let i = 0; i < slots.length; i++) {
    result.push(slots[i]);
    if (i >= slots.length - 1 || microCount >= MICRO_DAILY_CAP) continue;
    const curr = slots[i];
    const next = slots[i + 1];
    const gap = timeToMinutes(next.time) - timeToMinutes(curr.time);
    if (gap < MICRO_GAP_MIN || gap > MICRO_GAP_MAX) continue;

    const prevAct = (curr.activityType || "").toLowerCase();
    let template = microCandidates[0];
    if (prevAct === "gym" || prevAct === "yoga") template = microCandidates[0];
    else if (prevAct === "work" || prevAct === "study") template = microCandidates[1];
    else if (gap >= 150) template = microCandidates[2];
    else template = microCandidates[3];
    if (isBlocked(template.activityType)) template = microCandidates.find((t) => !isBlocked(t.activityType)) ?? template;

    const midM   = timeToMinutes(curr.time) + Math.floor(gap * 0.45);
    const hour   = Math.floor(midM / 60) % 24;
    const period = determinePeriodFromHour(hour);

    microCount += 1;
    result.push({
      ...template,
      id:           `${template.id}-${i}`,
      period,
      time:         minutesToHHmm(midM),
      source:       "ai_inferred",
      routineId:    null,
      locationPreference: "any",
      budgetRange:  profile?.budgetRange ?? "medium",
      isMicro:      true,
      score:        0.6,
    });
  }
  return result;
}

// ─── Place enrichment (multi-pick per slot, batched) ──────────────────────────

function resolveDiscoverKey(slot) {
  if (slot.activityType === "prayer") {
    // Use religion-aware fallback if available; otherwise nothing.
    return slot.budgetRange === "low" ? "church" : null;
  }
  return ACTIVITY_TO_DISCOVER_KEY[slot.activityType] ?? null;
}

function negativeFilter(place, negativePlaceIds) {
  const id = place.placeId ?? place.id;
  return !id || !negativePlaceIds.has(id);
}

function shapePlaceForSlot(chosen) {
  const pe = pricingEnabled(chosen);
  return {
    id:              chosen.placeId ?? chosen.id,
    placeId:         chosen.placeId ?? chosen.id,
    name:            chosen.name ?? "Recommended place",
    type:            chosen.type ?? chosen.category ?? "",
    category:        chosen.category ?? chosen.type ?? "",
    distance:        chosen.distanceText ?? chosen.distance ?? "Nearby",
    rating:          chosen.rating ?? null,
    userRatingsTotal: chosen.userRatingsTotal ?? null,
    images:          Array.isArray(chosen.images) ? chosen.images : [],
    image:           chosen.image ?? null,
    reason:          chosen.reason ?? null,
    budgetFit:       chosen.budgetFit ?? null,
    matches:         chosen.matches ?? null,
    matchPercent:    chosen.matchPercent ?? chosen.match_percent ?? null,
    priceLevel:      pe ? (chosen.priceLevel ?? null) : null,
    estimatedCost:   pe ? (chosen.estimatedCost ?? null) : null,
    priceCategory:   pe ? (chosen.priceCategory ?? null) : null,
    pricingEnabled:  pe,
    score:           chosen.finalScore ?? chosen.aiScore ?? chosen.score ?? null,
    aiScore:         chosen.aiScore ?? null,
    lat:             chosen.lat ?? null,
    lng:             chosen.lng ?? null,
    address:         chosen.address ?? null,
    isOpen:          chosen.isOpen ?? null,
    openingHours:    chosen.openingHours ?? null,
    photoReferences: chosen.photoReferences ?? null,
    ...chosen,
  };
}

async function enrichSlotWithPlaces(slot, uid, userLocation, profile, signals) {
  const discoverKey = slot.isMicro
    ? (slot.discoverKey ?? ACTIVITY_TO_DISCOVER_KEY[slot.activityType] ?? null)
    : resolveDiscoverKey(slot);
  if (!discoverKey) return { ...slot, places: [], place: null };

  try {
    const { recommendations } = await getRecommendations(
      uid,
      false,
      8,                 // pull more so we can filter and pick best 3
      userLocation,
      true,              // fastMode for planner latency
      null,
      null,
      discoverKey,
    );

    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      return { ...slot, places: [], place: null };
    }

    const filtered = recommendations
      .filter((p) => negativeFilter(p, signals.negativePlaceIds))
      .filter((p) => passesBudgetFilter(p, profile));

    const chosen = filtered.slice(0, PLACES_PER_SLOT).map(shapePlaceForSlot);

    return {
      ...slot,
      places: chosen,
      // Legacy alias — older mobile clients read `slot.place` directly.
      place:  chosen[0] ?? null,
    };
  } catch (err) {
    logger.warn(`[aiSchedule] enrich(${slot.id}) error: ${err.message}`);
    return { ...slot, places: [], place: null };
  }
}

// ─── Reasons & badges ─────────────────────────────────────────────────────────

const PERIOD_LABEL = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" };

function buildReason(slot, profile, signals, topAffinity) {
  const a = (slot.activityType || "").toLowerCase();
  const period = slot.period ?? "morning";
  const habitScore = signals.scoreByType[a] ?? 0;
  const interactionCount = signals.countsByType[a] ?? 0;

  if (slot.isMicro) {
    if (habitScore > 1) return `You take ${a} breaks often — perfect spot between blocks.`;
    return "Short reset between activities to keep your energy up.";
  }
  if (slot.source === "routine") {
    return `From your ${PERIOD_LABEL[period]} routine.`;
  }
  if (slot.source === "onboarding_religion") {
    return `Matches your ${profile?.religion ?? "religion"} community time.`;
  }
  if (slot.source === "ai_inferred") {
    if (interactionCount >= 4 && habitScore > 2) {
      return `Learned from your recent ${a} activity (${interactionCount} signals).`;
    }
    if (topAffinity && topAffinity[0] && topAffinity[0][0] !== a) {
      return `You often engage with ${topAffinity[0][0]} — ${a} pairs well in the ${PERIOD_LABEL[period]}.`;
    }
    return `Suggested for your ${PERIOD_LABEL[period]} rhythm.`;
  }
  if (slot.source === "onboarding") {
    const onboardingHit = (profile?.weeklyActivities ?? []).map((x) => String(x).toLowerCase()).includes(a);
    if (onboardingHit) return `From your onboarding — you said you like ${a}.`;
    return `Matches your ${slot.budgetRange ?? "everyday"} budget and ${PERIOD_LABEL[period]} window.`;
  }
  return `A good ${PERIOD_LABEL[period]} option near you.`;
}

function buildBadges(slot, profile, signals, topAffinity) {
  const badges = [];
  const a = (slot.activityType || "").toLowerCase();
  const habitScore = signals.scoreByType[a] ?? 0;
  const interactionCount = signals.countsByType[a] ?? 0;

  if (slot.source === "routine") {
    badges.push({ key: "routine", label: "Your routine", variant: "purple" });
  } else if (habitScore > 2 && interactionCount >= 3) {
    badges.push({ key: "habit", label: "Learned habit", variant: "blue" });
  } else if (slot.source === "ai_inferred") {
    badges.push({ key: "ai", label: "AI inferred", variant: "teal" });
  } else if (slot.source === "onboarding_religion") {
    badges.push({ key: "religion", label: "Faith time", variant: "purple" });
  } else {
    badges.push({ key: "profile", label: "From profile", variant: "blue" });
  }

  const firstPlace = slot.places?.[0];
  if (firstPlace?.budgetFit === true || firstPlace?.matches?.budget === true) {
    badges.push({ key: "budget", label: "Matches your budget", variant: "green" });
  }
  if (firstPlace?.rating != null && firstPlace.rating >= 4.3) {
    badges.push({ key: "popular", label: "Highly rated nearby", variant: "orange" });
  }
  if (topAffinity?.[0]?.[0] === a && (topAffinity[0][1] ?? 0) >= 0.7) {
    badges.push({ key: "top-cat", label: "Your top category", variant: "teal" });
  }

  return badges.slice(0, 3);
}

function computeSlotConfidence(slot, signals, topAffinity) {
  const a = (slot.activityType || "").toLowerCase();
  const habitScore = signals.scoreByType[a] ?? 0;
  const baseBySource = {
    routine:              0.95,
    onboarding_religion:  0.85,
    ai_inferred:          0.65,
    onboarding:           0.6,
    default:              0.45,
  };
  let confidence = baseBySource[slot.source] ?? 0.55;
  if (habitScore > 2)            confidence += 0.08;
  if (habitScore > 4)            confidence += 0.07;
  if (slot.places?.length > 0)   confidence += 0.05;
  if (topAffinity?.find(([k, _v]) => k === a)) confidence += 0.05;
  if (habitScore < -2)           confidence -= 0.20;
  return Math.max(0.1, Math.min(1, parseFloat(confidence.toFixed(2))));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} uid
 * @param {{ lat:number, lng:number, radiusMeters:number }|null} userLocation
 * @param {{ refresh?: boolean }} [opts]
 */
export async function getAiDailySchedule(uid, userLocation = null, opts = {}) {
  const t0 = Date.now();
  const { refresh = false } = opts;

  // Plan cache key — stable per uid + today + coarse location.
  const dateKey = new Date().toISOString().slice(0, 10);
  const locKey = userLocation?.lat != null
    ? `${Math.round(userLocation.lat * 100) / 100}_${Math.round(userLocation.lng * 100) / 100}`
    : "static";
  const cacheKey = `plan:${uid}:${dateKey}:${locKey}`;

  if (refresh) invalidatePlan(uid);
  const cached = !refresh ? getCachedPlan(cacheKey) : null;
  if (cached) {
    return { ...cached, meta: { ...cached.meta, cacheHit: true } };
  }

  // ── Load every signal in parallel ──────────────────────────────────────────
  const [profile, routinesToday, interactions, prefVector] = await Promise.all([
    getUserById(uid).catch(() => null),
    loadRoutinesForToday(uid),
    loadInteractions(uid),
    loadPreferenceVector(uid),
  ]);

  const signals = summariseInteractions(interactions);
  const topAffinity = Array.isArray(prefVector?.top_categories)
    ? prefVector.top_categories
    : Object.entries(signals.scoreByType).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ── Group routines by period ───────────────────────────────────────────────
  const routinesByPeriod = { morning: [], afternoon: [], evening: [], night: [] };
  for (const r of routinesToday) {
    const p = determinePeriod(r.timeOfDay);
    routinesByPeriod[p].push(r);
  }
  routinesByPeriod.morning.sort((a, b) => PERIOD_ORDER.morning - PERIOD_ORDER.morning);

  // ── Choose activities per period ───────────────────────────────────────────
  const dailyCategoryCap = new Map();
  const globalUsed = new Set();
  const activitiesByPeriod = {};
  for (const period of ["morning", "afternoon", "evening", "night"]) {
    activitiesByPeriod[period] = selectActivitiesForPeriod({
      period,
      routinesByPeriod,
      habitScoreByType: signals.scoreByType,
      slotHabitScore:   signals.slotScoreByType,
      profile:          profile ?? {},
      globalUsed,
      dailyCategoryCap,
    });
  }

  // ── Distribute on the timeline ────────────────────────────────────────────
  const raw   = distributeActivities(activitiesByPeriod, profile ?? {});
  const all   = insertMicroActivities(raw, profile ?? {}, signals.scoreByType);

  // ── Enrich every slot concurrently with up to PLACES_PER_SLOT places ───────
  const enriched = await Promise.all(
    all.map((s) => enrichSlotWithPlaces(s, uid, userLocation, profile ?? {}, signals)),
  );

  // ── Cross-slot dedup: a single place must not appear in two activity cards.
  // Stronger-confidence slots win; weaker slots get fresh picks (up to 3 of
  // whatever's left from their own candidate list).
  enriched.sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
  const usedPlaceIds = new Set();
  for (const slot of enriched) {
    if (!Array.isArray(slot.places) || slot.places.length === 0) continue;
    const kept = [];
    for (const p of slot.places) {
      const id = p.placeId ?? p.id;
      if (!id || usedPlaceIds.has(id)) continue;
      kept.push(p);
      usedPlaceIds.add(id);
      if (kept.length >= PLACES_PER_SLOT) break;
    }
    slot.places = kept;
    slot.place  = kept[0] ?? null;
  }

  // ── Reasons, badges, confidence ────────────────────────────────────────────
  const finalSlots = enriched.map((slot) => ({
    ...slot,
    reason: buildReason(slot, profile ?? {}, signals, topAffinity),
    badges: buildBadges(slot, profile ?? {}, signals, topAffinity),
    confidence: computeSlotConfidence(slot, signals, topAffinity),
  }));

  // ── Final composition into period buckets ─────────────────────────────────
  const schedule = { morning: [], afternoon: [], evening: [], night: [] };
  for (const slot of finalSlots) {
    const p = slot.period ?? "morning";
    if (schedule[p]) schedule[p].push(slot);
  }
  for (const p of Object.keys(schedule)) {
    schedule[p].sort((a, b) => (a.time ?? "00:00").localeCompare(b.time ?? "00:00"));
  }

  // ── Meta ──────────────────────────────────────────────────────────────────
  const hasRoutines    = routinesToday.length > 0;
  const hasInteractions = interactions.length >= 10;
  const hasLearnedAffinity = (topAffinity?.[0]?.[1] ?? 0) >= 0.6;

  const personalizationLevel =
    hasLearnedAffinity || (hasRoutines && hasInteractions) ? "high"   :
    hasRoutines || hasInteractions                          ? "medium" : "low";

  const basedOn = [];
  if (hasRoutines)                                      basedOn.push("routines");
  if (interactions.length > 0)                          basedOn.push("interactions");
  if ((profile?.weeklyActivities?.length ?? 0) > 0)     basedOn.push("profile");
  if (hasLearnedAffinity)                               basedOn.push("learned affinity");

  const microCount  = finalSlots.filter((s) => s.isMicro).length;
  const placeCount  = finalSlots.reduce((sum, s) => sum + (s.places?.length ?? 0), 0);

  const result = {
    schedule,
    meta: {
      personalizationLevel,
      basedOn,
      generatedAt:        new Date().toISOString(),
      elapsedMs:          Date.now() - t0,
      todayRoutineCount:  routinesToday.length,
      microActivities:    microCount,
      interactionCount:   interactions.length,
      totalPlaces:        placeCount,
      topCategories:      topAffinity.slice(0, 5).map(([cat, score]) => ({ category: cat, score })),
      plannerUsage:       signals.plannerUsage,
      cacheHit:           false,
    },
  };

  setCachedPlan(cacheKey, result);
  logger.info(
    `[aiSchedule] uid=${uid} slots=${finalSlots.length} places=${placeCount} ` +
    `micro=${microCount} top=${topAffinity[0]?.[0] ?? "none"} ` +
    `level=${personalizationLevel} elapsed=${result.meta.elapsedMs}ms`,
  );
  return result;
}

/** Externally invalidate a user's cached plan (e.g. after a profile edit). */
export function invalidatePlanForUser(uid) {
  if (!uid) return;
  invalidatePlan(uid);
}
