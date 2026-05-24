/**
 * place.service.js — Firestore data layer for the places collection.
 *
 * Responsibilities:
 *   1. Provide CRUD-style read helpers for the "places" Firestore collection.
 *   2. Maintain a lightweight in-process cache so recommendation requests do
 *      not hit Firestore on every call.
 *   3. Expose seedPlacesIfEmpty() used by the dev seed endpoint.
 *
 * Phase 14 addition:
 *   getAllPlaces() now accepts an optional userLocation argument.  When a
 *   location is provided AND GOOGLE_MAPS_API_KEY is set, real nearby places
 *   from the Google Maps Places API are returned instead of the static
 *   Firestore catalogue.  If Google returns 0 results or the key is absent,
 *   the function transparently falls back to Firestore data.
 *
 * Place document structure:
 *   id              {string}   — Firestore document ID (stored inside doc)
 *   name            {string}   — display name
 *   type            {string}   — "gym" | "coffee" | "restaurant" | "park" |
 *                                "yoga" | "social" | "walk" | "study" | "outdoor"
 *   location        {object}   — { lat, lng, city }
 *   priceRange      {string}   — "free" | "low" | "medium" | "high"
 *   tags            {string[]} — descriptive tags, e.g. ["quiet", "wifi"]
 *   rating          {number}   — 1–5
 *   popularityScore {number}   — static baseline score for cold-start ranking
 *   isIndoor        {boolean}
 *   createdAt       {string}   — ISO 8601 timestamp
 *   // Phase 14 additions (Google Places only):
 *   isOpen          {boolean|null} — opening_hours.open_now
 *   trendScore      {number}       — 0–1 trending signal (high rating × volume)
 *   userRatingsTotal {number}      — raw Google review count
 *   source          {string}       — "google_maps" | undefined
 *
 * Validation constants (shared with the seed script and controller):
 *   VALID_TYPES      — allowed type values
 *   VALID_PRICE_RANGES — allowed priceRange values
 */

import { db }              from "../config/firebase.js";
import { getNearbyPlaces } from "./googlePlaces.service.js";
import { logger }          from "../utils/logger.js";

export const PLACES_COLLECTION = "places";

// ─── Validation constants ─────────────────────────────────────────────────────

export const VALID_TYPES = Object.freeze([
  "gym", "coffee", "restaurant", "park",
  "yoga", "social", "walk", "study", "outdoor",
  "hotel", "church", "sports",
]);

export const VALID_PRICE_RANGES = Object.freeze(["free", "low", "medium", "high"]);

// ─── In-process cache ─────────────────────────────────────────────────────────
// Stores the full places array so repeated calls within a running server process
// skip the Firestore round-trip. Invalidated when seeding occurs.

let _cache = null;     // null means "not yet loaded"
let _cacheTime = null; // timestamp of last load (ms)
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns true when the cache holds a fresh, non-empty result.
 */
const isCacheValid = () =>
  Array.isArray(_cache) &&
  _cache.length > 0 &&
  _cacheTime !== null &&
  Date.now() - _cacheTime < CACHE_TTL_MS;

/**
 * Stores a new result in the cache and stamps the load time.
 */
const setCache = (places) => {
  _cache     = places;
  _cacheTime = Date.now();
  logger.info(`[places] Cache updated — ${places.length} place(s) stored`);
};

/**
 * Clears the in-process cache (called after seeding so the next request
 * picks up the freshly written data from Firestore).
 */
export const invalidateCache = () => {
  _cache     = null;
  _cacheTime = null;
  logger.info("[places] Cache invalidated");
};

// ─── Core read helpers ────────────────────────────────────────────────────────

