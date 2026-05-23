/**
 * interaction.service.js — Firestore data layer for user interactions.
 *
 * Responsibility: all reads/writes to the "interactions" collection.
 * No Express-specific code lives here — controllers call these functions.
 *
 * Score mapping (mirrors the product spec):
 *   view    → +1
 *   click   → +2
 *   save    → +3
 *   dismiss → -1
 *
 * Real-time learning (v6):
 *   After each interaction is persisted, updateUserIntelligence() is called
 *   to update the user's typeAffinity map and seenPlaces list on their profile
 *   document.  This ensures the NEXT recommendation request immediately sees
 *   the updated signals — no cache delay for the learning layer.
 *
 * Session memory (Phase 8):
 *   updateSession() is called concurrently with updateUserIntelligence() so
 *   the short-term session queue is advanced on every interaction.  Failure
 *   is non-fatal — the interaction write and intelligence update are unaffected.
 */

import { db } from "../config/firebase.js";
import { updateUserIntelligence } from "./user.service.js";
import { getAllPlaces }            from "./place.service.js";
import { SEED_PLACES }             from "../data/places.seed.js";
import { updateSession }           from "./session.service.js";
import { maybeRetrain }            from "../jobs/retrainModel.js";
import {
  sendInteractionFeedback,
  sendInteractionFeedbackBatch,
} from "./aiFeedback.service.js";
import {
  recommendationCache,
  profileDataCache,
  derivedSignalsCache,
} from "../utils/cache.js";
import {
  isExperimentActive,
  getVariantForUser,
  EXPERIMENT_ID,
} from "../utils/experiment.js";
import { logger } from "../utils/logger.js";

const INTERACTIONS_COLLECTION = "interactions";

/** Phase 17: optional top-level fields when EXPERIMENT_ACTIVE=true */
const experimentStampForUser = (userId) => {
  if (!isExperimentActive()) return {};
  return {
    experimentId:      EXPERIMENT_ID,
    experimentVariant: getVariantForUser(userId),
  };
};

/**
 * Allowed actionType values and their corresponding log scores.
 *
 * Weights reflect the strength of the signal for ML learning.
 * Positive = engagement/preference, Negative = rejection.
 */
export const ACTION_SCORES = Object.freeze({
  // ── Neutral / passive ──────────────────────────────────────────────────────
  view:             1,   // short passive view
  view_long:        8,   // long detail-page stay — STRONG signal (was 6)
  // ── Navigation intent ──────────────────────────────────────────────────────
  click:            3,   // tapped to open details (was 2)
  directions:       9,   // opened directions — very strong intent (was 7)
  call:             6,   // tapped to call the place (was 5)
  share:            6,   // shared recommendation (was 5)
  // ── Affinity ───────────────────────────────────────────────────────────────
  like:             7,   // explicit like (was 5)
  save:            10,   // saved to favourites — STRONGEST taste signal (was 8)
  mark_interested:  5,   // marked as interested (was 4)
  revisit:         12,   // returned to a place — highest signal (was 10)
  // ── Event specific ─────────────────────────────────────────────────────────
  open_event:       3,   // opened event detail
  join_event:      10,   // joined / RSVP'd an event (was 9)
  // ── Explicit feedback (NEW — direct user ratings) ─────────────────────────
  feedback_excellent:     12,
  feedback_good:           6,
  feedback_neutral:        0,
  feedback_poor:          -8,
  feedback_not_relevant: -12,
  // ── Negative signals ───────────────────────────────────────────────────────
  dislike:        -10,   // explicit dislike (was -8)
  dismiss:         -7,   // swiped away (was -6)
  skip:            -6,   // skipped in feed (was -5)
  not_interested: -12,   // explicit "not for me" — STRONG block signal (was -8)
  remove_save:     -4,   // unsaved a previously saved place (was -3)
  quick_exit:      -5,   // opened detail but left in <3s (NEW)
  // ── Implicit / behavioural ─────────────────────────────────────────────────
  search:           1,   // searched for a term
  filter_use:       1,   // used a filter
  schedule_complete: 10, // completed a scheduled activity
  activity_complete: 10, // completed a daily activity
});

// ─── Place-type resolver ──────────────────────────────────────────────────────

/**
 * Resolves a placeId to a place type so we can update typeAffinity.
 *
 * Strategy (in order):
 *   1. Check live catalogue (getAllPlaces — cached, fast after first call)
 *   2. Fall back to SEED_PLACES id lookup (handles place_1 style ids)
 *   3. Return null if unresolvable (affinity update is skipped gracefully)
 *
 * @param {string} placeId
 * @returns {Promise<{ catalogueId: string|null, type: string|null }>}
 */
