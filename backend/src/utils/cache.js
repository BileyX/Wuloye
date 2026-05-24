/**
 * cache.js — Phase 15: Generic in-memory TTL cache.
 *
 * Provides a lightweight fixed-capacity store with per-entry time-to-live
 * expiry and LRU-style eviction (oldest entry removed first) when the store
 * is at capacity.  No external dependencies — backed by a plain Map.
 *
 * Exported cache instances used across the application:
 *
 *   recommendationCache
 *     Stores fully-computed recommendation results per user + location key.
 *     TTL: configurable via RECOMMENDATION_CACHE_TTL_MS (default 5 min).
 *     Invalidated immediately on every new interaction.
 *
 *   profileDataCache
 *     Stores the bundle of Firestore reads that getRecommendations fetches on
 *     every request: { profile, routines, interactions, session }.
 *     TTL: 30 seconds.  Lets users who hit /recommendations in quick succession
 *     skip 4 Firestore round-trips without serving meaningfully stale data.
 *     Also invalidated on every new interaction.
 *
 *   derivedSignalsCache
 *     Precomputed affinity maps, interaction index, strong-signal sets (Phase 15).
 *     TTL: 60 s.  For Redis in production, replace the backing store or sync
 *     invalidation across instances when using this in-memory layer only.
 */

// ─── TtlCache ─────────────────────────────────────────────────────────────────

export class TtlCache {
  /**
   * @param {number} [defaultTtlMs=60_000] — default TTL in milliseconds
   * @param {number} [maxSize=500]         — max entries before LRU eviction
   */
  constructor(defaultTtlMs = 60_000, maxSize = 500) {
    this._store        = new Map();
    this._defaultTtlMs = defaultTtlMs;
    this._maxSize      = maxSize;
  }

  /**
   * Stores a value under `key`.
   *
   * @param {string} key
   * @param {*}      value
   * @param {number} [ttlMs] — overrides the instance default when supplied
   */
  set(key, value, ttlMs) {
    // Evict the oldest entry (insertion order) when at capacity and key is new.
    if (this._store.size >= this._maxSize && !this._store.has(key)) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
    }
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._defaultTtlMs),
    });
  }

  /**
   * Returns the cached value or null when the entry is absent or expired.
   *
   * @param {string} key
   * @returns {*|null}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Removes a single entry (no-op if key does not exist). */
  delete(key) {
    this._store.delete(key);
  }

  /**
   * Removes all entries whose key begins with `prefix`.
   * Used to evict every cached result for a specific user at once.
   *
   * @param {string} prefix
   */
  deleteByPrefix(prefix) {
    for (const k of this._store.keys()) {
      if (k.startsWith(prefix)) this._store.delete(k);
    }
  }

  /** Current number of (possibly-stale) entries. */
  get size() {
    return this._store.size;
  }

  /** Removes every entry. */
  flush() {
    this._store.clear();
  }
}

// ─── Shared cache instances ───────────────────────────────────────────────────

/**
 * Per-user recommendation result cache.
 * Key format: `rec:<userId>:<mode>:<locationKey>`
 *   mode        — "full" or "fast" (fast = fallback mode, lower-quality scores)
 *   locationKey — "static" when no user location, "geo_<lat>_<lng>_<radius>km" otherwise
 * Default TTL: 5 minutes (override per-set from recommendation.service).
 * Max: 200 entries (one per recent user × location × mode combo).
 */
export const recommendationCache = new TtlCache(5 * 60 * 1000, 200);

/**
 * Per-user Firestore data bundle: { profile, routines, interactions, session }.
 * Key format: `pd:<userId>`
 * TTL: 30 seconds — fresh enough to reflect recent actions, short enough that
 *      the engine never shows data more than 30 s stale for a user at rest.
 * Invalidated immediately when a new interaction is created for the user.
 * Max: 500 entries.
 */
export const profileDataCache = new TtlCache(30 * 1000, 500);

/**
 * Precomputed maps: type affinity, interaction index, strong-signal sets, seen counts.
 * Key format: `ds:<userId>:<locationKey>:<interactionFingerprint>:<nowMinuteBucket>`
 * TTL: 60 s.  Max: 2000 entries.
 */
export const derivedSignalsCache = new TtlCache(60 * 1000, 2000);

/**
 * Evict every cached recommendation artefact for one user.
 * Keys use the `rec:v2:` prefix (see recommendation.service.js).
 *
 * @param {string} userId
 */
export function invalidateUserRecommendationCaches(userId) {
  recommendationCache.deleteByPrefix(`rec:v2:${userId}:`);
  profileDataCache.delete(`pd:${userId}`);
  derivedSignalsCache.deleteByPrefix(`ds:${userId}:`);
}

/**
 * Per-user saved-places list cache.
 * Key format: `sp:<userId>`
 * TTL: 3 minutes — invalidated immediately on save / remove_save.
 * Max: 500 entries.
 */
export const savedPlacesCache = new TtlCache(3 * 60 * 1000, 500);

/** @param {string} userId */
export function invalidateSavedPlacesCache(userId) {
  savedPlacesCache.delete(`sp:${userId}`);
}
