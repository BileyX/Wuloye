/**
 * recommendation.service.js — Personalized recommendation engine (v17).
 *
 * v17 change: A/B experiment — deterministic variant A/B, blend weights, meta.experiment,
 *   cache key includes variant when EXPERIMENT_ACTIVE=true (see utils/experiment.js).
 *
 * v16 change: advanced personalization layer.
 *   - buildTopInterestWeights: recency + decay + typeAffinity + declared interests →
 *     normalized weights; multiInterestBoost scales with rank among top-K types.
 *   - detectDominantHabits: morning_gym, weekend_social, weekend_coffee from timestamps.
 *   - habitContextBoost: current context matches habit + place type.
 *   - contextStackBoost: sessionIntent + detectedIntent + place type + habit/weight align.
 *   - enforceMaxSameTypeInTopN: max 2 identical types in top 5 after final ordering.
 *   - meta.personalization: { dominantHabits, topInterestWeights }.
 *
 * v15 change: performance optimization and scaling.
 *   - Recommendation cache: TTL configurable (RECOMMENDATION_CACHE_TTL_MS, default 5 min).
 *     Cache hits skip Firestore and scoring.  Debug requests never cached.
 *   - Profile data cache: 4 Firestore reads bundled 30 s (profileDataCache).
 *   - derivedSignalsCache: precomputed affinity maps + interaction index + signal
 *     sets per user/location/fingerprint (60 s TTL); invalidated on interaction.
 *   - Parallel scoring: places scored in chunks via setImmediate + Promise.all.
 *   - Load fallback: RECOMMENDATIONS_HIGH_LOAD=true or concurrent requests
 *     > RECOMMENDATION_HIGH_LOAD_CONCURRENT auto-enables fast mode (skip Rule 21+25).
 *   - Fast mode: ?fast=true — same as load fallback; meta.performance.heavyLoadFallback
 *     distinguishes auto vs explicit.
 *   - Batch interactions: POST /api/interactions/batch — single Firestore batch write.
 *   - meta.performance: elapsedMs, cacheHit, fallbackActive, heavyLoadFallback, placesScored.
 *   - Target <300 ms: SLOW log when exceeded; Redis optional (in-memory TtlCache default).
 *
 * v14 change: real-world data integration via Google Maps Places API.
 *   - getRecommendations() accepts an optional userLocation { lat, lng, radiusMeters }.
 *     When provided (and GOOGLE_MAPS_API_KEY is set), the place catalogue is sourced
 *     from Google Maps Nearby Search instead of static Firestore data.
 *   - Rule 26: closedPenalty (-5) applied when place.isOpen === false.
 *   - Rule 27: trendBoost (0–3) applied when place.trendScore >= 0.5 (trending places
 *     detected from high rating × high review volume via Google data).
 *   - meta.location: { source, radiusUsed, resultsFetched } added to response.
 *   - Fully backwards-compatible: falls back to Firestore when no location or key.
 *
 * v13 change: feedback-loop optimization.
 *   - interactionAgeDecayWeight: last 24h=1.0, 24h–7d=0.7, 7d+=0.4 applied to
 *     buildRecentAffinityMap and buildInteractionIndex so older behaviour fades.
 *   - detectBehaviorShift: last-10 vs historical mean action score; when shift
 *     detected, longTermAffinityBoost is reduced, recentBoost and session match
 *     boost are amplified.
 *   - balanceLearningSignals: caps long-term / recent / session positive mass
 *     so none exceeds 40% of their combined positive total.
 *   - meta.learning: recencyWeightActive, behaviorShiftDetected.
 *
 * v12 change: expanded AI training pipeline.
 *   - Feature vector expanded from 7 → 10 dimensions, now including
 *     placeTypeIndex, timeOfDayIndex, dayOfWeek, sessionIntentIndex,
 *     domSessTypeIndex, embeddingScore, longTermAffinity, typeAffinityNorm,
 *     placeInteractNorm, placeRating.
 *   - Model persists to Firestore (models/current) as primary store;
 *     data/model.json is kept as a file backup.
 *   - Version increments automatically on every retrain (v1 → v2 → …).
 *   - Retrain interval tightened to every 20 interactions (was 100).
 *   - initModelCache() warms the in-memory model at server startup.
 *   - Rule 25 feature vector updated to match the new 10-dim FEATURE_NAMES.
 *
 * v11 change: real AI / machine-learning layer.
 *   - Linear regression trained via gradient descent; blended 70/30 with rules.
 *
 * v10 change: exploration vs exploitation balance.
 *
 * v9 change: long-term memory + user embedding engine.
 *
 * v8 change: session intelligence + sequential prediction.
 *
 * v7 change: context awareness + intent prediction.
 *
 * v6 change: real-time learning + persistent intelligence.
 *
 * All v4–v11 rules are untouched.
 */

import { db }          from "../config/firebase.js";
import { getUserById }  from "./user.service.js";
import { getAllPlaces }  from "./place.service.js";
import { getNearbyPlacesForDiscoverKey } from "./googlePlaces.service.js";
import { getUpcomingEvents } from "./event.service.js";
import { buildContext } from "../utils/context.js";
import { SEED_PLACES }  from "../data/places.seed.js";
import {
  getSession,
  computeDominantSessionType,
  computeSessionIntent,
  SEQUENCE_BOOST_MAP,
  SESSION_INTENT_OVERRIDE_MIN,
} from "./session.service.js";
import {
  buildPlaceEmbedding,
  cosineSimilarity,
  topEmbeddingEntry,
} from "../utils/embedding.js";
import {
  predict      as modelPredict,
  loadModel,
  isLoaded     as isModelLoaded,
} from "./ai/modelService.js";
import {
  encodeType,
  encodeTimeOfDay,
  encodeIntent,
} from "./ai/trainingDataBuilder.js";
import {
  interactionAgeDecayWeight,
  detectBehaviorShift,
  balanceLearningSignals,
} from "../utils/learning.js";
import {
  recommendationCache,
  profileDataCache,
  derivedSignalsCache,
  invalidateUserRecommendationCaches,
} from "../utils/cache.js";
import {
  buildTopInterestWeights,
  multiInterestBalanceBoost,
  detectDominantHabits,
  computeHabitContextBoost,
  computeContextStackBoost,
  topWeightsForMeta,
  enforceMaxSameTypeInTopN,
  weeklyActivitiesBoost,
  genderContextScore,
} from "../utils/personalization.js";
import {
  isExperimentActive,
  getVariantForUser,
  getBlendWeightsForVariant,
  EXPERIMENT_ID,
} from "../utils/experiment.js";
import { logger } from "../utils/logger.js";
import { buildPlacePhotoPaths } from "../utils/placePhotoPaths.js";
import { placeMatchesDiscoverKey } from "../utils/discoverCategory.js";
import {
  classifyPrice,
  tierToNumber,
  userBudgetTier,
  placeAllowedByReligion,
  resolvePricingEligibility,
} from "../utils/pricing.utils.js";
import { classifyDenomination } from "../utils/denominationClassifier.js";

const ROUTINES_COLLECTION     = "routines";
const INTERACTIONS_COLLECTION = "interactions";

// ─── AI Microservice integration ──────────────────────────────────────────────
// AI_SERVICE_URL defaults to the Docker-compose service name so it works
// inside the shared wuloye-network without configuration.
// Override with AI_SERVICE_URL=http://localhost:8000 for local dev.

const AI_SERVICE_URL     = process.env.AI_SERVICE_URL || "http://ai-service:8000";
const AI_SERVICE_TIMEOUT = parseInt(process.env.AI_SERVICE_TIMEOUT_MS || "800", 10);

/**
 * Calls the Python AI service /predict endpoint and returns a Map of
 * placeId → aiScore.  Returns an empty Map when:
 *   - AI_SERVICE_ENABLED=false
 *   - fastMode is active
 *   - The service is unreachable or times out
 *   - Any other error
 *
 * Failure is always non-fatal — the caller falls back to rawScore only.
 *
 * @param {string}   userId
 * @param {object[]} candidates — scored place entries [{id, type, name, rawScore, …}]
 * @param {object}   context    — {timeOfDay, …}
 * @param {object[]} recentActions — session actions [{type, …}]
 * @param {object}   typeAffinity — user.typeAffinity map
 * @param {object}   [userProfile={}] — full user profile for onboarding signal forwarding
 * @returns {Promise<Map<string, number>>}
 */
/**
 * Convert the user's numeric weeklyBudget (ETB) to the standardized
 * 'cheap | mid | expensive' tier. Mirrors AI service `budget_amount_to_tier`.
 */
const weeklyBudgetToTier = (amount) => {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return "mid";
  }
  // Unified thresholds (aligned with mobile onboarding, backend pricing.utils, and AI service)
  if (amount <= 2000)  return "cheap";
  if (amount <= 10000) return "mid";
  return "expensive";
};

const budgetLabelToTier = (label) => {
  if (!label) return "mid";
  const v = String(label).trim().toLowerCase();
  if (["cheap", "low", "budget", "affordable"].includes(v)) return "cheap";
  if (["mid", "medium", "moderate", "standard"].includes(v)) return "mid";
  if (["expensive", "high", "luxury", "premium", "flexible"].includes(v)) return "expensive";
  return "mid";
};

/**
 * Calls /predict on the Python AI service and returns the per-place enrichment
 * map (score + price + reason) plus model metadata.  Always resolves; never throws.
 *
 * @param {string} userId
 * @param {object[]} candidates - scored place entries [{id, type, name, ...}]
 * @param {object} context - {timeOfDay, detectedIntent, discoverCategoryKey, ...}
 * @param {object[]} recentActions - session actions [{type, ...}]
 * @param {object} typeAffinity - user.typeAffinity map (raw [-50,50] scale)
 * @param {object} [profile={}] - full user profile, for onboarding signal forwarding
 * @returns {Promise<{
 *   scoreMap: Map<string, number>,
 *   enrichmentMap: Map<string, {
 *     pricingEnabled:boolean, pricingReason:string|null,
 *     priceLevel:string|null, priceConfidence:number, priceSignals:string[],
 *     estimatedCost:Record<string,string>, priceCategory:string,
 *     reason:string|null, budgetFit:boolean
 *   }>,
 *   predictedType: string|null,
 *   confidence: number,
 *   modelVersion: string,
 *   llmEnabled: boolean
 * }>}
 */