const resolvePlaceInfo = async (placeId) => {
  try {
    const places = await getAllPlaces();

    // Direct match on Firestore doc id.
    let match = places.find((p) => p.id === placeId);

    // Fall back to seed id alias (e.g. "place_1" → "Downtown Gym" → live doc).
    if (!match) {
      const seedEntry = SEED_PLACES.find((s) => s.id === placeId);
      if (seedEntry) {
        match = places.find((p) => p.name === seedEntry.name && p.type === seedEntry.type);
      }
    }

    return match
      ? { catalogueId: match.id, type: match.type }
      : { catalogueId: null,     type: null };
  } catch {
    return { catalogueId: null, type: null };
  }
};

// ─── Core service functions ───────────────────────────────────────────────────

/**
 * Persist a new interaction document and update the user's intelligence model.
 *
 * @param {string} userId     - uid from the verified Firebase token
 * @param {string} placeId    - identifier of the place being interacted with
 * @param {string} actionType - one of the keys in ACTION_SCORES
 * @param {object} [metadata] - optional free-form metadata object
 * @returns {Promise<object>} the saved interaction document
 */
export const createInteraction = async (userId, placeId, actionType, metadata = null) => {
  const docRef = db.collection(INTERACTIONS_COLLECTION).doc();

  const stamp = experimentStampForUser(userId);

  const interaction = {
    id: docRef.id,
    userId,
    placeId,
    actionType,
    score:     ACTION_SCORES[actionType],
    metadata:  metadata ?? null,
    createdAt: new Date().toISOString(),
    ...stamp,
  };

  // Persist the interaction first so it's never lost even if intelligence update fails.
  await docRef.set(interaction);

  // Resolve the place type, then update the user's persistent intelligence
  // and session queue concurrently.  Both are side-effects — neither blocks
  // the caller's response and neither can roll back the interaction write.
  const { catalogueId, type } = await resolvePlaceInfo(placeId);
  const effectivePlaceId = catalogueId ?? placeId;

  await Promise.all([
    updateUserIntelligence(userId, type, effectivePlaceId, actionType),
    updateSession(userId, { placeId: effectivePlaceId, type, actionType }),
  ]);

  // Fire-and-forget: real-time AI bandit update on every interaction.
  // The Python AI service updates its in-memory bandit state per call so the
  // very next /predict request sees the new signal — no batch retrain wait.
  sendInteractionFeedback({
    userId,
    placeId:   effectivePlaceId,
    placeType: type,
    actionType,
  }).catch((err) =>
    logger.warn(`[interaction] AI feedback dispatch failed: ${err.message}`),
  );

  // Fire-and-forget: check if a full model retrain is due (sequence + embeddings).
  maybeRetrain().catch((err) =>
    logger.warn(`[interaction] retrainModel check failed: ${err.message}`)
  );

  // ── Phase 15: Cache invalidation ─────────────────────────────────────────────
  // Flush this user's recommendation cache so the very next request sees their
  // new interaction reflected immediately.  The profile data bundle is also
  // invalidated so updated affinity, embedding and session data is re-fetched.
  recommendationCache.deleteByPrefix(`rec:${userId}:`);
  profileDataCache.delete(`pd:${userId}`);
  derivedSignalsCache.deleteByPrefix(`ds:${userId}:`);
  logger.info(`[interaction] caches invalidated for uid=${userId}`);

  return interaction;
};

/**
 * Phase 15: Persist multiple interaction documents in a single Firestore batch write,
 * then apply intelligence + session updates sequentially (same user doc — avoids races).
 *
 * @param {string} userId
 * @param {{ placeId: string, actionType: string, metadata?: object|null }[]} items
 * @returns {Promise<object[]>} saved interaction documents in order
 */
