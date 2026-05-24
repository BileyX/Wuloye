/**
 * services/user.service.js — User profile data layer
 *
 * Responsibility: all Firestore read/write operations for the users collection.
 * Controllers must never touch Firestore directly — every query lives here.
 *
 * Firestore structure:
 *   Collection : users
 *   Document ID: uid  (Firebase Authentication UID)
 *
 *   Fields:
 *     uid                {string}         — Firebase Auth UID
 *     email              {string|null}    — user's email address
 *     name               {string|null}    — display name from the ID token (if set)
 *     createdAt          {string}         — ISO 8601 timestamp of first login
 *     updatedAt          {string}         — ISO 8601 timestamp of last profile change
 *     interests          {string[]}       — activity/interest tags
 *     budgetRange        {string}         — "low" | "medium" | "high"
 *     locationPreference {string}         — "indoor" | "outdoor" | "any"
 *     sleepTime          {string}         — "HH:mm" (24h)
 *     wakeTime           {string}         — "HH:mm" (24h)
 *     weeklyActivities   {string[]}       — e.g. gym, work, study
 *     mealPreferences    {string[]}       — meal style tags
 *     weeklyBudget       {number}         — numeric weekly spend signal
 *     workingHours       {object}         — { morning:{start,end}, afternoon:{start,end}, flexible:bool }
 *     religion           {string}         — "protestant"|"orthodox"|"muslim"|"other"|"prefer_not_to_say"
 *     gender             {string}         — "male"|"female"|"non_binary"|"prefer_not_to_say"|"" (optional; new onboarding v3)
 *     dailyRoutine       {object}         — { morning:{activities[],breakfastType,breakfastOther?}, afternoon:{lunchTime,lunchType,lunchOther?}, evening:{dinnerTime,dinnerType,dinnerOther?} }
 *     weekendPreference  {string}         — "indoor"|"outdoor"|"hiking"|"other"
 *     eventInterests     {string[]}       — e.g. ["tech","religious","social"]
 *     typeAffinity       {object}         — { [placeType]: number } persistent affinity scores (v6)
 *     seenPlaces         {string[]}       — ordered list of place ids the user has engaged with
 *     embedding          {object}         — { [dimension]: float 0-1 } long-term taste vector (v9)
 *     (Phase 13) typeAffinity updates use repeat reinforcement + global scale-down
 *                when the map magnitude grows too large.
 *
 *   v18 — Persistent per-place negative memory (so the AI never forgets a no):
 *     dislikedPlaceIds       {string[]}   — places the user explicitly disliked (hard block)
 *     dismissedPlaceIds      {string[]}   — places the user swiped away (strong penalty)
 *     notInterestedPlaceIds  {string[]}   — places marked "not for me" (hard block, permanent)
 *     savedPlaceIds          {string[]}   — places the user saved (fast retrieval + pinning)
 *
 *   Each is a capped FIFO ring buffer (NEGATIVE_MEMORY_CAP / SAVED_MEMORY_CAP entries).
 *   A complementary positive action (like, save) removes a place from the corresponding
 *   negative set so the user's most recent intent always wins.
 */

import { db } from "../config/firebase.js";
import { normalizeEmbedding } from "../utils/embedding.js";
import { logger } from "../utils/logger.js";

/** Firestore collection name — single source of truth */
const USERS_COLLECTION = "users";

/**
 * Finds an existing user document or creates one on first login.
 *
 * Called every time a verified user hits GET /api/profile.
 * Uses the decoded Firebase ID token as the authoritative source of identity.
 *
 * @param {import("firebase-admin").auth.DecodedIdToken} decodedToken
 *   The verified token payload attached to req.user by auth.middleware.js
 *
 * @returns {Promise<{uid: string, email: string|null, name: string|null, createdAt: string}>}
 *   The persisted user document (existing or freshly created)
 */
export const findOrCreateUser = async (decodedToken) => {
  const { uid, email, name } = decodedToken;

  // Reference to the user's document (keyed by Firebase UID)
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const userSnap = await userRef.get();

  // --- Returning user: document already exists ---
  if (userSnap.exists) {
    return userSnap.data();
  }

  // --- First login: create the user document ---
  const newUser = {
    uid,
    email: email ?? null,
    // name is only present in the token if the user set a display name in Firebase Auth
    name: name ?? null,
    createdAt: new Date().toISOString(),
  };

  // set() creates the document (or overwrites — safe here because we checked existence above)
  await userRef.set(newUser);

  return newUser;
};

/**
 * Retrieves a user document by UID.
 *
 * Useful for admin lookups or future inter-service calls.
 *
 * @param {string} uid
 * @returns {Promise<{uid: string, email: string|null, name: string|null, createdAt: string} | null>}
 *   The user object, or null if no document exists for that UID
 */
