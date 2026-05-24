import apiClient from "./client";
import { unwrapApiData } from "../utils/api";

// ─── In-memory detail cache (speeds repeat opens + dedupes overlapping requests) ─

const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const detailCache = new Map(); // placeId → { t, payload }
const inFlight = new Map();    // placeId → Promise

function cacheGet(placeId) {
    const key = String(placeId);
    const entry = detailCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.t > DETAIL_CACHE_TTL_MS) {
        detailCache.delete(key);
        return null;
    }
    return entry.payload;
}

function cacheSet(placeId, payload) {
    if (!payload || typeof payload !== "object") return;
    detailCache.set(String(placeId), { t: Date.now(), payload });
}

/**
 * Warm cache + image pipeline before navigation finishes.
 * Safe to call from onPressIn; errors are ignored.
 *
 * @param {string} [placeId]
 */
export function prefetchPlaceDetails(placeId) {
    if (!placeId) return;
    getPlaceDetails(String(placeId), { bypassCache: false }).catch(() => null);
}

/**
 * Fetches full place details from the backend (Google Places → Firestore fallback).
 * Unwraps `{ status, data }` envelopes so the caller receives a flat place object.
 *
 * @param {string} placeId — Google place_id or Firestore document ID
 * @param {{ bypassCache?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function getPlaceDetails(placeId, options = {}) {
    const { bypassCache = false } = options;
    const key = String(placeId);
    if (!key || key === "undefined") return null;

    if (!bypassCache) {
        const hit = cacheGet(key);
        if (hit) return hit;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
        try {
            const { data } = await apiClient.get(
                `/places/${encodeURIComponent(key)}`,
                { timeout: 35_000 },
            );
            const place = unwrapApiData(data, data);
            if (place && typeof place === "object") cacheSet(key, place);
            return place;
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, p);
    return p;
}

export const fetchPlaceDetails = getPlaceDetails;

/**
 * v18: Fetches the user's saved-places list from the dedicated endpoint.
 * Returns an array of enriched place objects sorted newest-saved first.
 *
 * Falls back to `null` on 404 so callers can decide to use the legacy
 * interaction-replay strategy (useful during a rolling backend deploy).
 *
 * @returns {Promise<object[]|null>}
 */
export async function getSavedPlaces() {
    try {
        const { data } = await apiClient.get("/places/saved", { timeout: 20_000 });
        const items = unwrapApiData(data, []);
        return Array.isArray(items) ? items : [];
    } catch (err) {
        const status = err?.response?.status;
        if (status === 404) return null; // endpoint not yet deployed
        throw err;
    }
}

/**
 * Returns a fully-resolved URL for a Google Place photo.
 * The backend proxies the request so the API key stays server-side.
 *
 * @param {string} placeId        — place_id (used for the route path)
 * @param {string} photoReference — photo_reference from Place Details
 * @param {number} [maxWidth=800]
 * @returns {string} URL that loads image bytes (HTTP 200)
 */
export function getPlacePhotoUrl(placeId, photoReference, maxWidth = 800) {
    const base = apiClient.defaults.baseURL ?? "";
    return `${base}/places/${encodeURIComponent(placeId)}/photo?ref=${encodeURIComponent(photoReference)}&w=${maxWidth}`;
}