const callAiService = async (
  userId,
  candidates,
  context,
  recentActions,
  typeAffinity,
  profile = {},
  negativeMemory = {},
) => {
  const EMPTY = {
    scoreMap:      new Map(),
    enrichmentMap: new Map(),
    predictedType: null,
    confidence:    0,
    modelVersion:  "v0",
    llmEnabled:    false,
  };
  if (process.env.AI_SERVICE_ENABLED === "false") return EMPTY;
  if (!candidates.length) return EMPTY;

  const recentTypes = (recentActions || [])
    .slice(0, 10)
    .map((a) => a.type)
    .filter(Boolean);

  // Normalise typeAffinity map from [-50,50] to [0,1] for the AI service
  const AFFINITY_CAP = 50;
  const normAffinity = {};
  for (const [t, v] of Object.entries(typeAffinity || {})) {
    normAffinity[t] = (v + AFFINITY_CAP) / (2 * AFFINITY_CAP);
  }

  // Budget normalisation — prefer numeric weeklyBudget, fall back to label.
  const budgetTier =
    typeof profile?.weeklyBudget === "number"
      ? weeklyBudgetToTier(profile.weeklyBudget)
      : budgetLabelToTier(profile?.budgetRange);

  // Decide whether to ask the LLM for explanations on this call.  Off by default
  // when fastMode is on (caller already excluded fast mode here, see below),
  // and capped by an env flag so we can turn it off in production if needed.
  const explainEnabled =
    process.env.AI_EXPLAIN_ENABLED !== "false" &&
    candidates.length <= parseInt(process.env.AI_EXPLAIN_MAX_CANDIDATES || "20", 10);

  const payload = {
    user_id: userId,
    candidates: candidates.map((p) => ({
      place_id:          p.id,
      place_type:        p.type,
      place_name:        p.name || "",
      place_description: p.description || "",
      rating:            p.rating ?? 3.0,
      raw_score:         p.rawScore ?? 0,
      address:            p.address  ?? p.vicinity ?? "",
      user_ratings_total: p.userRatingsTotal ?? 0,
      price_level:        p.googlePriceLevel ?? p.priceLevel ?? null,
      tags:               Array.isArray(p.tags) ? p.tags : [],
      reviews:            Array.isArray(p.reviews) ? p.reviews.slice(0, 5) : [],
    })),
    context: {
      time_of_day:        context.timeOfDay || "morning",
      session_intent:     context.detectedIntent || "explore",
      recent_types:       recentTypes,
      type_affinity:      normAffinity,
      // Onboarding signals (standardized AI input — keep in sync with predict.py ContextIn)
      budget:             budgetTier,
      weekly_budget:      typeof profile?.weeklyBudget === "number" ? profile.weeklyBudget : null,
      budget_range:       profile?.budgetRange || "",
      religion:           profile?.religion || "",
      gender:             profile?.gender || "",
      weekend_preference: profile?.weekendPreference || "",
      event_interests:    Array.isArray(profile?.eventInterests) ? profile.eventInterests : [],
      interests:          Array.isArray(profile?.interests) ? profile.interests : [],
      weekly_activities:  Array.isArray(profile?.weeklyActivities) ? profile.weeklyActivities : [],
      daily_routine:      profile?.dailyRoutine && typeof profile.dailyRoutine === "object"
                            ? profile.dailyRoutine
                            : {},
      wake_time:          profile?.wakeTime || "",
      sleep_time:         profile?.sleepTime || "",
      // Persona signals (NEW) — forwarded so the AI service can infer
      // working-professional vs student / quiet vs social personas.
      age_group:          profile?.ageGroup || "",
      location_preference: profile?.locationPreference || "",
      // workingHours is an object ({flexible, morning, afternoon}) — serialize to a
      // plain string so Pydantic Optional[str] validation never rejects with 422.
      working_hours: (() => {
        const wh = profile?.workingHours;
        if (!wh) return "";
        if (typeof wh === "string") return wh;
        if (wh.flexible) return "flexible";
        // Build "HH:mm-HH:mm" from the first available period
        const morning   = wh.morning   || wh.am || null;
        const afternoon = wh.afternoon || wh.pm || null;
        const period    = morning || afternoon;
        if (period?.start && period?.end) return `${period.start}-${period.end}`;
        return "fixed";
      })(),
      explain:            explainEnabled,
      // v18: persistent per-place negative memory — AI hard-blocks dislikes
      // and strongly penalises dismisses regardless of recent-interaction window.
      disliked_place_ids:      Array.isArray(negativeMemory.dislikedPlaceIds)
                                  ? negativeMemory.dislikedPlaceIds.slice(0, 500)
                                  : [],
      dismissed_place_ids:     Array.isArray(negativeMemory.dismissedPlaceIds)
                                  ? negativeMemory.dismissedPlaceIds.slice(0, 500)
                                  : [],
      not_interested_place_ids: Array.isArray(negativeMemory.notInterestedPlaceIds)
                                  ? negativeMemory.notInterestedPlaceIds.slice(0, 500)
                                  : [],
      saved_place_ids:         Array.isArray(negativeMemory.savedPlaceIds)
                                  ? negativeMemory.savedPlaceIds.slice(0, 500)
                                  : [],
      ...(context.discoverCategoryKey
        ? { discover_category: context.discoverCategoryKey }
        : {}),
    },
  };

  const controller = new AbortController();
  // When explanations are on we allow a slightly longer budget — LLM calls can take ~1-2s.
  const timeoutMs = explainEnabled
    ? Math.max(AI_SERVICE_TIMEOUT, parseInt(process.env.AI_PREDICT_EXPLAIN_TIMEOUT_MS || "3500", 10))
    : AI_SERVICE_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${AI_SERVICE_URL}/predict`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    if (!res.ok) {
      logger.warn(`[AI] /predict returned HTTP ${res.status}`);
      return EMPTY;
    }

    const data = await res.json();
    const scoreMap      = new Map();
    const enrichmentMap = new Map();
    for (const item of (data.ranked_places || [])) {
      scoreMap.set(item.place_id, item.ai_score);
      const aiPricingExplicit = typeof item.pricing_enabled === "boolean";
      const pricingEnabled = aiPricingExplicit
        ? item.pricing_enabled === true
        : Boolean(item.price_level);
      enrichmentMap.set(item.place_id, {
        pricingEnabled,
        pricingReason:  item.pricing_reason  ?? null,
        priceLevel:     pricingEnabled ? (item.price_level ?? null) : null,
        priceConfidence: item.price_confidence ?? 0,
        priceSignals:   item.price_signals    ?? [],
        estimatedCost:  pricingEnabled ? (item.estimated_cost ?? {}) : {},
        priceCategory:  item.price_category   ?? "dining",
        reason:         item.reason           ?? null,
        budgetFit:      item.budget_fit       !== false,
        religionMatch:  item.religion_match   !== false,
        lifestyleMatch: item.lifestyle_match  === true,
        matchPercent:   typeof item.match_percent === "number" ? item.match_percent : null,
        // Persona alignment (NEW)
        personaMatch:   item.persona_match    ?? null,
        personaScore:   typeof item.persona_score === "number" ? item.persona_score : 0,
        personaReasons: Array.isArray(item.persona_reasons) ? item.persona_reasons : [],
      });
    }
    logger.debug(`[AI] /predict OK — ${scoreMap.size} scores in ${data.inference_ms}ms (budget=${budgetTier})`);
    return {
      scoreMap,
      enrichmentMap,
      predictedType: data.predicted_type ?? null,
      confidence:    data.confidence    ?? 0,
      modelVersion:  data.model_version ?? "v0",
      llmEnabled:    data.llm_enabled   ?? false,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      logger.warn(`[AI] /predict timed out after ${timeoutMs}ms — falling back to rawScore`);
    } else {
      logger.warn(`[AI] /predict failed: ${err.message} — falling back to rawScore`);
    }
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
};

/** Phase 15: concurrent /recommendations in flight — above this, auto fast mode. */
const concurrentRecommendationRequests = { count: 0 };
const HIGH_LOAD_CONCURRENT = parseInt(process.env.RECOMMENDATION_HIGH_LOAD_CONCURRENT || "8", 10);
/** Recommendation result cache TTL (ms). Default 5 minutes (within 1–5 min spec). */
const RECOMMENDATION_CACHE_TTL_MS = parseInt(process.env.RECOMMENDATION_CACHE_TTL_MS || "300000", 10);
/** Longer TTL for Discover chip results (same location + category). */
const DISCOVER_CACHE_TTL_MS = parseInt(process.env.DISCOVER_CACHE_TTL_MS || "600000", 10);

const recommendationCacheTtl = (discoverCategoryKey) =>
  discoverCategoryKey ? DISCOVER_CACHE_TTL_MS : RECOMMENDATION_CACHE_TTL_MS;
/** Places scored per setImmediate chunk (parallel scheduling across event-loop turns). */
const SCORE_CHUNK_SIZE = parseInt(process.env.RECOMMENDATION_SCORE_CHUNK_SIZE || "8", 10);

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHTS = Object.freeze({
  // v4 rules
  routineMatchPerRoutine: 3,
  budgetMatch:            5,
  locationMatch:          2,
  typeSaveSignal:         5,
  typeDismissSignal:      -3,
  affinityPositive:       4,   // kept for topInterestType / old path; scoring now uses typeAffinityScore
  affinityNegative:       -4,
  routineTimeOfDayMatch:  2,
  contextTimeOfDay:       3,
  weekendBoost:           2,
  weekdayBoost:           1,
  // v5 rules
  freshnessBoost:         3,
  explorationMax:         2,
  // v6 rules
  typeAffinityMultiplier: 0.5, // profile.typeAffinity[type] * this
  seenPenalty:            -2,  // applied when seenCount > SEEN_PENALTY_THRESHOLD
  // v7 rules
  lateNightGymPenalty:      -3,   // gym places penalised when isLateNight
  lateNightSocialBoost:      2,   // social places boosted at night (adds to contextTimeOfDay)
  intentBoostStrong:         3,   // fitness→gym, social→social
  intentBoostModerate:       2,   // relax→cafe/coffee
  recentAffinityMultiplier:  0.7, // recentAffinity[type] * this
  echoChokePenalty:         -2,   // dominant type (≥ECHO_CHAMBER_THRESHOLD of recent activity)
  // v8 rules
  sessionBoostMatch:         4,   // place.type == dominantSessionType
  sessionBoostMismatch:     -1,   // place.type != dominantSessionType (when session active)
  sequenceBoost:             2,   // place.type is predicted next step after last session action
  typeDiversityPenalty:     -2,   // per-level penalty for consecutive same-type in ranking
  popularityScoreWeight:    0.05, // place.popularityScore * this (cold-start users)
  locationTrendWeight:       0.5, // place.rating * this (cold-start users)
  // v9 rules
  embeddingWeight:           8,   // longTermAffinityBoost = cosineSimilarity * this (max 8 pts)
  // v10 rules
  exploitationBoostStrong:   5,   // userEmbedding[type] > 0.5 → strong match
  exploitationBoostModerate: 2,   // userEmbedding[type] > 0.2 → moderate match
  explorationNewTypeBoost:   3,   // type completely absent from recent interactions
  repeatPenaltyWeight:      -5,   // type seen > REPEAT_PENALTY_THRESHOLD times recently
  diversityBoostWeight:      4,   // underrepresented type in top-N ranked output
  // v11 rules
  modelBlendWeight:         0.3,  // weight of model score in final blend (0 = rules only)
  ruleBlendWeight:          0.7,  // weight of rule-based raw score in final blend
  // v13 rules — behavior shift multipliers
  shiftLongTermMul:         0.65, // reduce long-term influence when behaviour shifts
  shiftShortTermMul:        1.3,  // amplify recent + session match when behaviour shifts
  learningSignalMaxShare:   0.4,  // max share of combined LT+recent+session positive mass
  // v14 rules — real-world data signals
  closedPenalty:           -5,   // penalise places currently closed (isOpen === false)
  trendBoostMax:            3,   // maximum trend boost (awarded at trendScore = 1.0)
  // v16 rules — personalization layer
  multiInterestBoostMax:    4,   // max boost when place.type is a top-weighted interest
  topInterestBalanceK:      5,   // how many interest types participate in balancing
  habitContextBoost:        2.5, // per aligned habit (morning gym / weekend social / weekend coffee)
  contextStackBoostMax:     2,   // compound session + intent + habit/weight alignment
});

/** Penalise a place if the user has been exposed to it more than this many times. */
const SEEN_PENALTY_THRESHOLD = 2;

/** A place is considered "low interaction" if it has fewer than this many events. */
const LOW_INTERACTION_THRESHOLD = 2;

// ─── v7 constants ─────────────────────────────────────────────────────────────

/** Number of most-recent interactions used for short-term memory and intent detection. */
const RECENT_INTERACTIONS_WINDOW = 20;

/**
 * Fraction of recent interactions a single type must reach to be considered
 * "dominant" (echo-chamber trigger).  0.4 = 40 %.
 */
const ECHO_CHAMBER_THRESHOLD = 0.4;

/**
 * Fraction of recent interactions required before an intent category fires.
 * e.g. 0.35 means ≥35 % of recent activity must be fitness to return "fitness".
 */
const INTENT_THRESHOLD = 0.35;

/** Place types that contribute to the "fitness" intent bucket. */
const FITNESS_INTENT_TYPES = new Set(["gym", "yoga"]);

/** Place types that contribute to the "social" intent bucket. */
const SOCIAL_INTENT_TYPES  = new Set(["social"]);

/** Place types that contribute to the "relax" intent bucket. */
const RELAX_INTENT_TYPES   = new Set(["coffee", "cafe"]);

// ─── v8 constants ─────────────────────────────────────────────────────────────

/**
 * A user is considered "cold-start" when their total interaction count is below
 * this threshold.  Cold-start users receive popularityScore + locationTrendScore
 * boosts so highly-rated popular places surface in the absence of personal data.
 */
const COLD_START_THRESHOLD = 5;

// ─── v10 constants ─────────────────────────────────────────────────────────────

/**
 * Users with interaction counts at or above this value are considered "active"
 * and switch to exploitation-heavy weighting (they have enough signal to exploit).
 * Below it, the engine favours exploration to help new users discover variety.
 */
const ACTIVE_USER_THRESHOLD = 20;

/** Exploration weight for new users  (interactions < ACTIVE_USER_THRESHOLD). */
const EXPLORATION_WEIGHT_NEW    = 0.6;
/** Exploitation weight for new users. */
const EXPLOITATION_WEIGHT_NEW   = 0.4;
/** Exploration weight for active users (interactions >= ACTIVE_USER_THRESHOLD). */
const EXPLORATION_WEIGHT_ACTIVE = 0.3;
/** Exploitation weight for active users. */
const EXPLOITATION_WEIGHT_ACTIVE = 0.7;

/**
 * If a single place type appears more than this many times in the recent
 * interaction window, that type receives repeatPenalty on every additional
 * place of that type — breaking loop-like recommendation runs.
 */
const REPEAT_PENALTY_THRESHOLD = 5;

// ─── Context-aware type maps ──────────────────────────────────────────────────

const TIME_OF_DAY_TYPE_MAP = Object.freeze({
  morning:   new Set(["coffee", "gym", "yoga"]),
  afternoon: new Set(["coffee", "restaurant"]),
  evening:   new Set(["social", "restaurant"]),
  night:     new Set(["social"]),
});

const WEEKEND_BOOST_TYPES = new Set(["social", "outdoor"]);
const WEEKDAY_BOOST_TYPES = new Set(["gym", "coffee"]);

// ─── Field-mapping adapter ────────────────────────────────────────────────────

const resolveLocationType = (place) => (place.isIndoor ? "indoor" : "outdoor");

// ─── Data Fetchers ────────────────────────────────────────────────────────────

const fetchRoutines = async (userId) => {
  const snap = await db.collection(ROUTINES_COLLECTION).where("userId", "==", userId).get();
  return snap.docs.map((d) => d.data());
};

const fetchInteractions = async (userId) => {
  const snap = await db
    .collection(INTERACTIONS_COLLECTION)
    .where("userId", "==", userId)
    .limit(200)
    .get();
  return snap.docs.map((d) => d.data());
};

// ─── Lookup Map ───────────────────────────────────────────────────────────────

/**
 * Builds a map keyed by every known placeId (Firestore doc id + seed id aliases).
 * This ensures interactions stored with "place_1" style ids resolve to catalogue rows.
 */
const buildPlaceLookupMap = (places) => {
  const map = new Map();
  for (const p of places) {
    map.set(String(p.id), p);
  }
  for (const seed of SEED_PLACES) {
    if (!seed.id) continue;
    const match = places.find((pl) => pl.name === seed.name && pl.type === seed.type);
    if (match) map.set(seed.id, match);
  }
  return map;
};

const resolvePlace = (placeLookup, placeId) => {
  if (placeId == null || placeId === "") return undefined;
  return placeLookup.get(String(placeId));
};

// ─── Pre-computation Helpers ──────────────────────────────────────────────────

const buildTypeAffinityMap = (interactions, placeLookup) => {
  const affinityMap = new Map();
  for (const interaction of interactions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;
    affinityMap.set(place.type, (affinityMap.get(place.type) ?? 0) + (interaction.score ?? 0));
  }
  return affinityMap;
};

/**
 * Strong signals: resolve interaction place ids so save/dismiss sets hold live catalogue ids.
 */
const buildStrongSignalSets = (interactions, placeLookup) => {
  const savedIds     = new Set();
  const dismissedIds = new Set();
  for (const interaction of interactions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;
    if (interaction.actionType === "save")    savedIds.add(place.id);
    if (interaction.actionType === "dismiss") dismissedIds.add(place.id);
  }
  return { savedIds, dismissedIds };
};

const deriveTopInterestType = (affinityMap) => {
  let topType  = null;
  let topScore = 0;
  for (const [type, score] of affinityMap.entries()) {
    if (score > topScore) { topScore = score; topType = type; }
  }
  return topType;
};

/**
 * Computes per-place interaction statistics for the recency and freshness rules.
 *
 * Returns a Map<cataloguePlaceId, { count: number, recencyWeightedScore: number }>
 * where recencyWeightedScore = Σ (interaction.score * 1/(1 + ageInDays) * ageDecay).
 * v13: ageDecay = interactionAgeDecayWeight (24h=1, 7d=0.7, 7d+=0.4).
 *
 * @param {object[]} interactions
 * @param {Map}      placeLookup
 * @param {Date}     now — injectable for testing
 */
const buildInteractionIndex = (interactions, placeLookup, now = new Date()) => {
  const index = new Map(); // placeId → { count, recencyWeightedScore }

  for (const interaction of interactions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;

    const entry = index.get(place.id) ?? { count: 0, recencyWeightedScore: 0 };

    const createdAt  = interaction.createdAt ? new Date(interaction.createdAt) : now;
    const ageInDays  = Math.max(0, (now - createdAt) / (1000 * 60 * 60 * 24));
    const ageDecay   = interactionAgeDecayWeight(interaction.createdAt, now);
    const weight     = (1 / (1 + ageInDays)) * ageDecay;

    entry.count               += 1;
    entry.recencyWeightedScore += (interaction.score ?? 0) * weight;

    index.set(place.id, entry);
  }

  return index;
};

// ─── Seen-count map ───────────────────────────────────────────────────────────

/**
 * Builds a map of { cataloguePlaceId → seenCount } from profile.seenPlaces.
 * seenPlaces is an ordered array so we simply count occurrences.
 *
 * @param {string[]} seenPlaces — profile.seenPlaces array
 * @returns {Map<string, number>}
 */
const buildSeenCountMap = (seenPlaces) => {
  const map = new Map();
  for (const id of (seenPlaces ?? [])) {
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
};

// ─── v7 Intent + Short-Term Memory Helpers ───────────────────────────────────

/**
 * Builds a per-type affinity map from the user's most recent interactions only.
 * Interactions are expected sorted newest-first; earlier entries in the array
 * (lower index) receive a higher recency weight so that very recent behaviour
 * has a stronger signal than older activity within the window.
 *
 * recentAffinity[type] = Σ (interaction.score * recencyFactor * ageDecay)
 * where recencyFactor = (n − index) / n   →   1.0 for newest, ~0 for oldest.
 * v13: ageDecay = interactionAgeDecayWeight (24h=1, 7d=0.7, 7d+=0.4).
 *
 * @param {object[]} recentInteractions — at most RECENT_INTERACTIONS_WINDOW items, newest-first
 * @param {Map}      placeLookup
 * @param {Date}     [now] — request time for age decay
 * @returns {Map<string, number>}
 */
const buildRecentAffinityMap = (recentInteractions, placeLookup, now = new Date()) => {
  const map = new Map();
  const n   = recentInteractions.length;
  if (n === 0) return map;

  recentInteractions.forEach((interaction, index) => {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) return;
    // Index 0 = newest → recencyFactor closest to 1; last index → closest to 0.
    const recencyFactor = (n - index) / n;
    const ageDecay      = interactionAgeDecayWeight(interaction.createdAt, now);
    const contribution  = (interaction.score ?? 0) * recencyFactor * ageDecay;
    map.set(place.type, (map.get(place.type) ?? 0) + contribution);
  });

  return map;
};

/**
 * Infers the user's current intent from their most recent interactions.
 *
 * Buckets place types into intent categories, finds which category holds the
 * highest share, and returns its label when it clears INTENT_THRESHOLD.
 * Falls back to "explore" when behaviour is mixed or history is empty.
 *
 * @param {object|null} profile            — user Firestore profile (reserved for future signals)
 * @param {object[]}    recentInteractions — last N interactions, newest-first
 * @param {Map}         placeLookup        — placeId → place document
 * @returns {"fitness"|"social"|"relax"|"explore"}
 */
export const detectUserIntent = (profile, recentInteractions, placeLookup) => {
  if (!recentInteractions || recentInteractions.length === 0) return "explore";

  let fitnessCount = 0;
  let socialCount  = 0;
  let relaxCount   = 0;
  let total        = 0;

  for (const interaction of recentInteractions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;
    if (FITNESS_INTENT_TYPES.has(place.type)) fitnessCount += 1;
    if (SOCIAL_INTENT_TYPES.has(place.type))  socialCount  += 1;
    if (RELAX_INTENT_TYPES.has(place.type))   relaxCount   += 1;
    total += 1;
  }

  if (total === 0) return "explore";

  const maxCount = Math.max(fitnessCount, socialCount, relaxCount);
  if (maxCount / total >= INTENT_THRESHOLD) {
    if (maxCount === fitnessCount) return "fitness";
    if (maxCount === socialCount)  return "social";
    if (maxCount === relaxCount)   return "relax";
  }

  return "explore";
};

/**
 * Returns a Set of place types that are over-represented in recent interactions.
 * A "dominant" type accounts for ≥ ECHO_CHAMBER_THRESHOLD of the window.
 * Places of a dominant type receive echoChokePenalty to surface variety.
 *
 * @param {object[]} recentInteractions — newest-first, already windowed
 * @param {Map}      placeLookup
 * @returns {Set<string>}
 */
const buildDominantTypes = (recentInteractions, placeLookup) => {
  const dominant  = new Set();
  const typeCounts = new Map();
  let total = 0;

  for (const interaction of recentInteractions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;
    typeCounts.set(place.type, (typeCounts.get(place.type) ?? 0) + 1);
    total += 1;
  }

  if (total === 0) return dominant;

  for (const [type, count] of typeCounts.entries()) {
    if (count / total >= ECHO_CHAMBER_THRESHOLD) dominant.add(type);
  }

  return dominant;
};

// ─── v10 Exploration / Exploitation Helpers ──────────────────────────────────

/**
 * Counts how many times each place type appears in a recent interaction list.
 * Used by repeatPenalty (Rule 24) to detect over-represented types.
 *
 * @param {object[]} recentInteractions — newest-first, already windowed
 * @param {Map}      placeLookup
 * @returns {Map<string, number>}
 */
const buildRecentTypeCounts = (recentInteractions, placeLookup) => {
  const counts = new Map();
  for (const interaction of recentInteractions) {
    const place = resolvePlace(placeLookup, interaction.placeId);
    if (!place) continue;
    counts.set(place.type, (counts.get(place.type) ?? 0) + 1);
  }
  return counts;
};

// ─── Score Normalization ──────────────────────────────────────────────────────

/**
 * Clamps a raw score to [0, 100].
 * Negative totals become 0; absurdly high totals are capped at 100.
 */
const normalizeScore = (raw) => Math.min(100, Math.max(0, raw));
// ─── Diversity Injection ──────────────────────────────────────────────────────

/**
 * Interleaves a score-sorted array so that no two consecutive entries share
 * the same place type. Preserves relative ordering within each type.
 *
 * Algorithm:
 *   1. Group by type (preserving per-type rank)
 *   2. Round-robin pick from type buckets, skipping the last-used type
 *   3. When no non-repeating type is available, allow the repeat to avoid
 *      discarding results
 *
 * @param {object[]} sorted    — sorted descending by score, diversity-controlled (max N per type)
 * @param {number}   limit     — max output size
 * @returns {object[]}
 */
const injectDiversity = (sorted, limit) => {
  // Group into per-type buckets (order within bucket preserved).
  const buckets = new Map();
  for (const place of sorted) {
    if (!buckets.has(place.type)) buckets.set(place.type, []);
    buckets.get(place.type).push(place);
  }

  const result = [];
  let lastType = null;

  while (result.length < limit) {
    // Prefer types that are not the same as the previous result.
    let chosen = null;

    // Pass 1: find the highest-score candidate from a *different* type.
    let bestScore    = -Infinity;
    let bestType     = null;
    for (const [type, items] of buckets.entries()) {
      if (items.length === 0)     continue;
      if (type === lastType)      continue;
      if (items[0].score > bestScore) {
        bestScore = items[0].score;
        bestType  = type;
      }
    }

    if (bestType) {
      chosen = bestType;
    } else {
      // Pass 2: all remaining candidates are the same type — allow repeat.
      for (const [type, items] of buckets.entries()) {
        if (items.length > 0) { chosen = type; break; }
      }
    }

    if (!chosen) break; // pool exhausted

    const item = buckets.get(chosen).shift();
    if (buckets.get(chosen).length === 0) buckets.delete(chosen);

    result.push(item);
    lastType = chosen;
  }

  return result;
};

// ─── Scoring Engine ───────────────────────────────────────────────────────────

/**
 * Scores a single place against all user and context signals.
 *
 * v8 additions:
 *   - sessionBoost      place type matches / mismatches the live session dominant type
 *   - sequenceBoost     place type is the predicted next step after the last session action
 *   - popularityScore   cold-start boost using place.popularityScore and place.rating
 *   - locationTrendScore cold-start quality signal from place.rating
 *   - typeDiversityPenalty: set to 0 here; filled in by the post-sort pass
 *
 * v7 additions:
 *   - lateNightBoost   gym penalty at night; extra social boost at night
 *   - intentBoost      place type aligns with detected user intent
 *   - recentBoost      short-term memory: recentAffinity[type] × 0.7
 *   - echoChoke        dominant-type over-representation penalty
 *
 * v5 additions:
 *   - interactionScore is now recency-weighted (not a raw sum)
 *   - freshnessBoost  (+3 for places with 0 prior interactions)
 *   - explorationBoost (0–2 random, only for low-interaction places)
 *
 * @param {object}             place                — Firestore place document
 * @param {object|null}        profile              — user's Firestore profile
 * @param {object[]}           routines             — user's routines
 * @param {object[]}           interactions         — user's interactions (raw)
 * @param {Map<string,number>} affinityMap          — pre-built type-affinity map
 * @param {Map<string,object>} placeLookup          — placeId → place document
 * @param {object}             context              — from buildContext()
 * @param {Map<string,object>} interactionIndex     — per-place { count, recencyWeightedScore }
 * @param {Map<string,number>} seenCountMap         — per-place seen count
 * @param {string}             [detectedIntent="explore"]  — long-term or session-overridden intent
 * @param {Map<string,number>} [recentAffinityMap=Map()]   — from buildRecentAffinityMap()
 * @param {Set<string>}        [dominantTypes=Set()]       — from buildDominantTypes()
 * @param {string|null}        [dominantSessionType=null]  — most frequent type in session
 * @param {string|null}        [lastSessionType=null]      — type of most recent session action
 * @param {boolean}            [isColdStart=false]         — user has < COLD_START_THRESHOLD interactions
 * @param {Record<string,number>} [userEmbedding={}]       — user's persistent taste vector (Phase 9)
 * @param {number}             [explorationWeight=0.6]     — Phase 10 exploration weight (0-1)
 * @param {number}             [exploitationWeight=0.4]    — Phase 10 exploitation weight (0-1)
 * @param {Map<string,number>} [recentTypeCounts=Map()]    — Phase 10 type frequency in recent interactions
 * @param {boolean}            [behaviorShiftDetected=false] — Phase 13: recent vs historical divergence
 * @param {boolean}            [fastMode=false]              — Phase 15: skip embedding + AI model for speed
 * @param {Map<string,number>} [interestWeights=new Map()]   — Phase 16: normalized multi-interest weights
 * @param {string[]}           [dominantHabits=[]]           — Phase 16: detected habit labels
 * @param {number}             [ruleBlendWeight]            — Phase 17: rule/model blend (default WEIGHTS)
 * @param {number}             [modelBlendWeight]           — Phase 17: rule/model blend (default WEIGHTS)
 *
 * @returns {{ rawScore: number, breakdown: object }}
 */
export const scorePlaceForUser = (
  place,
  profile,
  routines,
  interactions,
  affinityMap,
  placeLookup,
  context,
  interactionIndex,
  seenCountMap,
  detectedIntent      = "explore",
  recentAffinityMap   = new Map(),
  dominantTypes       = new Set(),
  dominantSessionType = null,
  lastSessionType     = null,
  isColdStart         = false,
  userEmbedding       = {},
  explorationWeight   = EXPLORATION_WEIGHT_NEW,
  exploitationWeight  = EXPLOITATION_WEIGHT_NEW,
  recentTypeCounts    = new Map(),
  behaviorShiftDetected = false,
  fastMode            = false,
  interestWeights     = new Map(),
  dominantHabits      = [],
  ruleBlendWeight     = WEIGHTS.ruleBlendWeight,
  modelBlendWeight    = WEIGHTS.modelBlendWeight
) => {
  const breakdown = {
    // ── v4 fields ─────────────────────────────────────────
    routineMatch:          0,
    budgetMatch:           0,
    locationMatch:         0,
    interactionScore:      0,
    typeSaveSignal:        0,
    typeDismissSignal:     0,
    affinityBoost:         0,
    timeOfDayMatch:        0,
    contextTimeOfDay:      0,
    weekendBoost:          0,
    weekdayBoost:          0,
    // ── v5 fields ─────────────────────────────────────────
    freshnessBoost:        0,
    explorationBoost:      0,
    recencyWeight:         1,
    // ── v6 fields ─────────────────────────────────────────
    typeAffinityScore:     0,
    seenPenalty:           0,
    // ── v7 fields ─────────────────────────────────────────
    lateNightBoost:        0,
    intentBoost:           0,
    detectedIntent,
    recentBoost:           0,
    echoChoke:             0,
    // ── v8 fields ─────────────────────────────────────────
    sessionBoost:          0,   // session dominant type match / mismatch
    sequenceBoost:         0,   // predicted next step from SEQUENCE_BOOST_MAP
    popularityScore:       0,   // cold-start: place.popularityScore * weight
    locationTrendScore:    0,   // cold-start: place.rating * weight
    typeDiversityPenalty:  0,   // filled in post-sort (0 here always)
    dominantSessionType:   dominantSessionType ?? "none",
    sessionIntent:         computeSessionIntent(dominantSessionType),
    // ── v9 fields ─────────────────────────────────────────
    embeddingScore:        0,   // cosine similarity between user and place vectors (0–1)
    longTermAffinityBoost: 0,   // embeddingScore * embeddingWeight (added to rawScore)
    // ── v10 fields ────────────────────────────────────────
    exploitationBoost: 0,   // embedding-alignment reward scaled by exploitationWeight
    repeatPenalty:     0,   // penalty when type is over-represented in recent history
    diversityBoost:    0,   // post-sort: boost for underrepresented types in top-N
    // ── v11 fields ────────────────────────────────────────
    modelScore:        0,   // linear model prediction (0 when untrained)
    // ── v14 fields ────────────────────────────────────────
    closedPenalty:     0,   // -5 when place.isOpen === false (Google Places data)
    trendBoost:        0,   // 0–3 when place.trendScore >= 0.5 (trending via Google)
    // ── v16 fields ────────────────────────────────────────
    multiInterestBoost:  0,   // top-weighted interests — balanced lift
    interestWeightUsed:  0,   // weight of this place's type when boosted (debug)
    habitContextBoost:   0,   // current context matches detected habit + type
    contextStackBoost:   0,   // compound session + intent + habit/weight
    // ── v17 onboarding-driven fields ──────────────────────
    activitiesBoost:     0,   // weeklyActivities → place type match
    genderPenalty:       0,   // gender-incompatible place penalty
  };

  const locationType = resolveLocationType(place);
  const { timeOfDay, isWeekend, isLateNight } = context;

  // ── Rule 1: Routine activity-type match (+3 per matching routine) ────────────
  for (const routine of routines) {
    if (routine.activityType === place.type) {
      breakdown.routineMatch += WEIGHTS.routineMatchPerRoutine;
    }
  }

  // ── Rule 2: Budget match (+5) — uses AI-enriched tier when available ──────────
  {
    const userTier  = userBudgetTier(profile); // "cheap" | "mid" | "expensive"
    const pricingOn = place._pricingEnabled === true;
    const fastTier  = place._fastPriceLevel;   // set by the pricing pre-pass

    let budgetOk = false;
    if (!pricingOn || place.priceRange === "free") {
      // Free / non-priced places always match budget
      budgetOk = true;
    } else if (fastTier) {
      // AI-enriched tier comparison (cheap ≤ mid ≤ expensive)
      const _order = { cheap: 0, mid: 1, expensive: 2 };
      const uLevel = _order[userTier] ?? 1;
      const pLevel = _order[fastTier] ?? 1;
      budgetOk = pLevel <= uLevel;
    } else {
      // Legacy: check budgetRange label from profile/routines
      const budgetSignals = new Set();
      if (profile?.budgetRange) budgetSignals.add(profile.budgetRange);
      for (const r of routines) { if (r.budgetRange) budgetSignals.add(r.budgetRange); }
      budgetOk = budgetSignals.has(place.priceRange);
    }

    if (budgetOk) {
      breakdown.budgetMatch = WEIGHTS.budgetMatch;
    }
  }

  // ── Rule 3: Location preference match (+2) ───────────────────────────────────
  const locationSignals = new Set();
  if (profile?.locationPreference) locationSignals.add(profile.locationPreference);
  for (const r of routines) { if (r.locationPreference) locationSignals.add(r.locationPreference); }
  if (locationSignals.has("any") || locationSignals.has(locationType)) {
    breakdown.locationMatch = WEIGHTS.locationMatch;
  }

  // ── Rule 4 (v5/v6): Average recency-weighted interaction score ───────────────
  // v6: uses average (totalScore / count) instead of raw sum so a single
  // high-value save isn't drowned by many low-value views.
  const placeStats = interactionIndex.get(place.id);
  if (placeStats && placeStats.count > 0) {
    breakdown.interactionScore = +(placeStats.recencyWeightedScore / placeStats.count).toFixed(3);
    breakdown.recencyWeight    = +(placeStats.recencyWeightedScore / placeStats.count).toFixed(3);
  }

  // ── Rule 5a/5b: Type-level save (+5) / dismiss (-3) signals ─────────────────
  for (const interaction of interactions) {
    const interactionPlace = resolvePlace(placeLookup, interaction.placeId);
    if (!interactionPlace || interactionPlace.type !== place.type) continue;
    if (interaction.actionType === "save"    && breakdown.typeSaveSignal    === 0) breakdown.typeSaveSignal    = WEIGHTS.typeSaveSignal;
    if (interaction.actionType === "dismiss" && breakdown.typeDismissSignal === 0) breakdown.typeDismissSignal = WEIGHTS.typeDismissSignal;
  }

  // ── Rule 6 (v6): Persistent type-affinity score from profile ────────────────
  // Replaces the old static ±4 affinityBoost for the scoring total.
  // affinityBoost is kept in breakdown at 0 for backward-compat with old tests.
  const persistedAffinity = (profile?.typeAffinity ?? {})[place.type] ?? 0;
  breakdown.typeAffinityScore = +(persistedAffinity * WEIGHTS.typeAffinityMultiplier).toFixed(3);

  // ── Rule 7 (legacy): Routine time-of-day match (+2) ─────────────────────────
  for (const routine of routines) {
    if (routine.activityType === place.type && routine.timeOfDay === timeOfDay) {
      breakdown.timeOfDayMatch = WEIGHTS.routineTimeOfDayMatch;
      break;
    }
  }

  // ── Rule 8: Context time-of-day band match (+3) ───────────────────────────────
  const typesForNow = TIME_OF_DAY_TYPE_MAP[timeOfDay] ?? new Set();
  if (typesForNow.has(place.type)) {
    breakdown.contextTimeOfDay = WEIGHTS.contextTimeOfDay;
  }

  // ── Rule 9: Weekend boost (+2 for social / outdoor) ──────────────────────────
  if (isWeekend && WEEKEND_BOOST_TYPES.has(place.type)) {
    breakdown.weekendBoost = WEIGHTS.weekendBoost;
  }

  // ── Rule 10: Weekday boost (+1 for gym / coffee) ──────────────────────────────
  if (!isWeekend && WEEKDAY_BOOST_TYPES.has(place.type)) {
    breakdown.weekdayBoost = WEIGHTS.weekdayBoost;
  }

  // ── Rule 11 (v5 NEW): Freshness boost (+3 for never-seen places) ─────────────
  const interactionCount = placeStats?.count ?? 0;
  if (interactionCount === 0) {
    breakdown.freshnessBoost = WEIGHTS.freshnessBoost;
  }

  // ── Rule 12 (v5 NEW): Exploration boost (0–2 random for low-interaction) ─────
  // Injects controlled randomness so the same places don't always surface.
  if (interactionCount < LOW_INTERACTION_THRESHOLD) {
    breakdown.explorationBoost = +(Math.random() * WEIGHTS.explorationMax).toFixed(3);
  }

  // ── Rule 13 (v6 NEW): Seen penalty (−2 when seenCount > threshold) ───────────
  // Reduces ranking of places the user has already been exposed to frequently,
  // encouraging the engine to surface fresher content.
  const seenCount = seenCountMap.get(place.id) ?? 0;
  if (seenCount > SEEN_PENALTY_THRESHOLD) {
    breakdown.seenPenalty = WEIGHTS.seenPenalty;
  }

  // ── Rule 14 (v7 NEW): Late-night context adjustment ───────────────────────────
  // Gyms are penalised at night (contextually inappropriate).
  // Social places receive an additional boost at night on top of contextTimeOfDay.
  if (isLateNight) {
    if (place.type === "gym")    breakdown.lateNightBoost = WEIGHTS.lateNightGymPenalty;
    if (place.type === "social") breakdown.lateNightBoost = WEIGHTS.lateNightSocialBoost;
  }

  // ── Rule 15 (v7 NEW): Intent boost ────────────────────────────────────────────
  // Amplifies places that match the user's inferred current intent.
  if (detectedIntent === "fitness" && FITNESS_INTENT_TYPES.has(place.type)) {
    breakdown.intentBoost = WEIGHTS.intentBoostStrong;
  } else if (detectedIntent === "social" && SOCIAL_INTENT_TYPES.has(place.type)) {
    breakdown.intentBoost = WEIGHTS.intentBoostStrong;
  } else if (detectedIntent === "relax" && RELAX_INTENT_TYPES.has(place.type)) {
    breakdown.intentBoost = WEIGHTS.intentBoostModerate;
  }

  // ── Rule 16 (v7 NEW): Short-term memory / recent behavior boost ───────────────
  // Uses the last RECENT_INTERACTIONS_WINDOW interactions only, weighted so
  // the most recent actions carry the strongest signal.
  const recentAffinity = recentAffinityMap.get(place.type) ?? 0;
  breakdown.recentBoost = +(recentAffinity * WEIGHTS.recentAffinityMultiplier).toFixed(3);

  // ── Rule 17 (v7 NEW): Echo-chamber choke ──────────────────────────────────────
  // If the user's recent history is dominated by one type (≥ ECHO_CHAMBER_THRESHOLD),
  // apply a small penalty to that type so other types surface more often.
  if (dominantTypes.has(place.type)) {
    breakdown.echoChoke = WEIGHTS.echoChokePenalty;
  }

  // ── Rule 18 (v8 NEW): Session dominant type boost / mismatch penalty ─────────
  // When the user has an active session, boost the dominant type and lightly
  // penalise everything else so the session's momentum influences ranking.
  if (dominantSessionType) {
    breakdown.sessionBoost = place.type === dominantSessionType
      ? WEIGHTS.sessionBoostMatch
      : WEIGHTS.sessionBoostMismatch;
  }

  // ── Rule 19 (v8 NEW): Sequential prediction boost ────────────────────────────
  // Reward place types that are the natural "next step" after the user's most
  // recent session action (e.g. gym → coffee, restaurant → outdoor).
  if (lastSessionType) {
    const nextLikelyTypes = SEQUENCE_BOOST_MAP[lastSessionType];
    if (nextLikelyTypes && nextLikelyTypes.has(place.type)) {
      breakdown.sequenceBoost = WEIGHTS.sequenceBoost;
    }
  }

  // ── Rule 20 (v8 NEW): Cold-start popularity & quality boost ──────────────────
  // When the user has fewer than COLD_START_THRESHOLD total interactions the
  // engine lacks personal signal.  Surface well-known, high-rated places so
  // the first-run experience still feels curated.
  if (isColdStart) {
    breakdown.popularityScore    = +((place.popularityScore ?? 0) * WEIGHTS.popularityScoreWeight).toFixed(3);
    breakdown.locationTrendScore = +((place.rating          ?? 0) * WEIGHTS.locationTrendWeight).toFixed(3);
  }

  // ── Rule 21 (v9 NEW): Long-term user embedding similarity ────────────────────
  // Computes cosine similarity between the user's persistent taste vector and
  // the place's derived embedding.  A high similarity means the place type and
  // tags align with what the user has consistently engaged with over time.
  // embeddingScore is stored raw (0–1) for transparency; longTermAffinityBoost
  // is its weighted contribution to rawScore (max 8 points).
  // Phase 15: skipped in fastMode to reduce per-place CPU time.
  if (!fastMode) {
    const placeEmbedding            = buildPlaceEmbedding(place);
    const similarity                = cosineSimilarity(userEmbedding, placeEmbedding);
    breakdown.embeddingScore        = +similarity.toFixed(4);
    breakdown.longTermAffinityBoost = +(similarity * WEIGHTS.embeddingWeight).toFixed(3);
  }

  // ── Rule 22 (v10 NEW): Exploitation boost — reward known preferences ──────────
  // Amplifies places whose type strongly aligns with the user's long-term taste
  // vector.  The boost is scaled by exploitationWeight so active users (who have
  // confirmed preferences) receive a stronger pull toward familiar types.
  const typeEmbeddingValue = userEmbedding[place.type] ?? 0;
  if (typeEmbeddingValue > 0.5) {
    breakdown.exploitationBoost = +(WEIGHTS.exploitationBoostStrong * exploitationWeight).toFixed(3);
  } else if (typeEmbeddingValue > 0.2) {
    breakdown.exploitationBoost = +(WEIGHTS.exploitationBoostModerate * exploitationWeight).toFixed(3);
  }

  // ── Rule 23 (v10 NEW): Exploration boost — surface novel types ───────────────
  // Extends the v5 random exploration (Rule 12) with a deterministic component:
  // if a place's type is completely absent from the user's recent interaction
  // window, it gets an additional boost scaled by explorationWeight.  This ensures
  // novel types rise naturally even when not picked by the random draw.
  const recentCountForType = recentTypeCounts.get(place.type) ?? 0;
  if (recentCountForType === 0) {
    breakdown.explorationBoost = +(breakdown.explorationBoost +
      WEIGHTS.explorationNewTypeBoost * explorationWeight).toFixed(3);
  }

  // ── Rule 24 (v10 NEW): Repeat penalty — break boring loops ───────────────────
  // If the user has interacted with this type more than REPEAT_PENALTY_THRESHOLD
  // times in their recent window, apply a penalty to push other types up.
  // This is distinct from echoChoke (which uses a fractional threshold) — this
  // uses an absolute count threshold for a stronger anti-loop signal.
  if (recentCountForType > REPEAT_PENALTY_THRESHOLD) {
    breakdown.repeatPenalty = WEIGHTS.repeatPenaltyWeight;
  }

  // ── Phase 13: behaviour-shift adjustment + signal balancing ─────────────────
  // Re-weight long-term vs short-term learning signals when recent activity
  // diverges from historical averages, then cap each positive component at
  // 40% of the combined positive mass (longTerm + recent + session match).
  let ltLearn = breakdown.longTermAffinityBoost;
  let rbLearn = breakdown.recentBoost;
  let sbLearn = breakdown.sessionBoost;

  if (behaviorShiftDetected) {
    ltLearn *= WEIGHTS.shiftLongTermMul;
    rbLearn *= WEIGHTS.shiftShortTermMul;
    const posSb = Math.max(0, sbLearn);
    const negSb = Math.min(0, sbLearn);
    sbLearn = negSb + posSb * WEIGHTS.shiftShortTermMul;
  }

  const balancedLearn = balanceLearningSignals(
    ltLearn,
    rbLearn,
    sbLearn,
    WEIGHTS.learningSignalMaxShare
  );
  breakdown.longTermAffinityBoost = +balancedLearn.longTerm.toFixed(3);
  breakdown.recentBoost           = +balancedLearn.recent.toFixed(3);
  breakdown.sessionBoost          = +balancedLearn.session.toFixed(3);

  // ── Phase 16: Multi-interest + habits + context stacking ───────────────────
  const mib = multiInterestBalanceBoost(
    place.type,
    interestWeights,
    WEIGHTS.topInterestBalanceK,
    WEIGHTS.multiInterestBoostMax
  );
  breakdown.multiInterestBoost = mib.boost;
  breakdown.interestWeightUsed = mib.weightUsed;

  breakdown.habitContextBoost = computeHabitContextBoost(
    place,
    context,
    dominantHabits,
    WEIGHTS.habitContextBoost
  );

  breakdown.contextStackBoost = computeContextStackBoost(
    place,
    breakdown.sessionIntent,
    detectedIntent,
    dominantHabits,
    interestWeights,
    WEIGHTS.contextStackBoostMax
  );

  // ── Rule 28 (v17): Weekly activities → place type alignment ──────────────────
  // User's declared weekly activities (onboarding) mapped to place types.
  // Each matching activity contributes +2 pts, capped at +5.
  breakdown.activitiesBoost = weeklyActivitiesBoost(
    place.type,
    profile?.weeklyActivities ?? []
  );

  // ── Rule 29 (v17): Gender context penalty ─────────────────────────────────────
  // Apply a penalty when a gender-specific place type mismatches the user's gender.
  // Only covers clearly exclusive places (ladies salon, barbershop, etc.).
  breakdown.genderPenalty = genderContextScore(
    place.type,
    place.name || "",
    profile?.gender || ""
  );

  const rawScore =
    breakdown.routineMatch      +
    breakdown.budgetMatch       +
    breakdown.locationMatch     +
    breakdown.interactionScore  +
    breakdown.typeSaveSignal    +
    breakdown.typeDismissSignal +
    breakdown.affinityBoost     +
    breakdown.timeOfDayMatch    +
    breakdown.contextTimeOfDay  +
    breakdown.weekendBoost      +
    breakdown.weekdayBoost      +
    breakdown.freshnessBoost    +
    breakdown.explorationBoost  +
    breakdown.typeAffinityScore +
    breakdown.seenPenalty       +
    breakdown.lateNightBoost    +
    breakdown.intentBoost       +
    breakdown.recentBoost       +
    breakdown.echoChoke         +
    breakdown.sessionBoost      +
    breakdown.sequenceBoost     +
    breakdown.popularityScore   +
    breakdown.locationTrendScore +
    breakdown.longTermAffinityBoost +
    breakdown.exploitationBoost  +
    breakdown.repeatPenalty      +
    breakdown.multiInterestBoost +
    breakdown.habitContextBoost  +
    breakdown.contextStackBoost  +
    breakdown.activitiesBoost    +
    breakdown.genderPenalty;

  // ── Rule 25 (v12 UPDATED): AI model score ─────────────────────────────────
  // Builds the 10-dimensional feature vector matching Phase 12's
  // trainingDataBuilder.FEATURE_NAMES exactly.  All values are derived
  // from signals already computed above — zero extra Firestore reads.
  //
  // Feature order (must stay in sync with FEATURE_NAMES):
  //   [0] placeTypeIndex     [1] timeOfDayIndex    [2] dayOfWeek
  //   [3] sessionIntentIndex [4] domSessTypeIndex  [5] embeddingScore
  //   [6] longTermAffinity   [7] typeAffinityNorm  [8] placeInteractNorm
  //   [9] placeRating
  // Phase 15: skipped entirely in fastMode — model prediction is a non-trivial
  // matrix multiply per place that adds measurable latency for large catalogues.
  let blendedRawScore = rawScore;
  if (!fastMode) {
    const AFFINITY_CAP_LOCAL = 50; // mirrors user.service AFFINITY_CAP
    const rawAffinity        = (profile?.typeAffinity ?? {})[place.type] ?? 0;

    const modelFeatures = [
      // [0] placeTypeIndex
      encodeType(place.type),
      // [1] timeOfDayIndex
      encodeTimeOfDay(context.timeOfDay),
      // [2] dayOfWeek  (0-6 / 6)
      new Date().getDay() / 6,
      // [3] sessionIntentIndex
      encodeIntent(detectedIntent),
      // [4] domSessTypeIndex
      dominantSessionType ? encodeType(dominantSessionType) : 0,
      // [5] embeddingScore  (already computed in Rule 21)
      breakdown.embeddingScore,
      // [6] longTermAffinity  — direct user embedding value for this type
      (userEmbedding[place.type] ?? 0),
      // [7] typeAffinityNorm  — map [-50,50] → [0,1]
      (rawAffinity + AFFINITY_CAP_LOCAL) / (2 * AFFINITY_CAP_LOCAL),
      // [8] placeInteractNorm — how often user interacted with this place (capped)
      Math.min(1, (interactionIndex.get(place.id)?.count ?? 0) / 10),
      // [9] placeRating
      Math.min(1, (place.rating ?? 0) / 5),
    ];

    const modelOutput = modelPredict(modelFeatures);
    breakdown.modelScore = +modelOutput.toFixed(4);

    // Blend: 0.7 × rule-based + 0.3 × model.  Falls back to rawScore when
    // the model has not been trained yet (predict returns 0, isModelLoaded false).
    blendedRawScore = isModelLoaded()
      ? ruleBlendWeight  * rawScore +
        modelBlendWeight * breakdown.modelScore
      : rawScore;
  }

  // ── Rule 26 (v14): Closed place penalty ──────────────────────────────────────
  if (place.isOpen === false) {
    breakdown.closedPenalty = WEIGHTS.closedPenalty;
  }

  // ── Rule 27 (v14): Location trend boost ──────────────────────────────────────
  if ((place.trendScore ?? 0) >= 0.5) {
    breakdown.trendBoost = +(WEIGHTS.trendBoostMax * place.trendScore).toFixed(3);
  }

  // ── Rule 28 (Admin boost + Contextual Audience Match) ────────────────────────
  // Admin-curated places carry aiBoostScore (0–100) and adminPriority (0–100).
  // Boost is scaled against the typical raw score range (−20…+80):
  //   • Base boost: up to +15 at 100/100 combined
  //   • Featured: +5, Trending: +3, Sponsored: +1
  // A contextual audience match multiplier (0.4–1.0) amplifies the boost when the
  // item's targeting criteria strongly match the current user, and reduces it for
  // weak matches (never to zero — pass-through filtering already handles rejections).
  breakdown.adminBoost = 0;
  breakdown.audienceMatchScore = 0;
  if (place.source === "admin_curated" || place.adminPriority != null || place.aiBoostScore != null) {
    const boostPct  = Math.min(100, Math.max(0, Number(place.aiBoostScore  ?? 0)));
    const prioPct   = Math.min(100, Math.max(0, Number(place.adminPriority ?? 50)));
    const combined  = (boostPct * 0.55 + prioPct * 0.45) / 100; // 0–1
    let rawBoost = combined * 15;
    if (place.featured) rawBoost += 5;
    if (place.trending) rawBoost += 3;
    if (place.sponsored) rawBoost += 1;

    // ── Contextual audience match score ──────────────────────────────────────
    // Checks how well the current user's profile matches the admin's target criteria.
    // Dimensions: budget tier, religion, gender, lifestyle tags, audience tags.
    // Score range: 0–1, default 0.7 when no targeting is specified.
    let matchScore = 0.7; // neutral — no targeting specified
    const crit = place.onboardingMatchCriteria ?? {};
    const audienceTags = Array.isArray(place.audienceTags) ? place.audienceTags : [];
    let matchFactors = 0;
    let matchTotal = 0;

    // Budget match
    if (crit.budgetTier) {
      const allowed = (Array.isArray(crit.budgetTier) ? crit.budgetTier : [crit.budgetTier]).map((t) => t.toLowerCase());
      const userTier = (profile?.budgetRange || "medium").toLowerCase();
      matchFactors += allowed.includes(userTier) ? 1 : 0;
      matchTotal++;
    }

    // Religion match
    if (crit.religion) {
      const allowed = (Array.isArray(crit.religion) ? crit.religion : [crit.religion]).map((r) => r.toLowerCase());
      const userRel = (profile?.religion || "").toLowerCase();
      matchFactors += (userRel && allowed.includes(userRel)) ? 1 : 0.5;
      matchTotal++;
    }

    // Gender match
    if (crit.gender) {
      const allowed = (Array.isArray(crit.gender) ? crit.gender : [crit.gender]).map((g) => g.toLowerCase());
      const userGender = (profile?.gender || "").toLowerCase();
      matchFactors += (userGender && allowed.includes(userGender)) ? 1 : 0.5;
      matchTotal++;
    }

    // Audience / interest tags
    if (audienceTags.length > 0) {
      const userInterests = new Set([
        ...(profile?.preferredActivities ?? []),
        ...(profile?.eventInterests ?? []),
        ...(profile?.weeklyActivities ?? []),
      ].map((t) => t.toLowerCase()));
      const matches = audienceTags.filter((t) => userInterests.has(t.toLowerCase())).length;
      matchFactors += Math.min(1, matches / Math.max(1, audienceTags.length));
      matchTotal++;
    }

    if (matchTotal > 0) {
      // Scale 0–1 match to 0.4–1.0 boost multiplier
      matchScore = 0.4 + (matchFactors / matchTotal) * 0.6;
    }

    breakdown.audienceMatchScore = +matchScore.toFixed(3);
    breakdown.adminBoost = +(rawBoost * matchScore).toFixed(3);
  }

  return {
    rawScore: blendedRawScore + breakdown.closedPenalty + breakdown.trendBoost + breakdown.adminBoost,
    breakdown,
  };
};

// ─── Phase 15: scoring parallelism + derived-signal fingerprint ─────────────

/**
 * Stable fingerprint for the interaction list (newest-first ordering).
 * Changes when any interaction is added, removed, or reordered.
 */
const buildInteractionFingerprint = (interactions) => {
  const sorted = [...interactions].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  return `${sorted.length}:${sorted[0]?.id ?? ""}:${sorted[sorted.length - 1]?.id ?? ""}`;
};

/**
 * Scores places in chunks scheduled via setImmediate so each chunk yields to the
 * event loop — improves tail latency under concurrent requests (parallel scoring).
 */
const scorePlacesInChunks = async (places, scoreOne) => {
  const size = Math.max(1, SCORE_CHUNK_SIZE);
  const chunks = [];
  for (let i = 0; i < places.length; i += size) {
    chunks.push(places.slice(i, i + size));
  }
  const parts = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve) => {
          setImmediate(() => {
            resolve(chunk.map((place) => scoreOne(place)));
          });
        })
    )
  );
  return parts.flat();
};

const mapDiscoverEventsToRecommendations = (events, lim) =>
  events.slice(0, lim).map((ev, idx) => {
    const raw = 62 + Math.max(0, 20 - idx * 3);
    const eventForDetail = {
      id:          ev.id,
      title:       ev.title,
      description: ev.description,
      location:    ev.location,
      coordinates: ev.coordinates,
      date:        ev.date,
      category:    ev.category,
      image:       ev.image,
      source_url:  ev.source_url,
      source:      ev.source,
    };
    return {
      id:          `evt_${ev.id}`,
      name:        ev.title || "Event",
      type:        "event",
      category:    "event",
      eventTopic:  ev.category || "other",
      description: (ev.description || "").slice(0, 280),
      summary:     ev.description || "",
      score:       normalizeScore(raw),
      rawScore:    raw,
      rating:      4,
      trendScore:  0,
      distanceKm:  null,
      location:
        ev.coordinates?.lat != null && ev.coordinates?.lng != null
          ? { lat: ev.coordinates.lat, lng: ev.coordinates.lng, city: ev.location || "" }
          : { lat: null, lng: null, city: ev.location || "" },
      source_url: ev.source_url || "",
      date:       ev.date || "",
      image:      ev.image || "",
      images:     ev.image ? [ev.image] : [],
      source:     ev.source || "scraped",
      isEvent:    true,
      _eventForDetail: eventForDetail,
    };
  });

// ─── Main Recommendation Function ────────────────────────────────────────────

/**
 * Generates a personalised, context-aware, diverse, and adaptive list of places.
 *
 * @param {string}  userId        — Firebase UID from the verified token
 * @param {boolean} [debug=false] — attach scoreBreakdown to each result
 * @param {number}  [limit=10]    — maximum results to return
 * @param {{ lat: number, lng: number, radiusMeters?: number }|null} [userLocation=null]
 *   — Phase 14: when provided, real Google Maps Places data is fetched for the
 *     given coordinates instead of the static Firestore catalogue.
 * @param {boolean} [fastMode=false]
 *   — Phase 15: skip embedding cosine-similarity (Rule 21) and AI model scoring
 *     (Rule 25) to reduce per-request latency.  Results are cached separately
 *     from full-mode responses.
 *
 * @returns {Promise<{
 *   recommendations: object[],
 *   context: object,
 *   meta: {
 *     profileFound:      boolean,
 *     routineCount:      number,
 *     interactionCount:  number,
 *     topInterestType:   string|null,
 *     placesInCatalogue: number,
 *     context?:          object   — only when debug=true
 *   }
 * }>}
 *
 * @throws {Error} statusCode 404 when no user profile exists
 */
export const getRecommendations = async (
  userId,
  debug = false,
  limit = 10,
  userLocation = null,
  fastMode = false,
  typeFilter = null,
  modeFilter = null,
  discoverCategoryKey = null,
  forceRefresh = false,
) => {
  const startMs = performance.now();
  concurrentRecommendationRequests.count += 1;

  const locationKey = userLocation?.lat != null
    ? `geo_${Math.round(userLocation.lat * 100) / 100}_${Math.round(userLocation.lng * 100) / 100}_${Math.round((userLocation.radiusMeters ?? 5000) / 1000)}km`
    : "static";

  // Phase 15: auto fast mode under load (skip embedding + model — core ranking only).
  const autoFast =
    concurrentRecommendationRequests.count > HIGH_LOAD_CONCURRENT ||
    process.env.RECOMMENDATIONS_HIGH_LOAD === "true";
  const effectiveFast = fastMode || autoFast;

  const experimentActive   = isExperimentActive();
  const experimentVariant  = experimentActive ? getVariantForUser(userId) : null;
  const blendWeights       = experimentActive
    ? getBlendWeightsForVariant(experimentVariant)
    : { ruleBlendWeight: WEIGHTS.ruleBlendWeight, modelBlendWeight: WEIGHTS.modelBlendWeight };

  const typeFilterKey = discoverCategoryKey
    ? `disc:${discoverCategoryKey}`
    : typeFilter
      ? (Array.isArray(typeFilter) ? [...typeFilter].sort().join("+") : typeFilter)
      : "all";
  const modeKey = modeFilter ?? "default";

  try {
    const context = buildContext();

    logger.info(
      `[recommendations] uid=${userId} time=${context.timeOfDay} isWeekend=${context.isWeekend} ` +
      `isLateNight=${context.isLateNight} fastMode=${effectiveFast} autoLoad=${autoFast} ` +
      `forceRefresh=${forceRefresh}`,
    );

  // Pull-to-refresh / explicit refresh: bust every cached layer for this user
  // so interactions, affinity, and bandit state are re-read from Firestore.
  if (forceRefresh && !debug) {
    invalidateUserRecommendationCaches(userId);
  }

  // ── Phase 15: Profile data cache ─────────────────────────────────────────────
  // Caches { profile, routines, interactions, session } per user for 30 s.
  // Avoids 4 Firestore round-trips for repeated requests within that window.
  // The cache is invalidated by interaction.service.js on every new interaction.
  const pdKey    = `pd:${userId}`;
  const pdBundle = profileDataCache.get(pdKey);

  let profile, routines, interactions, session;

  if (pdBundle) {
    logger.debug(`[recommendations] profileData cache hit uid=${userId}`);
    ({ profile, routines, interactions, session } = pdBundle);
  } else {
    [profile, routines, interactions, session] = await Promise.all([
      getUserById(userId),
      fetchRoutines(userId),
      fetchInteractions(userId),
      getSession(userId),
    ]);
    // Only cache after we know the profile exists (null profiles are never stored).
    if (profile) {
      profileDataCache.set(pdKey, { profile, routines, interactions, session });
    }
  }

  if (!profile) {
    const err = new Error("User profile not found");
    err.statusCode = 404;
    throw err;
  }

  const userReligionEarly = (profile?.religion || "none").toLowerCase().trim();
  const recCacheKey = `rec:v2:${userId}:${effectiveFast ? "fast" : "full"}:${locationKey}:${
    experimentActive ? experimentVariant : "off"
  }:${typeFilterKey}:${modeKey}:rel:${userReligionEarly}`;

  if (!debug && !forceRefresh) {
    const cached = recommendationCache.get(recCacheKey);
    if (cached) {
      const elapsedMs = Math.round(performance.now() - startMs);
      logger.debug(`[recommendations] cache hit uid=${userId} elapsed=${elapsedMs}ms`);
      return {
        ...cached,
        meta: {
          ...cached.meta,
          performance: { ...cached.meta.performance, cacheHit: true, elapsedMs },
        },
      };
    }
  }

  // ── Discover → Events: scraped upcoming events only ─────────────────────────
  if (discoverCategoryKey === "event") {
    const events          = await getUpcomingEvents(Math.max(limit * 4, 40));
    const recommendations = mapDiscoverEventsToRecommendations(events, limit);
    const elapsedMs       = Math.round(performance.now() - startMs);
    const m               = loadModel();
    const meta = {
      profileFound:       true,
      routineCount:       routines.length,
      interactionCount:   interactions.length,
      topInterestType:    null,
      placesInCatalogue:  recommendations.length,
      detectedIntent:     null,
      discoverCategory:   "event",
      feedType:           "event",
      session:            {
        dominantSessionType: null,
        sessionIntent:     null,
        recentActionCount: 0,
      },
      longTerm:           { ...topEmbeddingEntry(profile?.embeddingSnapshot ?? null) },
      exploration:        { explorationWeight: 0, exploitationWeight: 0, explorationActive: false },
      ai: {
        modelActive:     isModelLoaded(),
        modelVersion:    m.version ?? "v1",
        versionNumber:   m.versionNumber ?? 0,
        lastTrainedAt:   m.trainedAt ?? null,
        sampleCount:     m.sampleCount ?? 0,
        predictedType:   null,
        confidence:      0,
        pyModelVersion:  "v0",
        pyModelActive:   false,
        llmEnabled:      false,
      },
      learning:          { recencyWeightActive: false, behaviorShiftDetected: false },
      location:          {
        source:            "events_firestore",
        radiusUsed:        userLocation?.radiusMeters ?? null,
        resultsFetched:    recommendations.length,
        typeFilter:        null,
        modeFilter:        modeFilter ?? null,
        discoverCategory:  "event",
      },
      personalization:   { dominantHabits: [], topInterestWeights: {} },
      experiment: experimentActive
        ? { experimentActive: true, experimentId: EXPERIMENT_ID, variantAssigned: experimentVariant }
        : { experimentActive: false, experimentId: null, variantAssigned: null },
      performance: {
        elapsedMs,
        cacheHit:          false,
        fallbackActive:    effectiveFast,
        heavyLoadFallback: autoFast && !fastMode,
        placesScored:      0,
      },
    };
    const result = { recommendations, context, meta };
    if (!debug) {
      recommendationCache.set(recCacheKey, result, recommendationCacheTtl(discoverCategoryKey));
    }
    logger.info(`[recommendations] events feed uid=${userId} count=${recommendations.length}`);
    return result;
  }

  const radiusMeters = userLocation?.radiusMeters ?? 5000;
  let places = [];
  if (
    discoverCategoryKey &&
    discoverCategoryKey !== "event" &&
    userLocation?.lat != null &&
    process.env.GOOGLE_MAPS_API_KEY
  ) {
    places = await getNearbyPlacesForDiscoverKey(
      { lat: userLocation.lat, lng: userLocation.lng },
      radiusMeters,
      discoverCategoryKey
    );
  }
  if (!places.length) {
    places = await getAllPlaces(
      userLocation?.lat != null ? { lat: userLocation.lat, lng: userLocation.lng } : null,
      radiusMeters
    );
  }

  // ── Inject admin-curated recommendations into the place catalogue ────────────
  // All curated recs (featured OR trending OR boosted) are pulled and checked
  // against user profile targeting BEFORE being added to the scoring pool.
  // Fast mode skips this to keep latency low.
  if (!fastMode) {
    try {
      // Pull up to 100 curated items (featured + trending + high-boost)
      const [featuredSnap, trendingSnap] = await Promise.all([
        db.collection("curated_recommendations").where("featured", "==", true).limit(50).get(),
        db.collection("curated_recommendations").where("trending", "==", true).limit(50).get(),
      ]);

      const allCuratedDocs = new Map();
      for (const snap of [featuredSnap, trendingSnap]) {
        for (const d of snap.docs) {
          allCuratedDocs.set(d.id, d);
        }
      }

      // Also pull high-priority items not already caught above
      const highPrioSnap = await db.collection("curated_recommendations")
        .orderBy("adminPriority", "desc").limit(30).get();
      for (const d of highPrioSnap.docs) {
        if (!allCuratedDocs.has(d.id)) allCuratedDocs.set(d.id, d);
      }

      // Resolve user profile for targeting
      const _profile = profile ?? {};
      const _userBudgetLabel = (_profile.budgetRange || "").toLowerCase();
      const _userReligionStr = (_profile.religion || "").toLowerCase();
      const _userGender      = (_profile.gender || "").toLowerCase();

      // ── Targeting check: only admit curated items that match user context ──
      const curatedPassed = [];
      for (const [, d] of allCuratedDocs) {
        const c = d.data();
        const crit = c.onboardingMatchCriteria ?? {};

        // Budget targeting — only reject if explicitly set and doesn't match
        if (crit.budgetTier) {
          const allowed = Array.isArray(crit.budgetTier) ? crit.budgetTier : [crit.budgetTier];
          const userTier = _userBudgetLabel || "medium";
          if (allowed.length > 0 && !allowed.some((t) => t.toLowerCase() === userTier)) continue;
        }

        // Religion targeting
        if (crit.religion) {
          const allowed = Array.isArray(crit.religion) ? crit.religion : [crit.religion];
          if (allowed.length > 0 && _userReligionStr && !allowed.some((r) => r.toLowerCase() === _userReligionStr)) continue;
        }

        // Gender targeting
        if (crit.gender) {
          const allowed = Array.isArray(crit.gender) ? crit.gender : [crit.gender];
          if (allowed.length > 0 && _userGender && !allowed.some((g) => g.toLowerCase() === _userGender)) continue;
        }

        // Audience tags — match if user profile has ANY matching interest
        if (Array.isArray(crit.audienceTags) && crit.audienceTags.length > 0) {
          const userInterests = new Set([
            ...(_profile.preferredActivities ?? []),
            ...(_profile.eventInterests ?? []),
            ...(_profile.weeklyActivities ?? []),
          ].map((t) => t.toLowerCase()));
          const hasMatch = crit.audienceTags.some((tag) => userInterests.has(tag.toLowerCase()));
          if (!hasMatch && userInterests.size > 0) continue;
        }

        curatedPassed.push({
          id: d.id,
          name: c.name,
          type: c.category,
          category: c.category,
          description: c.description ?? "",
          priceRange: c.budgetTier ?? "medium",
          tags: c.tags ?? [],
          location: c.location ?? {},
          rating: c.rating ?? 4.2,
          popularityScore: (c.adminPriority ?? 50) / 10,
          images: c.coverUrl ? [c.coverUrl] : (c.gallery ?? []),
          thumbnailUrl: c.thumbnailUrl ?? null,
          adminPriority: c.adminPriority ?? 50,
          aiBoostScore: c.aiBoostScore ?? 0,
          featured: c.featured ?? false,
          trending: c.trending ?? false,
          sponsored: c.sponsored ?? false,
          source: "admin_curated",
          adminCurated: true,
          googlePlaceId: c.googlePlaceId ?? null,
          googleMapsUrl: c.googleMapsUrl ?? null,
          familyFriendly: c.familyFriendly ?? null,
          studentFriendly: c.studentFriendly ?? null,
          professionalFriendly: c.professionalFriendly ?? null,
        });
      }

      // Merge, deduplicating by googlePlaceId or id
      const existingIds = new Set(places.map((p) => p.googlePlaceId ?? p.id));
      let injected = 0;
      for (const c of curatedPassed) {
        if (!existingIds.has(c.googlePlaceId ?? c.id)) {
          places.push(c);
          existingIds.add(c.googlePlaceId ?? c.id);
          injected++;
        }
      }
      if (injected > 0) {
        logger.debug(`[recommendations] injected ${injected} curated recommendations (${curatedPassed.length} passed targeting)`);
      }
    } catch (e) {
      logger.warn(`[recommendations] curated injection failed: ${e.message}`);
    }
  }

  const placeCategoryActive =
    Boolean(discoverCategoryKey) && discoverCategoryKey !== "event";

  let filteredPlaces;
  if (placeCategoryActive) {
    filteredPlaces = places.filter((p) =>
      placeMatchesDiscoverKey(p, discoverCategoryKey),
    );
  } else if (typeFilter) {
    const filters = Array.isArray(typeFilter)
      ? typeFilter.map((t) => String(t).trim().toLowerCase())
      : [String(typeFilter).trim().toLowerCase()];
    filteredPlaces = places.filter((p) => {
      const placeType = String(p?.type ?? "").toLowerCase();
      return filters.some((t) => placeType === t);
    });
  } else {
    filteredPlaces = places;
  }

  const legacyTypeFilterActive = Boolean(typeFilter) && !placeCategoryActive;

  const _rawScoringPlaces =
    placeCategoryActive || legacyTypeFilterActive
      ? filteredPlaces
      : places;

  // ── Religion pre-filter ───────────────────────────────────────────────────
  // Hard filter: religious venues are only shown when they match the user's
  // denomination.  Non-religious places are always shown to everyone.
  // We also stamp denominationType onto each church place so it propagates
  // to the mobile app (denomination badge, "matched to your religion" chip).
  const userReligion = profile?.religion || null;

  // Enrich church places that don't yet have a denominationType (e.g. Firestore seed data)
  for (const p of _rawScoringPlaces) {
    const ptype = (p.type || p.category || "").toLowerCase();
    if (ptype === "church" && !p.denominationType) {
      const denom = classifyDenomination(p);
      if (denom.isReligious) {
        p.denominationType       = denom.denomination;
        p.denominationConfidence = denom.confidence;
      }
    }
  }

  const scoringPlaces = userReligion && userReligion !== "other" && userReligion !== "prefer_not_to_say"
    ? _rawScoringPlaces.filter((p) => placeAllowedByReligion(p, userReligion))
    : _rawScoringPlaces;

  if (scoringPlaces.length < _rawScoringPlaces.length) {
    logger.info(
      `[recommendations] religion pre-filter uid=${userId} religion=${userReligion} ` +
      `removed=${_rawScoringPlaces.length - scoringPlaces.length} places`,
    );
  }

  // ── Fast pricing visibility + tier (only when spend typically applies) ─────
  const _userBudgetTier  = userBudgetTier(profile);
  const _userBudgetLevel = tierToNumber(_userBudgetTier);
  for (const p of scoringPlaces) {
    const pe = resolvePricingEligibility(p);
    p._pricingEnabled = pe.pricingEnabled;
    p._pricingReason = pe.reason;
    if (pe.pricingEnabled) {
      if (!p._fastPriceLevel) {
        const { priceLevel } = classifyPrice(p);
        p._fastPriceLevel = priceLevel;
      }
    } else {
      p._fastPriceLevel = null;
    }
  }

  if (discoverCategoryKey && discoverCategoryKey !== "event" && scoringPlaces.length === 0) {
    const elapsedMs = Math.round(performance.now() - startMs);
    const m         = loadModel();
    const meta = {
      profileFound:       true,
      routineCount:       routines.length,
      interactionCount:   interactions.length,
      topInterestType:    null,
      placesInCatalogue:  0,
      detectedIntent:     null,
      discoverCategory:   discoverCategoryKey,
      categoryEmpty:      true,
      session:            {
        dominantSessionType: null,
        sessionIntent:     null,
        recentActionCount: 0,
      },
      longTerm:           { ...topEmbeddingEntry(profile?.embeddingSnapshot ?? null) },
      exploration:        { explorationWeight: 0, exploitationWeight: 0, explorationActive: false },
      ai: {
        modelActive:    isModelLoaded(),
        modelVersion:   m.version ?? "v1",
        versionNumber:  m.versionNumber ?? 0,
        lastTrainedAt:  m.trainedAt ?? null,
        sampleCount:    m.sampleCount ?? 0,
        predictedType:  null,
        confidence:     0,
        pyModelVersion: "v0",
        pyModelActive:  false,
        llmEnabled:     false,
      },
      learning:          { recencyWeightActive: false, behaviorShiftDetected: false },
      location:          {
        source:
          userLocation?.lat != null && process.env.GOOGLE_MAPS_API_KEY ? "google_maps" : "firestore",
        radiusUsed:        userLocation?.radiusMeters ?? null,
        resultsFetched:    0,
        typeFilter:        typeFilter ?? null,
        modeFilter:        modeFilter ?? null,
        discoverCategory:  discoverCategoryKey,
      },
      personalization:   { dominantHabits: [], topInterestWeights: {} },
      experiment: experimentActive
        ? { experimentActive: true, experimentId: EXPERIMENT_ID, variantAssigned: experimentVariant }
        : { experimentActive: false, experimentId: null, variantAssigned: null },
      performance: {
        elapsedMs,
        cacheHit:          false,
        fallbackActive:    effectiveFast,
        heavyLoadFallback: autoFast && !fastMode,
        placesScored:      0,
      },
    };
    const result = { recommendations: [], context, meta };
    if (!debug) {
      recommendationCache.set(recCacheKey, result, recommendationCacheTtl(discoverCategoryKey));
    }
    return result;
  }

  const now = new Date();

  // Build lookup structures using the (possibly type-filtered) scoring pool.
  const placeLookup = buildPlaceLookupMap(scoringPlaces);

  // ── Phase 15: Precomputed affinity / index maps (derivedSignalsCache) ─────────
  const nowMinuteBucket = Math.floor(Date.now() / 60000);
  const interactionFingerprint = buildInteractionFingerprint(interactions);
  const dsKey = `ds:${userId}:${locationKey}:${interactionFingerprint}:${nowMinuteBucket}`;

  let affinityMap;
  let savedIds;
  let dismissedIds;
  let interactionIndex;
  let seenCountMap;
  let topInterestType;

  const derivedHit = derivedSignalsCache.get(dsKey);
  if (derivedHit) {
    ({
      affinityMap,
      savedIds,
      dismissedIds,
      interactionIndex,
      seenCountMap,
      topInterestType,
    } = derivedHit);
    logger.debug(`[recommendations] derivedSignals cache hit uid=${userId}`);
  } else {
    affinityMap = buildTypeAffinityMap(interactions, placeLookup);
    const strong = buildStrongSignalSets(interactions, placeLookup);
    savedIds     = strong.savedIds;
    dismissedIds = strong.dismissedIds;
    interactionIndex = buildInteractionIndex(interactions, placeLookup, now);
    seenCountMap       = buildSeenCountMap(profile.seenPlaces ?? []);
    topInterestType    = deriveTopInterestType(affinityMap);
    derivedSignalsCache.set(dsKey, {
      affinityMap,
      savedIds,
      dismissedIds,
      interactionIndex,
      seenCountMap,
      topInterestType,
    });
  }

  // ── v18: Merge persistent per-place negative memory ─────────────────────────
  // The strong-signal sets above only see recent interactions (RECENT window).
  // Without merging the profile-level sets, a dismissed place quietly returns
  // after the user's interaction history scrolls past it. We union both so the
  // user's negative intent is permanent until they reverse it (save/like).
  const persistentSaved        = new Set(Array.isArray(profile.savedPlaceIds)         ? profile.savedPlaceIds         : []);
  const persistentDismissed    = new Set(Array.isArray(profile.dismissedPlaceIds)     ? profile.dismissedPlaceIds     : []);
  const persistentDisliked     = new Set(Array.isArray(profile.dislikedPlaceIds)      ? profile.dislikedPlaceIds      : []);
  const persistentNotInterested = new Set(Array.isArray(profile.notInterestedPlaceIds) ? profile.notInterestedPlaceIds : []);

  for (const id of persistentSaved)     savedIds.add(id);
  for (const id of persistentDismissed) dismissedIds.add(id);

  // Hard-block set — these places must NEVER appear in recommendations.
  // (dislike + not_interested are the user's strongest "stop showing me" signals.)
  const hardBlockedIds = new Set();
  for (const id of persistentDisliked)     hardBlockedIds.add(id);
  for (const id of persistentNotInterested) hardBlockedIds.add(id);

  // ── v7: Short-term memory window (newest-first, capped at RECENT_INTERACTIONS_WINDOW) ──
  const recentInteractions = interactions
    .slice()
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta; // newest first
    })
    .slice(0, RECENT_INTERACTIONS_WINDOW);

  // ── v7: Long-term intent + echo-chamber structures ────────────────────────────
  const longTermIntent    = detectUserIntent(profile, recentInteractions, placeLookup);
  const recentAffinityMap = buildRecentAffinityMap(recentInteractions, placeLookup, now);
  const dominantTypes     = buildDominantTypes(recentInteractions, placeLookup);

  // ── v13: behaviour shift (last 10 vs historical mean action score) ───────────
  const { behaviorShiftDetected, recentAvg, historicalAvg } = detectBehaviorShift(interactions);
  if (behaviorShiftDetected) {
    logger.info(
      `[recommendations] behaviorShift detected recentAvg=${recentAvg.toFixed(3)} ` +
      `historicalAvg=${historicalAvg.toFixed(3)} — down-weighting long-term, boosting recent/session`
    );
  }

  // ── v8: Session signals ───────────────────────────────────────────────────────
  const recentActions       = session.recentActions ?? [];
  const dominantSessionType = computeDominantSessionType(recentActions);
  const sessionIntent       = computeSessionIntent(dominantSessionType);

  // Session intent overrides the long-term intent when the session has enough
  // data and a non-explore result (avoid overriding with a weak/empty signal).
  const sessionHasSignal =
    recentActions.length >= SESSION_INTENT_OVERRIDE_MIN && sessionIntent !== "explore";
  const detectedIntent = sessionHasSignal ? sessionIntent : longTermIntent;

  // Most recent action type — used by sequenceBoost (Rule 19).
  const lastSessionType = recentActions.length > 0 ? recentActions[0].type : null;

  // Cold-start flag: true when the user has very few personal interactions.
  const isColdStart = interactions.length < COLD_START_THRESHOLD;

  // ── v9: User embedding (long-term taste vector) ───────────────────────────────
  const userEmbedding = profile.embedding ?? {};

  // ── v10: Exploration / exploitation balance ───────────────────────────────────
  // Determine dynamic weights based on how much signal the user has generated.
  // New users explore; active users exploit their confirmed preferences.
  const isActiveUser       = interactions.length >= ACTIVE_USER_THRESHOLD;
  const explorationWeight  = isActiveUser ? EXPLORATION_WEIGHT_ACTIVE : EXPLORATION_WEIGHT_NEW;
  const exploitationWeight = isActiveUser ? EXPLOITATION_WEIGHT_ACTIVE : EXPLOITATION_WEIGHT_NEW;

  // Count per-type frequency in the recent window for Rule 23 + Rule 24.
  const recentTypeCounts = buildRecentTypeCounts(recentInteractions, placeLookup);

  // ── v16: Interest weights + habit detection (per request) ────────────────────
  const resolvePid = (placeId) => resolvePlace(placeLookup, placeId);
  const { weights: interestWeights } = buildTopInterestWeights(
    profile,
    recentInteractions,
    now,
    resolvePid
  );
  const { habits: dominantHabits } = detectDominantHabits(interactions, now, resolvePid);

  logger.info(
    `[recommendations] longTermIntent=${longTermIntent} sessionIntent=${sessionIntent}` +
    ` effectiveIntent=${detectedIntent} dominantSessionType=${dominantSessionType ?? "none"}` +
    ` lastSessionType=${lastSessionType ?? "none"} isColdStart=${isColdStart}` +
    ` explorationW=${explorationWeight} exploitationW=${exploitationWeight}`
  );

  // ── Phase 1: Score every catalogue place (chunked async for parallel scheduling) ─
  const scoreOne = (place) => {
    const { rawScore, breakdown } = scorePlaceForUser(
      place, profile, routines, interactions,
      affinityMap, placeLookup, context, interactionIndex, seenCountMap,
      detectedIntent, recentAffinityMap, dominantTypes,
      dominantSessionType, lastSessionType, isColdStart,
      userEmbedding, explorationWeight, exploitationWeight, recentTypeCounts,
      behaviorShiftDetected, effectiveFast,
      interestWeights,
      dominantHabits,
      blendWeights.ruleBlendWeight,
      blendWeights.modelBlendWeight
    );

    const normalizedScore = normalizeScore(rawScore);

    const photoRefs = (place.photoReferences ?? []).filter(Boolean).slice(0, 5);
    let images = [];
    if (photoRefs.length > 0) {
      images = buildPlacePhotoPaths(place.id, photoRefs, { max: 4, width: 800 });
    } else if (Array.isArray(place.images) && place.images.length) {
      images = place.images;
    }

    const pricingEnabled = place._pricingEnabled === true;
    const fastPrice = pricingEnabled ? (place._fastPriceLevel || "mid") : null;
    const religionAllowed = placeAllowedByReligion(place, userReligion);
    const lifestyleMatch  = (breakdown.activitiesBoost ?? 0) > 0;

    const placeMatch = {
      budget:    !pricingEnabled || tierToNumber(fastPrice) <= _userBudgetLevel,
      religion:  religionAllowed,
      lifestyle: lifestyleMatch,
    };

    // Build a simple pre-AI match percent from rule-level signals only.
    // Will be overwritten by the AI service's richer match_percent when available.
    const ruleMatchPct = (() => {
      let pts = 0;
      if (placeMatch.budget)    pts += 30;
      if (placeMatch.religion)  pts += 30;
      if (lifestyleMatch)       pts += 20;
      if ((breakdown.genderPenalty ?? 0) === 0) pts += 10;
      pts += Math.round((normalizedScore / 100) * 10);
      return Math.min(100, pts);
    })();

    const entry = {
      id:         place.id,
      name:       place.name,
      type:       place.type,
      score:      normalizedScore,
      rawScore:   +rawScore.toFixed(3),
      trendScore: place.trendScore  ?? 0,
      rating:     place.rating      ?? 3.0,
      distanceKm: place.distanceKm  ?? null,
      matchPercent: ruleMatchPct,
      images,
      photoReferences: photoRefs.length ? photoRefs.slice(0, 5) : undefined,
      // Carry through fields used for AI pricing/RAG (consumed by callAiService).
      description:      place.description      ?? "",
      address:          place.address          ?? place.vicinity ?? "",
      userRatingsTotal: place.userRatingsTotal ?? null,
      googlePriceLevel: place.priceLevel       ?? null,
      tags:             Array.isArray(place.tags) ? place.tags : [],
      pricingEnabled,
      pricingReason:    place._pricingReason || null,
      priceLevel:       fastPrice,
      priceSource:      pricingEnabled ? "fast_classifier" : "n/a",
      estimatedCost:    pricingEnabled ? undefined : {},
      matches:          placeMatch,
    };

    if (images.length) entry.images = images;
    if (photoRefs.length) entry.photoReferences = photoRefs;

    // Carry denomination metadata through to the mobile client
    if (place.denominationType) {
      entry.denominationType       = place.denominationType;
      entry.denominationConfidence = place.denominationConfidence ?? null;
    }

    if (typeof place.userRatingsTotal === "number") {
      entry.userRatingsTotal = place.userRatingsTotal;
    }

    // Admin curation metadata — consumed by mobile badges (Featured, Trending, Admin Pick)
    if (place.adminCurated || place.source === "admin_curated") {
      entry.adminCurated      = true;
      entry.featured          = place.featured   ?? false;
      entry.trending          = place.trending   ?? false;
      entry.sponsored         = place.sponsored  ?? false;
      entry.adminBoostApplied = breakdown.adminBoost ?? 0;
      entry.audienceMatchScore = breakdown.audienceMatchScore ?? null;
      entry.googlePlaceId     = place.googlePlaceId ?? null;
      entry.googleMapsUrl     = place.googleMapsUrl ?? null;
      entry.thumbnailUrl      = place.thumbnailUrl  ?? null;
    } else {
      // Carry featured/trending even for regular places set by admin via PATCH /places/:id/boost
      if (place.featured) entry.featured = true;
      if (place.trending) entry.trending = true;
      if (breakdown.adminBoost > 0) {
        entry.adminBoostApplied = breakdown.adminBoost;
        entry.audienceMatchScore = breakdown.audienceMatchScore ?? null;
      }
    }

    if (debug) entry.scoreBreakdown = breakdown;

    return entry;
  };

  // v18: Hard-block disliked + not_interested places before we even score them.
  // Saves compute and guarantees they never surface, even via diversity passes.
  const scorablePlaces = hardBlockedIds.size > 0
    ? scoringPlaces.filter((p) => !hardBlockedIds.has(p.id))
    : scoringPlaces;

  if (hardBlockedIds.size > 0 && scorablePlaces.length < scoringPlaces.length) {
    logger.info(
      `[recommendations] hardBlock filter uid=${userId} ` +
      `blocked=${scoringPlaces.length - scorablePlaces.length} ` +
      `(disliked=${persistentDisliked.size} notInterested=${persistentNotInterested.size})`,
    );
  }

  const scored = await scorePlacesInChunks(scorablePlaces, scoreOne);

  // ── Phase AI: Merge Python AI service scores ──────────────────────────────────
  // Calls /predict on the AI microservice (contextual bandit + GRU + embeddings).
  // On success, merges: finalScore = 0.7 × rawScore + 0.3 × aiScore.
  // On timeout / service-down, scored entries are left unchanged (rawScore only).
  // Skipped in fastMode because latency must remain under the fast-mode budget.
  let _aiPredictedType = null;
  let _aiConfidence    = 0;
  let _aiModelVersion  = "v0";

  let _aiLlmEnabled = false;

  const discoverKeyForAi = discoverCategoryKey ?? undefined;

  if (!effectiveFast) {
    const {
      scoreMap:      aiScoreMap,
      enrichmentMap: aiEnrichmentMap,
      predictedType, confidence, modelVersion, llmEnabled,
    } = await callAiService(
      userId,
      scored,
      { ...context, detectedIntent, discoverCategoryKey: discoverKeyForAi },
      recentActions,
      profile?.typeAffinity,
      profile,
      {
        // v18: forward persistent negative memory so the AI service can also
        // hard-block and penalise at the per-place level (defence in depth).
        dislikedPlaceIds:      Array.from(persistentDisliked),
        dismissedPlaceIds:     Array.from(persistentDismissed),
        notInterestedPlaceIds: Array.from(persistentNotInterested),
        savedPlaceIds:         Array.from(persistentSaved),
      },
    );

    _aiPredictedType = predictedType;
    _aiConfidence    = confidence;
    _aiModelVersion  = modelVersion;
    _aiLlmEnabled    = llmEnabled;

    if (aiScoreMap.size > 0) {
      const AI_BLEND = parseFloat(process.env.AI_SCORE_BLEND ?? "0.3");
      const RULE_BLEND = 1 - AI_BLEND;

      for (const entry of scored) {
        const aiScore = aiScoreMap.get(entry.id);
        if (aiScore === undefined) continue;

        // Normalise the rule rawScore to [0,1] range for blending with aiScore
        // (rawScore can be negative; we use the normalised [0,100] score / 100).
        const ruleNorm = entry.score / 100;
        const blended  = RULE_BLEND * ruleNorm + AI_BLEND * aiScore;

        // Update both rawScore and normalised score
        entry.rawScore = +(entry.rawScore + (aiScore - 0.5) * 10).toFixed(3);
        entry.score    = normalizeScore(entry.rawScore);

        // ── Attach AI enrichment (pricing + reason) ──────────────────────
        const enrichment = aiEnrichmentMap.get(entry.id);
        if (enrichment) {
          if (typeof enrichment.pricingEnabled === "boolean") {
            entry.pricingEnabled = enrichment.pricingEnabled;
          }
          entry.pricingReason = enrichment.pricingReason ?? entry.pricingReason ?? null;

          if (!entry.pricingEnabled) {
            entry.priceLevel = null;
            entry.estimatedCost = {};
            entry.priceConfidence = 0;
            entry.priceSource = "ai_disabled";
            if (enrichment.priceSignals?.length) {
              entry.priceSignals = enrichment.priceSignals;
            }
            entry.priceCategory = enrichment.priceCategory ?? entry.priceCategory;
            if (enrichment.reason) entry.reason = enrichment.reason;
            entry.matches = {
              budget:    true,
              religion:  enrichment.religionMatch  ?? entry.matches?.religion  ?? true,
              lifestyle: enrichment.lifestyleMatch ?? entry.matches?.lifestyle ?? false,
            };
            // Persona alignment
            if (enrichment.personaMatch) entry.personaMatch = enrichment.personaMatch;
            if (enrichment.personaReasons?.length) entry.personaReasons = enrichment.personaReasons;
            if (enrichment.matchPercent != null) entry.matchPercent = enrichment.matchPercent;
          } else {
            entry.priceLevel = enrichment.priceLevel ?? entry.priceLevel;
            entry.priceSource = "ai_classifier";
            entry.priceConfidence = enrichment.priceConfidence;
            entry.priceCategory = enrichment.priceCategory;
            entry.estimatedCost = enrichment.estimatedCost;
            if (enrichment.priceSignals?.length) {
              entry.priceSignals = enrichment.priceSignals;
            }
            if (enrichment.reason) entry.reason = enrichment.reason;
            // Persona alignment
            if (enrichment.personaMatch) entry.personaMatch = enrichment.personaMatch;
            if (enrichment.personaReasons?.length) entry.personaReasons = enrichment.personaReasons;
            entry.matches = {
              budget:    tierToNumber(entry.priceLevel || "mid") <= _userBudgetLevel,
              religion:  enrichment.religionMatch  ?? entry.matches?.religion  ?? true,
              lifestyle: enrichment.lifestyleMatch ?? entry.matches?.lifestyle ?? false,
            };
            if (enrichment.matchPercent != null) entry.matchPercent = enrichment.matchPercent;
          }
        }

        if (predictedType) entry.predictedType = predictedType;

        if (debug && entry.scoreBreakdown) {
          entry.scoreBreakdown.modelScore     = +(aiScore).toFixed(4);
          entry.scoreBreakdown.aiBlendedScore = +blended.toFixed(4);
          entry.scoreBreakdown.predictedType  = predictedType ?? null;
        }
      }
      logger.info(
        `[AI] merged ${aiScoreMap.size} aiScores+enrichment ` +
        `predictedType=${predictedType} llm=${llmEnabled} uid=${userId}`,
      );
    }
  }

  // ── Phase 2: Filter out dismissed places ─────────────────────────────────────
  const _afterDismissed = scored.filter((p) => !dismissedIds.has(p.id));

  // ── Phase 2b: Strict budget filter ────────────────────────────────────────
  // Hard rule: never surface places priced above the user's budget tier.
  //   cheap     → only cheap places
  //   mid       → cheap + mid places
  //   expensive → all tiers allowed
  // Only applied when the user has set a budget (not cold-start).
  // Uses AI-enriched priceLevel when available; falls back to _fastPriceLevel
  // (heuristic) set during the pricing pre-pass so the filter works even in fast mode.
  const hasBudget = Boolean(profile?.weeklyBudget || profile?.budgetRange);
  const withoutDismissed = hasBudget
    ? _afterDismissed.filter((p) => {
        if (!p.pricingEnabled) return true;
        // Prefer AI-enriched level; fall back to fast heuristic
        const effectiveTier = p.priceLevel || p._fastPriceLevel || "mid";
        const pLevel = tierToNumber(effectiveTier);
        return pLevel <= _userBudgetLevel;
      })
    : _afterDismissed;

  if (hasBudget && withoutDismissed.length < _afterDismissed.length) {
    logger.info(
      `[recommendations] budget filter uid=${userId} budget=${_userBudgetTier} ` +
      `removed=${_afterDismissed.length - withoutDismissed.length} over-budget places`,
    );
  }

  // ── Phase 3: Sort descending by normalized score ──────────────────────────────
  withoutDismissed.sort((a, b) => b.score - a.score);

  // Pull-to-refresh: deprioritise recently shown places so the feed rotates
  // instead of returning the exact same top picks on every swipe-down.
  if (forceRefresh) {
    const recentlyShown = new Set((profile.seenPlaces ?? []).slice(-15));
    for (const entry of withoutDismissed) {
      if (recentlyShown.has(entry.id)) {
        entry.rawScore = +(entry.rawScore - 8).toFixed(3);
        entry.score    = normalizeScore(entry.rawScore);
      }
    }
    withoutDismissed.sort((a, b) => b.score - a.score);
  }

  // ── Phase 3b (v8 NEW): Type-diversity penalty pass ───────────────────────────
  // Walk the sorted list and apply an increasing penalty each time the same
  // type appears consecutively.  This discourages runs of identical types at
  // the top of the ranking without fully discarding them.
  {
    let prevType = null;
    let consec   = 0;
    for (const entry of withoutDismissed) {
      if (entry.type === prevType) {
        consec += 1;
        const pen = WEIGHTS.typeDiversityPenalty * consec;
        entry.rawScore = +(entry.rawScore + pen).toFixed(3);
        entry.score    = normalizeScore(entry.rawScore);
        if (debug && entry.scoreBreakdown) entry.scoreBreakdown.typeDiversityPenalty = pen;
      } else {
        consec = 0;
        if (debug && entry.scoreBreakdown) entry.scoreBreakdown.typeDiversityPenalty = 0;
      }
      prevType = entry.type;
    }
    // Re-sort after penalties.
    withoutDismissed.sort((a, b) => b.score - a.score);
  }

  // ── Phase 3c (v10 NEW): Diversity boost pass ──────────────────────────────────
  // Count how often each type appears in the top portion of the sorted list.
  // Types that appear less than half as often as the average frequency receive a
  // +diversityBoostWeight lift so under-represented categories don't get buried.
  {
    const sampleSize = Math.min(withoutDismissed.length, limit * 2);
    const topSlice   = withoutDismissed.slice(0, sampleSize);

    const typeFreq = new Map();
    for (const entry of topSlice) {
      typeFreq.set(entry.type, (typeFreq.get(entry.type) ?? 0) + 1);
    }

    const distinctTypeCount = typeFreq.size;
    const avgFreq = distinctTypeCount > 0 ? sampleSize / distinctTypeCount : 1;

    for (const entry of withoutDismissed) {
      const freq = typeFreq.get(entry.type) ?? 0;
      if (freq < avgFreq * 0.5) {
        // Underrepresented type — boost it to surface variety.
        const boost = WEIGHTS.diversityBoostWeight;
        entry.rawScore = +(entry.rawScore + boost).toFixed(3);
        entry.score    = normalizeScore(entry.rawScore);
        if (debug && entry.scoreBreakdown) entry.scoreBreakdown.diversityBoost = boost;
      } else {
        if (debug && entry.scoreBreakdown) entry.scoreBreakdown.diversityBoost = 0;
      }
    }
    // Re-sort after boosts.
    withoutDismissed.sort((a, b) => b.score - a.score);
  }

  // ── Phase 4: Diversity — max 3 per type pool, then interleave ────────────────
  const typeCount  = new Map();
  const poolCapped = [];
  for (const p of withoutDismissed) {
    const n = typeCount.get(p.type) ?? 0;
    if (n >= 3) continue;
    typeCount.set(p.type, n + 1);
    poolCapped.push(p);
  }

  const interleaved = injectDiversity(poolCapped, limit * 2);

  // ── Phase 5: Pin saved places into top-5 ─────────────────────────────────────
  const saved   = interleaved.filter((p) =>  savedIds.has(p.id));
  const others  = interleaved.filter((p) => !savedIds.has(p.id));
  const pinned  = saved.slice(0, 5);
  let recommendations = [...pinned, ...others.slice(0, limit - pinned.length)];

  // Final order must match score (default: AI-blended score descending).
  // Photo-availability tiebreaker: when scores are within 1.5 points, prefer
  // places that have Google photoReferences. Keeps real venues above
  // photo-less seed entries without disturbing the scoring math.
  const hasPhoto = (p) =>
    (Array.isArray(p.photoReferences) && p.photoReferences.length > 0) ||
    (Array.isArray(p.images) && p.images.length > 0);
  recommendations.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 1.5) return diff;
    const ap = hasPhoto(a) ? 1 : 0;
    const bp = hasPhoto(b) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return diff;
  });

  // ── Mode override: re-rank the final list for trending / nearby ──────────────
  if (modeFilter === "trending") {
    // Trending sort order:
    //   1. Admin-marked trending items (source=admin_curated + trending=true) → ranked
    //      by adminPriority descending, then AI score
    //   2. Remaining places: ranked by trendScore × rating × 0.9 + AI score × 0.1
    recommendations.sort((a, b) => {
      const aAdminTrend = (a.adminCurated || a.trending) ? 1 : 0;
      const bAdminTrend = (b.adminCurated || b.trending) ? 1 : 0;
      if (aAdminTrend !== bAdminTrend) return bAdminTrend - aAdminTrend;

      // Among admin-trending items, sort by adminPriority then score
      if (aAdminTrend && bAdminTrend) {
        const pDiff = (b.adminBoostApplied ?? 0) - (a.adminBoostApplied ?? 0);
        if (Math.abs(pDiff) > 0.5) return pDiff;
        return b.score - a.score;
      }

      // Regular places: trendScore × rating signal
      const trendA = (a.trendScore ?? 0) * (a.rating ?? 3);
      const trendB = (b.trendScore ?? 0) * (b.rating ?? 3);
      if (trendA === 0 && trendB === 0) return b.score - a.score;
      return trendB + b.score * 0.1 - (trendA + a.score * 0.1);
    });
  } else if (modeFilter === "nearby") {
    // Nearby: sort by distanceKm ascending when available.
    // Places without distanceKm sort after those that have it, fallback to AI.
    recommendations.sort((a, b) => {
      const dA = a.distanceKm;
      const dB = b.distanceKm;
      if (dA == null && dB == null) return b.score - a.score;
      if (dA == null) return 1;
      if (dB == null) return -1;
      return dA - dB;
    });
  }

  // ── v16: Hard cap — max 2 of the same type in top 5 ───────────────────────────
  enforceMaxSameTypeInTopN(recommendations, withoutDismissed, 5, 2);

  if (discoverCategoryKey && discoverCategoryKey !== "event") {
    const asPlace = (r) => ({
      type: r.type,
      name: r.name,
      tags: r.tags ?? [],
      category: r.category,
    });
    recommendations = recommendations
      .filter((r) => placeMatchesDiscoverKey(asPlace(r), discoverCategoryKey))
      .slice(0, limit);
  }

  const meta = {
    profileFound:      true,
    routineCount:      routines.length,
    interactionCount:  interactions.length,
    topInterestType,
    placesInCatalogue: scoringPlaces.length,
    detectedIntent,
    session: {
      dominantSessionType: dominantSessionType ?? null,
      sessionIntent,
      recentActionCount:   recentActions.length,
    },
    longTerm: {
      ...topEmbeddingEntry(userEmbedding),
    },
    exploration: {
      explorationWeight,
      exploitationWeight,
      explorationActive: true,
    },
    ai: (() => {
      const m = loadModel();
      return {
        modelActive:    isModelLoaded(),
        modelVersion:   m.version       ?? "v1",
        versionNumber:  m.versionNumber ?? 0,
        lastTrainedAt:  m.trainedAt     ?? null,
        sampleCount:    m.sampleCount   ?? 0,
        // Python AI microservice predictions
        predictedType:  _aiPredictedType,
        confidence:     _aiConfidence,
        pyModelVersion: _aiModelVersion,
        pyModelActive:  _aiPredictedType !== null,
        llmEnabled:     _aiLlmEnabled,
      };
    })(),
    learning: {
      recencyWeightActive:   true,
      behaviorShiftDetected,
    },
    location: {
      source:         (userLocation?.lat != null && process.env.GOOGLE_MAPS_API_KEY)
                        ? "google_maps"
                        : "firestore",
      radiusUsed:     userLocation?.radiusMeters ?? null,
      resultsFetched: scoringPlaces.length,
      typeFilter:     typeFilter  ?? null,
      modeFilter:     modeFilter  ?? null,
      discoverCategory: discoverCategoryKey ?? null,
    },
    discoverCategory: discoverCategoryKey ?? null,
    personalization: {
      dominantHabits,
      topInterestWeights: topWeightsForMeta(interestWeights, 5),
    },
    experiment: experimentActive
      ? {
          experimentActive: true,
          experimentId:     EXPERIMENT_ID,
          variantAssigned:  experimentVariant,
        }
      : {
          experimentActive: false,
          experimentId:     null,
          variantAssigned:  null,
        },
  };
  if (debug) {
    meta.context = context;
  }

  // ── Phase 15: Timing + result caching ────────────────────────────────────────
  const elapsedMs = Math.round(performance.now() - startMs);

  if (elapsedMs > 300) {
    logger.warn(`[recommendations] SLOW uid=${userId} elapsed=${elapsedMs}ms fallback=${effectiveFast}`);
  } else {
    logger.info(`[recommendations] uid=${userId} elapsed=${elapsedMs}ms cacheHit=false`);
  }

  meta.performance = {
    elapsedMs,
    cacheHit:          false,
    fallbackActive:    effectiveFast,
    heavyLoadFallback: autoFast && !fastMode,
    placesScored:      scoringPlaces.length,
  };

  // Final safety net: re-apply strict denomination filter on output (guards cache / AI paths).
  const userReligionFinal = profile?.religion || null;
  let finalRecommendations = recommendations;
  if (
    userReligionFinal &&
    userReligionFinal !== "other" &&
    userReligionFinal !== "prefer_not_to_say"
  ) {
    const before = finalRecommendations.length;
    finalRecommendations = finalRecommendations.filter((rec) =>
      placeAllowedByReligion(rec, userReligionFinal),
    );
    if (before > finalRecommendations.length) {
      logger.info(
        `[recommendations] final religion filter uid=${userId} religion=${userReligionFinal} ` +
        `removed=${before - finalRecommendations.length}`,
      );
    }
  }

  const result = { recommendations: finalRecommendations, context, meta };

  // Cache full-mode and fast-mode results separately; never cache debug responses.
  if (!debug) {
    recommendationCache.set(recCacheKey, result, recommendationCacheTtl(discoverCategoryKey));
  }

  return result;
  } catch (err) {
    // Phase 18: safety catch — log with context, re-throw as clean 500.
    // Optionally return a minimal seed-based fallback when profile was resolved.
    logger.error("[recommendations] getRecommendations failed", {
      uid:     userId,
      message: err.message,
      stack:   err.stack,
    });

    if (process.env.RECOMMENDATION_FALLBACK_ENABLED === "true") {
      // Return the first few seed places as a minimal safe response.
      const fallback = SEED_PLACES.slice(0, 5).map((p) => ({
        ...p,
        score: 0,
        meta: { fallback: true },
      }));
      logger.warn(`[recommendations] returning fallback list (${fallback.length} seeds) for uid=${userId}`);
      return {
        recommendations: fallback,
        context:         {},
        meta:            { fallback: true, error: "Recommendation engine temporarily unavailable" },
      };
    }

    const safeErr = new Error("Recommendation engine temporarily unavailable");
    safeErr.statusCode = 500;
    throw safeErr;
  } finally {
    concurrentRecommendationRequests.count -= 1;
  }
};