export const getUserById = async (uid) => {
  const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();

  if (!userSnap.exists) {
    return null;
  }

  return userSnap.data();
};

/**
 * Retrieves a user document by email address.
 *
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export const getUserByEmail = async (email) => {
  if (!email) return null;
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where("email", "==", email)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
};

/**
 * Checks whether a given username is already taken by another user.
 *
 * @param {string} username   — the candidate username (already lowercased/trimmed by caller)
 * @param {string} [excludeUid]  — UID to exclude from the check (for "is my own username" cases)
 * @returns {Promise<boolean>} true if the username is available
 */
export const isUsernameAvailable = async (username, excludeUid) => {
  if (!username) return false;
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where("username", "==", username)
    .limit(1)
    .get();

  if (snapshot.empty) return true;

  // Available if the only match is the requesting user themselves.
  if (excludeUid && snapshot.docs[0].id === excludeUid) return true;

  return false;
};

/**
 * Updates mutable profile fields for an existing user.
 *
 * Only the keys present in `updates` are written — Firestore's update()
 * performs a partial merge so untouched fields (uid, email, createdAt, etc.)
 * are preserved.
 *
 * Allowed mutable fields:
 *   name               {string}    — display name
 *   interests          {string[]}  — list of activity/interest tags
 *   budgetRange        {string}    — e.g. "low" | "medium" | "high"
 *   locationPreference {string}    — e.g. "indoor" | "outdoor" | "any"
 *   sleepTime          {string}
 *   wakeTime           {string}
 *   weeklyActivities   {string[]}
 *   mealPreferences    {string[]}
 *   weeklyBudget       {number}
 *   workingHours       {object}
 *   religion           {string}
 *   dailyRoutine       {object}
 *   weekendPreference  {string}
 *   eventInterests     {string[]}
 *
 * @param {string} uid     — Firebase Auth UID (from verified token, never from body)
 * @param {object} updates — validated fields to merge
 *
 * @returns {Promise<object>} The full updated user document
 *
 * @throws {Error} if the user document does not exist
 */
export const updateUserProfile = async (uid, updates) => {
  const userRef  = db.collection(USERS_COLLECTION).doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    const err = new Error("User profile not found");
    err.statusCode = 404;
    throw err;
  }

  // Merge only the supplied keys — system fields are never overwritten.
  await userRef.update({ ...updates, updatedAt: new Date().toISOString() });

  const updated = await userRef.get();
  return updated.data();
};

/**
 * Returns a paginated list of all users.
 *
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {string|null} [options.startAfter] - last document UID for cursor pagination
 * @returns {Promise<{ users: object[], total: number, hasMore: boolean }>}
 */
export const getAllUsers = async ({ limit = 50, startAfter = null } = {}) => {
  let query = db.collection(USERS_COLLECTION).orderBy("createdAt", "desc").limit(limit);
  if (startAfter) {
    const cursorDoc = await db.collection(USERS_COLLECTION).doc(startAfter).get();
    if (cursorDoc.exists) {
      query = query.startAfter(cursorDoc);
    }
  }
  const snapshot = await query.get();
  const users = snapshot.docs.map((d) => ({ ...d.data(), uid: d.id }));
  const totalSnap = await db.collection(USERS_COLLECTION).count().get();
  const total = totalSnap.data().count;
  return { users, total, hasMore: users.length === limit };
};

/**
 * Marks a user as suspended or unsuspended.
 *
 * @param {string} uid
 * @param {boolean} suspended
 * @returns {Promise<object>} Updated user document
 */
export const setSuspendedStatus = async (uid, suspended) => {
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  await userRef.update({ suspended: Boolean(suspended), updatedAt: new Date().toISOString() });
  const updated = await userRef.get();
  return updated.data();
};

/**
 * Permanently deletes a user document from Firestore.
 * Does not delete the Firebase Auth account — that requires Admin SDK separately.
 *
 * @param {string} uid
 * @returns {Promise<void>}
 */
export const deleteUserById = async (uid) => {
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  await userRef.delete();
};

// ─── Affinity weights for real-time learning ─────────────────────────────────
// These are distinct from the interaction.service ACTION_SCORES which measure
// individual event value. These weights specifically drive the persistent
// per-type affinity model that lives on the user document.