export const createInteractionsBatch = async (userId, items) => {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("items must be a non-empty array");
    err.statusCode = 400;
    throw err;
  }
  if (items.length > 500) {
    const err = new Error("Maximum 500 interactions per batch (Firestore batch limit)");
    err.statusCode = 400;
    throw err;
  }

  const writeBatch = db.batch();
  const results = [];
  const stamp      = experimentStampForUser(userId);

  for (const item of items) {
    const { placeId, actionType, metadata } = item;
    if (!placeId || typeof placeId !== "string") {
      const err = new Error("Each item requires a non-empty placeId string");
      err.statusCode = 400;
      throw err;
    }
    if (!actionType || !ACTION_SCORES[actionType]) {
      const err = new Error(`Invalid actionType "${actionType}" in batch item`);
      err.statusCode = 400;
      throw err;
    }

    const docRef = db.collection(INTERACTIONS_COLLECTION).doc();
    const interaction = {
      id:        docRef.id,
      userId,
      placeId:   placeId.trim(),
      actionType,
      score:     ACTION_SCORES[actionType],
      metadata:  metadata ?? null,
      createdAt: new Date().toISOString(),
      ...stamp,
    };
    writeBatch.set(docRef, interaction);
    results.push(interaction);
  }

  await writeBatch.commit();

  /** Collected for a single batch /feedback dispatch at the end. */
  const aiFeedbackEvents = [];

  for (const interaction of results) {
    const { catalogueId, type } = await resolvePlaceInfo(interaction.placeId);
    const effectivePlaceId = catalogueId ?? interaction.placeId;
    await Promise.all([
      updateUserIntelligence(userId, type, effectivePlaceId, interaction.actionType),
      updateSession(userId, { placeId: effectivePlaceId, type, actionType: interaction.actionType }),
    ]);
    if (type) {
      aiFeedbackEvents.push({
        userId,
        placeId:    effectivePlaceId,
        placeType:  type,
        actionType: interaction.actionType,
      });
    }
  }

  // Fire-and-forget: one batched /feedback call so the bandit learns from
  // the entire batch without N HTTP round-trips.
  if (aiFeedbackEvents.length > 0) {
    sendInteractionFeedbackBatch(aiFeedbackEvents).catch((err) =>
      logger.warn(`[interaction] AI feedback batch dispatch failed: ${err.message}`),
    );
  }

  maybeRetrain().catch((err) =>
    logger.warn(`[interaction] retrainModel check failed: ${err.message}`)
  );

  recommendationCache.deleteByPrefix(`rec:${userId}:`);
  profileDataCache.delete(`pd:${userId}`);
  derivedSignalsCache.deleteByPrefix(`ds:${userId}:`);
  logger.info(`[interaction] batch (${results.length}) caches invalidated for uid=${userId}`);

  return results;
};

/**
 * Fetch the most recent interactions for a given user.
 *
 * @param {string} userId - uid from the verified Firebase token
 * @param {number} [limit=50] - maximum number of records to return
 * @returns {Promise<object[]>} array of interaction documents, newest first
 */
export const getInteractionsByUser = async (userId, limit = 50) => {
  const snapshot = await db
    .collection(INTERACTIONS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => doc.data());
};

/**
 * Phase 17 — aggregate CTR / save / dismiss rates by variant for dev evaluation.
 * Fetches recent `interactions` by `createdAt` (bounded), then filters in memory
 * to `experimentId === EXPERIMENT_ID`. Requires composite index on `createdAt`
 * for range + order; otherwise deploy the index from the Firebase error link.
 *
 * @param {number} [days=7]
 * @param {number} [maxDocs=5000]
 */
export const aggregateExperimentMetrics = async (days = 7, maxDocs = 5000) => {
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const snapshot = await db
    .collection(INTERACTIONS_COLLECTION)
    .where("createdAt", ">=", cutoffIso)
    .orderBy("createdAt", "desc")
    .limit(maxDocs)
    .get();

  const counts = {
    A: { views: 0, clicks: 0, saves: 0, dismisses: 0 },
    B: { views: 0, clicks: 0, saves: 0, dismisses: 0 },
  };

  for (const doc of snapshot.docs) {
    const d = doc.data();
    if (d.experimentId !== EXPERIMENT_ID) continue;
    const v = d.experimentVariant;
    if (v !== "A" && v !== "B") continue;
    const bucket = counts[v];
    switch (d.actionType) {
      case "view":
        bucket.views++;
        break;
      case "click":
        bucket.clicks++;
        break;
      case "save":
        bucket.saves++;
        break;
      case "dismiss":
        bucket.dismisses++;
        break;
      default:
        break;
    }
  }

  const withRates = (bucket) => {
    const views = bucket.views;
    return {
      views,
      clicks:    bucket.clicks,
      saves:     bucket.saves,
      dismisses: bucket.dismisses,
      ctr:         views > 0 ? bucket.clicks / views : 0,
      saveRate:    views > 0 ? bucket.saves / views : 0,
      dismissRate: views > 0 ? bucket.dismisses / views : 0,
    };
  };

  return {
    experimentId: EXPERIMENT_ID,
    days,
    maxDocs,
    scanned: snapshot.size,
    variants: {
      A: withRates(counts.A),
      B: withRates(counts.B),
    },
  };
};