/**
 * Returns all places, preferring real Google Maps data when available.
 *
 * Phase 14 behaviour:
 *   - When `userLocation` is provided AND `GOOGLE_MAPS_API_KEY` is set, the
 *     function calls the Google Maps Places API (via googlePlaces.service.js)
 *     and returns the live nearby results.
 *   - If Google returns 0 results, the key is absent, or any error occurs,
 *     the function falls back to the Firestore catalogue transparently.
 *   - When `userLocation` is omitted (all existing callers), the original
 *     Firestore path is used unchanged.
 *
 * @param {{ lat: number, lng: number }|null} [userLocation=null]
 *   User's current coordinates.  Pass null (or omit) to use Firestore.
 * @param {number} [radiusMeters=5000]
 *   Search radius passed to the Google Places Nearby Search API.
 * @returns {Promise<object[]>} Array of place documents (may be empty)
 */
export const getAllPlaces = async (userLocation = null, radiusMeters = 5000) => {
  // ── Phase 14: Google Maps live data path ─────────────────────────────────────
  if (userLocation?.lat != null && process.env.GOOGLE_MAPS_API_KEY) {
    const googlePlaces = await getNearbyPlaces(userLocation, radiusMeters);
    if (googlePlaces.length > 0) {
      logger.info(`[places] Using ${googlePlaces.length} Google Maps place(s)`);
      return googlePlaces;
    }
    logger.info("[places] Google returned 0 results — falling back to Firestore");
  }

  // ── Firestore path (original behaviour) ──────────────────────────────────────
  if (isCacheValid()) {
    logger.debug(`[places] Cache hit — returning ${_cache.length} place(s)`);
    return _cache;
  }

  logger.info("[places] Cache miss — loading from Firestore");
  const snap = await db.collection(PLACES_COLLECTION).get();
  // Use snapshot document ID so place.id always matches Firestore doc id (e.g. place_1).
  const places = snap.docs.map((d) => ({ ...d.data(), id: d.id }));

  setCache(places);
  return places;
};

/**
 * Returns a single place by its Firestore document ID.
 * Always reads from Firestore (bypasses cache) so callers get fresh data.
 *
 * @param {string} placeId
 * @returns {Promise<object|null>} Place document or null if not found
 */
export const getPlaceById = async (placeId) => {
  const snap = await db.collection(PLACES_COLLECTION).doc(placeId).get();
  if (!snap.exists) return null;
  return { ...snap.data(), id: snap.id };
};

/**
 * Resolves many place IDs in one pass — catalogue cache first, then a single
 * Firestore batch read for any IDs missing from the in-process cache.
 *
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>} id → place document
 */
export const getPlacesByIds = async (ids) => {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  const result = new Map();
  if (unique.length === 0) return result;

  const all = await getAllPlaces();
  const catalogueById = new Map(all.map((p) => [p.id, p]));

  const missing = [];
  for (const id of unique) {
    const hit = catalogueById.get(id);
    if (hit) result.set(id, hit);
    else missing.push(id);
  }

  if (missing.length === 0) return result;

  const refs = missing.map((id) => db.collection(PLACES_COLLECTION).doc(id));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    if (snap.exists) {
      result.set(snap.id, { ...snap.data(), id: snap.id });
    }
  }
  return result;
};

/**
 * Returns all places of a given type, using the cache when available.
 *
 * @param {string} type — must be one of VALID_TYPES
 * @returns {Promise<object[]>}
 */
export const getPlacesByType = async (type) => {
  // Leverage the cached full list to avoid an extra Firestore query.
  const all = await getAllPlaces();
  return all.filter((p) => p.type === type);
};

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

/**
 * Creates a new place document in Firestore.
 *
 * @param {object} data - place fields (name, type, priceRange, location, tags, etc.)
 * @returns {Promise<object>} The created place document with its generated id.
 */
export const createPlace = async (data) => {
  validatePlace(data);
  const docRef = db.collection(PLACES_COLLECTION).doc();
  const now = new Date().toISOString();
  const doc = { ...data, id: docRef.id, createdAt: now, updatedAt: now };
  await docRef.set(doc);
  invalidateCache();
  return doc;
};

/**
 * Updates mutable fields of an existing place document.
 *
 * @param {string} placeId
 * @param {object} updates
 * @returns {Promise<object>} The updated place document.
 */