export const AFFINITY_WEIGHTS = Object.freeze({
  // Passive
  view:             1,
  view_long:        5,
  // Navigation
  click:            2,
  directions:       6,
  call:             4,
  share:            4,
  // Affinity
  like:             4,
  save:             7,
  mark_interested:  3,
  revisit:          9,
  // Events
  open_event:       2,
  join_event:       8,
  // Negative
  dislike:         -7,
  dismiss:         -4,
  skip:            -3,
  not_interested:  -7,
  remove_save:     -2,
  // Behavioural
  search:           0,
  filter_use:       0,
  schedule_complete: 9,
  activity_complete: 9,
});

/** Maximum absolute value stored in typeAffinity for any single type. */
const AFFINITY_CAP = 50;

/** v18 — Persistent per-place memory caps. */
const NEGATIVE_MEMORY_CAP = 500; // dislikedPlaceIds / dismissedPlaceIds / notInterestedPlaceIds
const SAVED_MEMORY_CAP    = 500; // savedPlaceIds (fast retrieval + pinning)

/**
 * Adds an id to the front of a FIFO ring buffer, deduping existing entries and
 * trimming to the supplied cap. Returns the new array (immutable update).
 */
const pushUniqueCapped = (list, id, cap) => {
  if (!id) return Array.isArray(list) ? list : [];
  const arr = Array.isArray(list) ? list : [];
  if (arr[0] === id) return arr;
  return [id, ...arr.filter((x) => x !== id)].slice(0, cap);
};

/** Removes an id from a list (returns same reference when not present). */
const removeFromList = (list, id) => {
  if (!id || !Array.isArray(list) || list.length === 0) return Array.isArray(list) ? list : [];
  if (!list.includes(id)) return list;
  return list.filter((x) => x !== id);
};

/**
 * When the largest |typeAffinity| across all types exceeds this value, the
 * entire map is scaled down proportionally (Phase 13 — prevents slow drift explosion).
 */
const AFFINITY_MAP_RESCALE_THRESHOLD = 45;

// ─── Embedding learning rates (Phase 9) ──────────────────────────────────────
// How much each action type shifts the user's embedding for the interacted type.
// Values are small deltas applied to the [0, 1] embedding space.

export const EMBEDDING_LEARNING_RATES = Object.freeze({
  view:             0.02,
  view_long:        0.08,
  click:            0.06,
  directions:       0.12,
  call:             0.10,
  share:            0.08,
  like:             0.09,
  save:             0.18,
  mark_interested:  0.06,
  revisit:          0.20,
  open_event:       0.04,
  join_event:       0.16,
  dislike:         -0.14,
  dismiss:         -0.10,
  skip:            -0.06,
  not_interested:  -0.14,
  remove_save:     -0.05,
  search:           0.00,
  filter_use:       0.00,
  schedule_complete: 0.18,
  activity_complete: 0.18,
});

/**
 * Scales all typeAffinity entries proportionally when max |v| exceeds threshold.
 *
 * @param {Record<string, number>} map
 * @returns {Record<string, number>}
 */
const rescaleAffinityMapIfNeeded = (map) => {
  let maxAbs = 0;
  for (const v of Object.values(map)) {
    const a = Math.abs(v ?? 0);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs <= AFFINITY_MAP_RESCALE_THRESHOLD || maxAbs === 0) return map;

  const scale = AFFINITY_MAP_RESCALE_THRESHOLD / maxAbs;
  const out   = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = (v ?? 0) * scale;
  }
  return out;
};

/**
 * Updates the user's persistent intelligence after a new interaction.
 *
 * Three things happen in a single atomic Firestore update:
 *   1. typeAffinity is updated with affinity weight + Phase 13 repeat bonus,
 *      per-key cap, and optional global rescale when the map grows too large.
 *   2. The placeId is prepended to seenPlaces (if it isn't already the most
 *      recent entry) and the list is trimmed to the last 200 entries.
 *   3. (Phase 9) embedding[placeType] is shifted by EMBEDDING_LEARNING_RATES
 *      and the whole vector is re-normalized so all values stay in [0, 1].
 *
 * This function is fire-and-forget from the caller's perspective — it does not
 * throw on failure (logs a warning instead) so that interaction logging always
 * succeeds even if the intelligence update has a transient error.
 *
 * @param {string} uid        — Firebase Auth UID
 * @param {string} placeType  — catalogue place type, e.g. "gym"
 * @param {string} placeId    — catalogue place id (Firestore doc id)
 * @param {string} actionType — one of "view" | "click" | "save" | "dismiss"
 */
