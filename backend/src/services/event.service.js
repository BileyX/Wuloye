/**
 * event.service.js — Firestore data layer for the events collection.
 *
 * Event document structure:
 *   id               {string}   — Firestore document ID
 *   title            {string}   — event name
 *   description      {string}   — full description
 *   location         {string}   — venue / place name
 *   coordinates      {object}   — { lat: number, lng: number }
 *   date             {string}   — ISO 8601 datetime (start)
 *   end_date         {string}   — ISO 8601 datetime (end), optional
 *   category         {string}   — "music"|"tech"|"church"|"fitness"|"business"|"food"|"art"|"sports"|"education"|"social"|"other"
 *   image            {string}   — image URL (may be empty)
 *   source_url       {string}   — link to original event page
 *   booking_url      {string}   — external booking / ticket purchase URL (may equal source_url)
 *   source           {string}   — scraper id (e.g. chapa_events, eventbrite, meetup, telegram_*)
 *   is_paid          {boolean}  — true when tickets cost money
 *   ticket_price     {string}   — human-readable price string (e.g. "ETB 600")
 *   price_tier       {string}   — "cheap"|"affordable"|"expensive"
 *   organizer        {string}   — event organiser name (optional)
 *   is_featured      {boolean}  — flagged as featured by the source platform
 *   chapa_ref_id     {string}   — Chapa Events internal ref (e.g. "EV-H1H4rtRzOzJ9")
 *   registration_urls {string[]} — optional ticket/register links extracted from text
 *   legacy_hash      {string}   — optional; backward-compatible fingerprint
 *   created_at       {string}   — ISO 8601 of first insert into Firestore
 */

import { db } from "../config/firebase.js";
import { logger } from "../utils/logger.js";
import { sortEventsByTrustAndDate } from "../utils/eventSourcePriority.js";

export const EVENTS_COLLECTION = "events";

export const VALID_CATEGORIES = Object.freeze([
  "music", "tech", "church", "fitness", "business",
  "food", "art", "sports", "education", "social", "other",
]);

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** ISO timestamp for N days ago. */
const daysAgoIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

/**
 * True when an event should be considered "expired" or "stale" and excluded
 * from public feeds.
 *
 * Rules:
 *   - Has a parseable date that is more than 1 day in the past → expired.
 *   - No date AND was created more than 21 days ago → stale.
 */
const isStaleEvent = (ev) => {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 1);

  if (ev.date) {
    try {
      const dt = new Date(ev.date);
      if (!isNaN(dt) && dt < cutoff) return true;
    } catch {
      /* ignore */
    }
  }

  // No date: reject if created_at is older than 21 days
  const createdAt = ev.created_at || ev.scraped_at;
  if (!ev.date && createdAt) {
    const staleCutoff = new Date(now);
    staleCutoff.setDate(staleCutoff.getDate() - 21);
    try {
      if (new Date(createdAt) < staleCutoff) return true;
    } catch {
      /* ignore */
    }
  }

  return false;
};

// ─── In-process caches ────────────────────────────────────────────────────────

let _cache = null;
let _cacheTime = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Always fetch this many rows for the unfiltered cache so limit=15 doesn't poison it. */
const CACHE_POOL_SIZE = 200;

// Separate shorter-lived cache for candidate list (used by AI ranker)
let _candidatesCache = null;
let _candidatesCacheTime = null;
const CANDIDATES_TTL_MS = 5 * 60 * 1000; // 5 minutes

const isCacheValid = () =>
  Array.isArray(_cache) &&
  _cache.length > 0 &&
  _cacheTime !== null &&
  Date.now() - _cacheTime < CACHE_TTL_MS;

const isCandidatesCacheValid = () =>
  Array.isArray(_candidatesCache) &&
  _candidatesCache.length > 0 &&
  _candidatesCacheTime !== null &&
  Date.now() - _candidatesCacheTime < CANDIDATES_TTL_MS;

const setCache = (events) => {
  _cache = events;
  _cacheTime = Date.now();
};

const setCandidatesCache = (events) => {
  _candidatesCache = events;
  _candidatesCacheTime = Date.now();
};

export const invalidateEventsCache = () => {
  _cache = null;
  _cacheTime = null;
  _candidatesCache = null;
  _candidatesCacheTime = null;
  logger.info("[events] Cache invalidated");
};