export const updatePlace = async (placeId, updates) => {
  const docRef = db.collection(PLACES_COLLECTION).doc(placeId);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err = new Error("Place not found");
    err.statusCode = 404;
    throw err;
  }
  const now = new Date().toISOString();
  const safeUpdates = { ...updates, updatedAt: now };
  delete safeUpdates.id;
  delete safeUpdates.createdAt;
  await docRef.update(safeUpdates);
  invalidateCache();
  const updated = await docRef.get();
  return { ...updated.data(), id: docRef.id };
};

/**
 * Deletes a place document by ID.
 *
 * @param {string} placeId
 * @returns {Promise<void>}
 */
export const deletePlaceById = async (placeId) => {
  const docRef = db.collection(PLACES_COLLECTION).doc(placeId);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err = new Error("Place not found");
    err.statusCode = 404;
    throw err;
  }
  await docRef.delete();
  invalidateCache();
};

// ─── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Validates a place object against the expected schema.
 * Throws a descriptive error for any invalid field.
 *
 * @param {object} place — candidate place object from the seed data
 */
const validatePlace = (place) => {
  if (!place.name || typeof place.name !== "string") {
    throw new Error(`[seed] Invalid place name: ${JSON.stringify(place.name)}`);
  }
  if (!VALID_TYPES.includes(place.type)) {
    throw new Error(`[seed] Invalid type "${place.type}" for "${place.name}". Allowed: ${VALID_TYPES.join(", ")}`);
  }
  if (!VALID_PRICE_RANGES.includes(place.priceRange)) {
    throw new Error(`[seed] Invalid priceRange "${place.priceRange}" for "${place.name}". Allowed: ${VALID_PRICE_RANGES.join(", ")}`);
  }
  if (typeof place.rating !== "number" || place.rating < 1 || place.rating > 5) {
    throw new Error(`[seed] Rating must be 1–5 for "${place.name}", got: ${place.rating}`);
  }
  if (typeof place.isIndoor !== "boolean") {
    throw new Error(`[seed] isIndoor must be boolean for "${place.name}"`);
  }
};

/**
 * Seeds the places collection if it is empty.
 *
 * Behaviour:
 *   - If >= 1 document already exists, returns immediately (idempotent).
 *   - Otherwise validates every seed item, writes them in a batched write,
 *     invalidates the cache, and logs the result.
 *
 * @param {object[]} seedData — array of place objects to seed
 * @returns {Promise<{ inserted: number, skipped: boolean }>}
 */
export const seedPlacesIfEmpty = async (seedData) => {
  const existingSnap = await db.collection(PLACES_COLLECTION).limit(1).get();

  if (!existingSnap.empty) {
    const total = (await db.collection(PLACES_COLLECTION).get()).size;
    logger.info(`[places] Seed skipped — collection already has ${total} document(s)`);
    return { inserted: 0, skipped: true, existing: total };
  }

  logger.info(`[places] Seeding ${seedData.length} places...`);

  // Validate all places before writing anything.
  for (const place of seedData) {
    validatePlace(place);
  }

  // Firestore batched writes are capped at 500 ops; our seed is well under that.
  const batch     = db.batch();
  const now       = new Date().toISOString();
  const inserted  = [];

  for (const place of seedData) {
    // Use explicit id from seed when provided (e.g. place_1, place_2) so interactions resolve.
    const docRef = place.id
      ? db.collection(PLACES_COLLECTION).doc(place.id)
      : db.collection(PLACES_COLLECTION).doc();
    const id = docRef.id;
    const { id: _omit, ...rest } = place;
    const doc = { ...rest, id, createdAt: now };
    batch.set(docRef, doc);
    inserted.push(doc);
  }

  await batch.commit();
  invalidateCache();

  logger.info(`[places] Seeded ${inserted.length} places successfully`);
  return { inserted: inserted.length, skipped: false };
};