export const updateUserIntelligence = async (uid, placeType, placeId, actionType) => {
  const affinityWeight   = AFFINITY_WEIGHTS[actionType]        ?? 0;
  const embeddingDelta   = EMBEDDING_LEARNING_RATES[actionType] ?? 0;

  try {
    const userRef  = db.collection(USERS_COLLECTION).doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return;

    const data         = userSnap.data();

    // ── seenPlaces update (always, even for Google place_ids) ────────────────
    const seen        = Array.isArray(data.seenPlaces) ? data.seenPlaces : [];
    const updatedSeen = seen[0] === placeId
      ? seen
      : [placeId, ...seen.filter((id) => id !== placeId)].slice(0, 200);

    // ── v18: Persistent per-place memory sets ────────────────────────────────
    let dislikedIds      = Array.isArray(data.dislikedPlaceIds)      ? data.dislikedPlaceIds      : [];
    let dismissedIds     = Array.isArray(data.dismissedPlaceIds)     ? data.dismissedPlaceIds     : [];
    let notInterestedIds = Array.isArray(data.notInterestedPlaceIds) ? data.notInterestedPlaceIds : [];
    let savedIds         = Array.isArray(data.savedPlaceIds)         ? data.savedPlaceIds         : [];

    switch (actionType) {
      case "dislike":
        dislikedIds = pushUniqueCapped(dislikedIds, placeId, NEGATIVE_MEMORY_CAP);
        savedIds    = removeFromList(savedIds, placeId);
        break;
      case "dismiss":
        dismissedIds = pushUniqueCapped(dismissedIds, placeId, NEGATIVE_MEMORY_CAP);
        savedIds     = removeFromList(savedIds, placeId);
        break;
      case "not_interested":
        notInterestedIds = pushUniqueCapped(notInterestedIds, placeId, NEGATIVE_MEMORY_CAP);
        savedIds     = removeFromList(savedIds, placeId);
        dismissedIds = removeFromList(dismissedIds, placeId);
        dislikedIds  = removeFromList(dislikedIds, placeId);
        break;
      case "save":
        savedIds     = pushUniqueCapped(savedIds, placeId, SAVED_MEMORY_CAP);
        dismissedIds = removeFromList(dismissedIds, placeId);
        dislikedIds  = removeFromList(dislikedIds, placeId);
        break;
      case "remove_save":
        savedIds = removeFromList(savedIds, placeId);
        break;
      case "like":
        dislikedIds  = removeFromList(dislikedIds, placeId);
        dismissedIds = removeFromList(dismissedIds, placeId);
        break;
      default:
        break;
    }

    const updatePayload = {
      seenPlaces:            updatedSeen,
      dislikedPlaceIds:      dislikedIds,
      dismissedPlaceIds:     dismissedIds,
      notInterestedPlaceIds: notInterestedIds,
      savedPlaceIds:         savedIds,
      updatedAt:             new Date().toISOString(),
    };

    // ── typeAffinity + embedding (catalogue / metadata type required) ───────
    if (placeType) {
      const current      = data.typeAffinity ?? {};
      const currentValue = current[placeType] ?? 0;

      const repeatBonus =
        affinityWeight > 0 && currentValue > 0
          ? Math.min(2, affinityWeight * 0.2 + Math.min(1, currentValue / 25))
          : 0;

      const delta        = affinityWeight + repeatBonus;
      let nextMap        = { ...current, [placeType]: currentValue + delta };
      nextMap[placeType] = Math.min(AFFINITY_CAP, Math.max(-AFFINITY_CAP, nextMap[placeType]));
      nextMap = rescaleAffinityMapIfNeeded(nextMap);

      const prevEmbedding  = data.embedding ?? {};
      const prevTypeValue  = prevEmbedding[placeType] ?? 0;
      const nextTypeValue  = Math.min(1, Math.max(0, prevTypeValue + embeddingDelta));
      const rawEmbedding   = { ...prevEmbedding, [placeType]: nextTypeValue };
      const nextEmbedding  = normalizeEmbedding(rawEmbedding);

      Object.assign(updatePayload, {
        typeAffinity: nextMap,
        embedding:    nextEmbedding,
      });

      logger.info(
        `[intelligence] uid=${uid} type=${placeType} action=${actionType}` +
        ` affinity=${currentValue}->${nextMap[placeType]}` +
        ` embed=${prevTypeValue.toFixed(3)}->${nextTypeValue.toFixed(3)}` +
        ` saved=${savedIds.length} disliked=${dislikedIds.length}` +
        ` dismissed=${dismissedIds.length} notInterested=${notInterestedIds.length}`,
      );
    } else {
      logger.info(
        `[intelligence] uid=${uid} action=${actionType} memory-only (no type)` +
        ` saved=${savedIds.length} disliked=${dislikedIds.length}` +
        ` dismissed=${dismissedIds.length}`,
      );
    }

    await userRef.update(updatePayload);
  } catch (err) {
    logger.warn(`[intelligence] Failed to update intelligence for uid=${uid}:`, { error: err.message });
  }
};