/** Call after scrape completes so Chapa / new sources appear immediately. */
export const warmEventsCache = async () => {
  invalidateEventsCache();
  try {
    await getAllEvents({ limit: CACHE_POOL_SIZE, noCache: true });
    logger.info("[events] Cache warmed after scrape");
  } catch (err) {
    logger.warn(`[events] Cache warm failed: ${err.message}`);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const docToEvent = (doc) => ({ id: doc.id, ...doc.data() });

/** True when Firestore rejected the query because an index is missing. */
const isFirestoreIndexError = (err) => {
  const msg = String(err?.message ?? "");
  const code = err?.code;
  return (
    code === 9 ||
    code === "failed-precondition" ||
    /FAILED_PRECONDITION|requires an index/i.test(msg)
  );
};

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Get all events, optionally filtered by category, date range, or location.
 *
 * @param {object} filters
 * @param {string}  [filters.category]   — filter by category
 * @param {string}  [filters.dateFrom]   — ISO date lower bound
 * @param {string}  [filters.dateTo]     — ISO date upper bound
 * @param {string}  [filters.location]   — partial location string match
 * @param {number}  [filters.limit=50]   — max results
 * @returns {Promise<object[]>}
 */
export const getAllEvents = async (filters = {}) => {
  const { category, dateFrom, dateTo, location, limit = 50 } = filters;
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);

  // Use cache when no filters applied
  if (!category && !dateFrom && !dateTo && !location && !filters.noCache) {
    if (isCacheValid()) {
      logger.debug(`[events] Cache hit — ${_cache.length} events`);
      return sortEventsByTrustAndDate(_cache).slice(0, cappedLimit);
    }
  }

  /**
   * Firestore: combining `where("category","==", …)` with `orderBy("date")`
   * requires a composite index (FAILED_PRECONDITION). To avoid deploying
   * indexes for every filter combo, equality on `category` is done alone,
   * then we sort and date-filter in memory.
   */
  if (category && VALID_CATEGORIES.includes(category)) {
    const maxFetch = Math.min(Math.max(cappedLimit * 25, 500), 8000);

    let events;
    try {
      const snap = await db
        .collection(EVENTS_COLLECTION)
        .where("category", "==", category)
        .limit(maxFetch)
        .get();
      events = snap.docs.map(docToEvent);
    } catch (err) {
      // Old servers / duplicate backends may still run compound queries, or indexes may be enforced oddly.
      if (!isFirestoreIndexError(err)) throw err;
      logger.warn(`[events] category query fallback after index error — ${String(err.message).slice(0, 140)}`);
      const snapFb = await db
        .collection(EVENTS_COLLECTION)
        .orderBy("date", "desc")
        .limit(15000)
        .get();
      events = snapFb.docs
        .map(docToEvent)
        .filter((e) => String(e.category ?? "other").toLowerCase() === category);
    }

    // Remove expired/stale events
    events = events.filter((e) => !isStaleEvent(e));

    if (dateFrom) {
      events = events.filter((e) => !e.date || String(e.date) >= dateFrom);
    }
    if (dateTo) {
      events = events.filter((e) => !e.date || String(e.date) <= dateTo);
    }

    // Sort: future-dated events first, then by created_at
    events.sort((a, b) => {
      const aDate = a.date || a.created_at || "";
      const bDate = b.date || b.created_at || "";
      return aDate.localeCompare(bDate);
    });

    if (location) {
      const loc = location.toLowerCase();
      events = events.filter((e) =>
        (e.location || "").toLowerCase().includes(loc)
      );
    }

    return sortEventsByTrustAndDate(events.slice(0, cappedLimit));
  }

  const staleCutoffIso = daysAgoIso(21);
  const fetchLimit = Math.min(Math.max(cappedLimit, CACHE_POOL_SIZE), 500);
  let query = db
    .collection(EVENTS_COLLECTION)
    .where("created_at", ">=", staleCutoffIso)
    .orderBy("created_at", "desc");

  const snap = await query.limit(fetchLimit).get();
  let events = snap.docs.map(docToEvent).filter((e) => !isStaleEvent(e));

  if (dateFrom) {
    events = events.filter((e) => !e.date || String(e.date) >= dateFrom);
  }
  if (dateTo) {
    events = events.filter((e) => !e.date || String(e.date) <= dateTo);
  }

  // Client-side location filter (Firestore doesn't support substring)
  if (location) {
    const loc = location.toLowerCase();
    events = events.filter((e) =>
      (e.location || "").toLowerCase().includes(loc)
    );
  }

  // Sort by soonest date first, falling back to created_at
  events.sort((a, b) => {
    const aDate = a.date || a.created_at || "";
    const bDate = b.date || b.created_at || "";
    return aDate.localeCompare(bDate);
  });

  // Update full cache when no filters — store the full sorted pool, not just the slice.
  if (!category && !dateFrom && !dateTo && !location) {
    setCache(sortEventsByTrustAndDate(events));
  }

  return sortEventsByTrustAndDate(events).slice(0, cappedLimit);
};

/**
 * Get a single event by Firestore document ID.
 *
 * @param {string} eventId
 * @returns {Promise<object|null>}
 */
export const getEventById = async (eventId) => {
  const snap = await db.collection(EVENTS_COLLECTION).doc(eventId).get();
  if (!snap.exists) return null;
  return docToEvent(snap);
};

/**
 * Get upcoming events (date >= now), sorted soonest-first.
 *
 * If nothing matches "upcoming" (empty DB, unparsed past dates, or clock skew),
 * falls back to the most recently scraped rows so Discover → Events is not blank
 * while data exists.
 *
 * @param {number} [limit=20]
 * @returns {Promise<object[]>}
 */
export const getUpcomingEvents = async (limit = 20) => {
  const now = new Date();
  const nowIso = now.toISOString();

  // Staleness cutoff: events created more than 21 days ago that have no upcoming
  // date are considered stale and excluded from the fallback list.
  const staleCutoff = new Date(now);
  staleCutoff.setDate(staleCutoff.getDate() - 21);
  const staleCutoffIso = staleCutoff.toISOString();

  // Run both queries in parallel; future-dated events take priority.
  const [futureSnap, recentSnap] = await Promise.all([
    db
      .collection(EVENTS_COLLECTION)
      .where("date", ">=", nowIso)
      .orderBy("date", "asc")
      .limit(limit * 2)   // fetch more so we can sort/trim
      .get()
      .catch(() => null),
    db
      .collection(EVENTS_COLLECTION)
      .where("created_at", ">=", staleCutoffIso)
      .orderBy("created_at", "desc")
      .limit(limit * 2)
      .get()
      .catch(() => null),
  ]);

  // Build a combined set deduped by ID; future events first.
  const seen = new Set();
  const combined = [];

  if (futureSnap && !futureSnap.empty) {
    futureSnap.docs.forEach((doc) => {
      seen.add(doc.id);
      combined.push(docToEvent(doc));
    });
  }

  if (recentSnap && !recentSnap.empty) {
    recentSnap.docs.forEach((doc) => {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        combined.push(docToEvent(doc));
      }
    });
  }

  if (combined.length === 0) {
    logger.warn("[events] getUpcomingEvents: no upcoming or recent events found");
    return [];
  }

  if (futureSnap && !futureSnap.empty) {
    logger.debug(`[events] Returning ${combined.length} events (${futureSnap.size} future + ${combined.length - futureSnap.size} recent)`);
  } else {
    logger.debug(`[events] No future dates — returning ${combined.length} recent events by created_at (cutoff: ${staleCutoffIso.slice(0, 10)})`);
  }

  return sortEventsByTrustAndDate(combined.slice(0, limit));
};

