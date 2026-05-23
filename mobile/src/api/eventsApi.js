import apiClient from "./client";

// ─── Events-list cache (short TTL, avoids duplicate in-flight requests) ────────

const EVENTS_LIST_TTL_MS = 3 * 60 * 1000; // 3 minutes
const _eventsListCacheMap = new Map(); // key → { t, data }

const eventsListCacheGet = (key) => {
    const entry = _eventsListCacheMap.get(key);
    if (!entry) return null;
    if (Date.now() - entry.t > EVENTS_LIST_TTL_MS) {
        _eventsListCacheMap.delete(key);
        return null;
    }
    return entry.data;
};
const eventsListCacheSet = (key, data) => {
    _eventsListCacheMap.set(key, { t: Date.now(), data });
};
export const invalidateEventsListCache = () => {
    _eventsListCacheMap.clear();
};

// ─── Recommended-events cache ──────────────────────────────────────────────────

const RECO_LIST_TTL_MS = 3 * 60 * 1000;
let _recoListCache = null; // { t, data }

const recoListCacheGet = () => {
    if (!_recoListCache) return null;
    if (Date.now() - _recoListCache.t > RECO_LIST_TTL_MS) {
        _recoListCache = null;
        return null;
    }
    return _recoListCache.data;
};
const recoListCacheSet = (data) => {
    _recoListCache = { t: Date.now(), data };
};
export const invalidateRecoListCache = () => {
    _recoListCache = null;
};

// ─── Dedup in-flight recommended request ──────────────────────────────────────
let _recoInflight = null;

// ─── Single-event cache (repeat opens + deduped in-flight fetches) ─────────────

const EVENT_CACHE_TTL_MS = 5 * 60 * 1000;
const eventCache = new Map(); // id → { t, payload }
const eventInFlight = new Map();

function eventCacheGet(id) {
    const key = String(id);
    const entry = eventCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.t > EVENT_CACHE_TTL_MS) {
        eventCache.delete(key);
        return null;
    }
    return entry.payload;
}

function eventCacheSet(id, payload) {
    if (!payload || typeof payload !== "object") return;
    eventCache.set(String(id), { t: Date.now(), payload });
}

/**
 * Fire-and-forget: warms cache before navigation completes.
 * @param {string} [eventId]
 */
export function prefetchEventById(eventId) {
    if (!eventId) return;
    getEventById(String(eventId), { bypassCache: false }).catch(() => null);
}

/**
 * Fetch all events with optional filters and location for proximity sorting.
 *
 * @param {object} params
 * @param {string} [params.category]  — filter by category
 * @param {string} [params.dateFrom]  — ISO date lower bound
 * @param {string} [params.dateTo]    — ISO date upper bound
 * @param {string} [params.location]  — partial location match
 * @param {number} [params.limit]     — max results (default 50)
 * @param {number} [params.lat]       — user latitude for proximity sort
 * @param {number} [params.lng]       — user longitude for proximity sort
 */
export async function getEvents(params = {}) {
    const listCacheKey =
        !params.category && !params.dateFrom && !params.dateTo && !params.location
            ? `limit=${params.limit || 50}`
            : null;
    if (params.refresh) invalidateEventsListCache();
    const isCacheable = listCacheKey && !params.refresh;
    if (isCacheable) {
        const cached = eventsListCacheGet(listCacheKey);
        if (cached) return cached;
    }
    const { refresh, ...apiParams } = params;
    const query = {
        ...apiParams,
        ...(refresh ? { refresh: "1" } : {}),
    };
    const { data } = await apiClient.get("/events", { params: query, timeout: 12_000 });
    if (listCacheKey && data?.events?.length) eventsListCacheSet(listCacheKey, data);
    return data;
}

/**
 * Fetch AI-personalised events for the current authenticated user.
 * Requires a valid Firebase ID token (attached automatically by the client).
 * De-dupes concurrent calls and caches the result for 3 minutes.
 */
export async function getRecommendedEvents() {
    const cached = recoListCacheGet();
    if (cached) return cached;

    // De-duplicate concurrent calls (e.g. screen focus + mount firing together)
    if (_recoInflight) return _recoInflight;

    _recoInflight = (async () => {
        try {
            const { data } = await apiClient.get("/events/recommended", { timeout: 10_000 });
            if (data?.events?.length) recoListCacheSet(data);
            return data;
        } finally {
            _recoInflight = null;
        }
    })();

    return _recoInflight;
}

/**
 * Fetch a single event by its Firestore document ID.
 *
 * @param {string} eventId
 * @param {{ bypassCache?: boolean }} [options]
 */
export async function getEventById(eventId, options = {}) {
    const { bypassCache = false } = options;
    const key = String(eventId);
    if (!key) return null;

    if (!bypassCache) {
        const hit = eventCacheGet(key);
        if (hit) return hit;
    }
    const pending = eventInFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
        try {
            const { data } = await apiClient.get(
                `/events/${encodeURIComponent(key)}`,
                { timeout: 30_000 },
            );
            const ev = data?.event ?? data;
            if (ev && typeof ev === "object") eventCacheSet(key, ev);
            return ev;
        } finally {
            eventInFlight.delete(key);
        }
    })();

    eventInFlight.set(key, p);
    return p;
}
