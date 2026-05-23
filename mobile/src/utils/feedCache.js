/**
 * feedCache.js — In-memory TTL cache for recommendation feed responses.
 *
 * Used by Discover, Home, and Nearby flows to show stale data instantly while
 * refreshing in the background (stale-while-revalidate).
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 48;

/** @type {Map<string, { places: object[], aiMeta: object|null, expiresAt: number }>} */
const store = new Map();

function pruneIfNeeded() {
    if (store.size <= MAX_ENTRIES) return;
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
}

/**
 * @param {string} key
 * @returns {{ places: object[], aiMeta: object|null }|null}
 */
export function getFeedCache(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
    }
    return { places: entry.places, aiMeta: entry.aiMeta };
}

/**
 * @param {string} key
 * @param {object[]} places
 * @param {object|null} [aiMeta]
 * @param {number} [ttlMs]
 */
export function setFeedCache(key, places, aiMeta = null, ttlMs = DEFAULT_TTL_MS) {
    pruneIfNeeded();
    store.set(key, {
        places,
        aiMeta: aiMeta ?? null,
        expiresAt: Date.now() + ttlMs,
    });
}

/** @param {string} [prefix] */
export function clearFeedCache(prefix) {
    if (!prefix) {
        store.clear();
        return;
    }
    for (const k of store.keys()) {
        if (k.startsWith(prefix)) store.delete(k);
    }
}

/** @param {string} key */
export function deleteFeedCache(key) {
    store.delete(key);
}

/**
 * Build a stable cache key from feed parameters.
 * @param {object} opts
 * @param {string} opts.scope — "home" | "discover" | "nearby"
 * @param {string} [opts.filter]
 * @param {number|null} [opts.lat]
 * @param {number|null} [opts.lng]
 * @param {string|null} [opts.religion]
 */
export function buildFeedCacheKey({ scope, filter = "all", lat = null, lng = null, religion = null }) {
    const latKey = typeof lat === "number" ? Math.round(lat * 100) / 100 : "na";
    const lngKey = typeof lng === "number" ? Math.round(lng * 100) / 100 : "na";
    const rel = religion && religion !== "other" ? religion : "any";
    return `v2:${scope}:${filter}:${latKey}:${lngKey}:${rel}`;
}