/**
 * Get events for AI ranking — returns a cached candidate list.
 * Used by the recommendation endpoint; bypasses the heavier getAllEvents
 * filtering chain with its own fast 5-minute cache.
 *
 * @param {number} [limit=80]
 * @returns {Promise<object[]>}
 */
export const getEventCandidates = async (limit = 80) => {
  if (isCandidatesCacheValid()) {
    logger.debug(`[events] Candidates cache hit — ${_candidatesCache.length} events`);
    return _candidatesCache.slice(0, limit);
  }

  // If the full events cache is warm, reuse it (avoids duplicate Firestore call).
  if (isCacheValid() && _cache.length > 0) {
    const slice = _cache.slice(0, limit);
    setCandidatesCache(slice);
    return slice;
  }

  const events = await getUpcomingEvents(limit);
  if (events.length > 0) {
    setCandidatesCache(events);
  }
  return events;
};

// ─── Write helpers (admin use) ────────────────────────────────────────────────

/**
 * Update a single event document (admin edit).
 *
 * @param {string} eventId
 * @param {object} updates — partial event fields
 * @returns {Promise<void>}
 */
export const updateEvent = async (eventId, updates) => {
  const ref = db.collection(EVENTS_COLLECTION).doc(eventId);
  await ref.update({ ...updates, updatedAt: new Date().toISOString() });
  invalidateEventsCache();
};

/**
 * Delete a single event document (admin use).
 *
 * @param {string} eventId
 * @returns {Promise<void>}
 */
export const deleteEvent = async (eventId) => {
  await db.collection(EVENTS_COLLECTION).doc(eventId).delete();
  invalidateEventsCache();
};

/**
 * Toggle the `featured` flag on an event (admin use).
 *
 * @param {string} eventId
 * @param {boolean} featured
 * @returns {Promise<void>}
 */
export const setEventFeatured = async (eventId, featured) => {
  await updateEvent(eventId, { featured: Boolean(featured) });
};

/**
 * Count total events in Firestore.
 *
 * @returns {Promise<number>}
 */
export const countEvents = async () => {
  try {
    const agg = await db.collection(EVENTS_COLLECTION).count().get();
    return agg.data().count ?? 0;
  } catch {
    const snap = await db.collection(EVENTS_COLLECTION).limit(10_001).get();
    return snap.size;
  }
};
