/**
 * googlePlaces.service.js — Phase 14: Google Maps Places integration.
 *
 * Fetches real, nearby places from the Google Maps Places API (Nearby Search)
 * and normalises them into the same schema used throughout the recommendation
 * engine, so the entire scoring pipeline works identically for both data sources.
 *
 * Required environment variable:
 *   GOOGLE_MAPS_API_KEY — a Google Cloud API key with the Places API enabled.
 *
 * Graceful degradation:
 *   If the key is absent, the API returns an error, or a network failure occurs,
 *   the function returns an empty array and the engine falls back to Firestore data.
 *
 * Caching:
 *   Results are cached in-process for CACHE_TTL_MS (10 min) per unique
 *   lat/lng (rounded to 2 d.p., ≈1 km grid) + radius combination.
 *
 * Place schema produced (compatible with place.service.js fields):
 *   id                {string}  — Google place_id
 *   name              {string}  — display name
 *   type              {string}  — our internal type (gym | coffee | restaurant | …)
 *   location          {object}  — { lat, lng, city }
 *   priceRange        {string}  — "free" | "low" | "medium" | "high"
 *   tags              {string[]}— derived from Google types array
 *   rating            {number}  — Google average rating (1–5)
 *   popularityScore   {number}  — rating * ln(userRatingsTotal + 1), normalized 0–100
 *   isIndoor          {boolean} — derived from types (park/natural_feature = false)
 *   isOpen            {boolean|null} — opening_hours.open_now, null if not returned
 *   trendScore        {number}  — 0–1: trending = high rating × high review volume
 *   userRatingsTotal  {number}  — raw review count from Google
 *   source            {string}  — always "google_maps"
 */

import { logger } from "../utils/logger.js";
import { buildPlacePhotoPaths } from "../utils/placePhotoPaths.js";
import { classifyDenomination } from "../utils/denominationClassifier.js";

const GOOGLE_API_BASE = "https://maps.googleapis.com/maps/api/place";

// ─── Cache ────────────────────────────────────────────────────────────────────
const _cache      = new Map(); // cacheKey → { places: object[], ts: number }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Type mappings ─────────────────────────────────────────────────────────────

/**
 * Google Place types to issue one Nearby Search call per entry.
 * Results from all calls are merged and deduplicated by place_id.
 */
const QUERY_TYPES = [
  "gym", "cafe", "restaurant", "bar", "park", "library", "night_club",
  "lodging", "church", "stadium", "bowling_alley", "golf_course",
];

/**
 * Maps a Google type string → our internal place type.
 * First match in a result's types array wins.
 */
const GOOGLE_TO_INTERNAL = new Map([
  ["stadium",           "sports"],
  ["bowling_alley",     "sports"],
  ["golf_course",       "sports"],
  ["sports_club",       "sports"],
  ["ice_skating_rink",  "sports"],
  ["tennis_court",      "sports"],
  ["athletic_field",    "sports"],
  ["gym",               "gym"],
  ["fitness_centre",    "gym"],
  ["yoga",              "yoga"],
  ["spa",               "yoga"],
  ["cafe",              "coffee"],
  ["coffee_shop",       "coffee"],
  ["bakery",            "coffee"],
  ["restaurant",        "restaurant"],
  ["meal_takeaway",     "restaurant"],
  ["food",              "restaurant"],
  ["bar",               "social"],
  ["night_club",        "social"],
  ["lodging",           "hotel"],
  ["church",            "church"],
  ["hindu_temple",      "church"],
  ["mosque",            "church"],
  ["synagogue",         "church"],
  ["park",              "park"],
  ["natural_feature",   "outdoor"],
  ["campground",        "outdoor"],
  ["library",           "study"],
  ["book_store",        "study"],
  ["university",        "study"],
]);

/** Google types that indicate an outdoor venue (isIndoor = false). */
const OUTDOOR_TYPES = new Set([
  "park", "natural_feature", "campground", "amusement_park",
  "stadium", "cemetery", "rv_park", "tourist_attraction",
]);

/** Generic/noise types excluded from the tags array. */
const GENERIC_TYPES = new Set([
  "point_of_interest", "establishment", "food", "store", "premise",
  "business", "health", "beauty_salon",
]);

/** Maps Google price_level (0–4) to our priceRange string. */
const PRICE_LEVEL_MAP = ["free", "low", "medium", "high", "high"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves a Google types array to our internal type.
 * Returns null when no mapping can be found (place will be skipped).
 */
const resolveInternalType = (types = []) => {
  for (const t of types) {
    const mapped = GOOGLE_TO_INTERNAL.get(t);
    if (mapped) return mapped;
  }
  return null;
};

/**
 * Computes a normalised 0–100 popularity score.
 * Formula: rating × ln(userRatingsTotal + 1), capped at 100.
 * Reference max: 5 × ln(1_000_001) ≈ 69 → normalized to 100.
 */
const computePopularityScore = (rating, total) => {
  if (!rating || !total) return 0;
  const raw = rating * Math.log(total + 1);
  return Math.min(100, Math.round((raw / 70) * 100));
};

/**
 * Computes a 0–1 trend score.
 * Only fires for places with rating >= 4.0; higher rating + more reviews = higher score.
 * Saturates (→ 1) at rating=5.0 and 1000+ reviews.
 */
const computeTrendScore = (rating, total) => {
  if (!rating || !total || rating < 4.0) return 0;
  const ratingFactor = (rating - 4.0) / 1.0;  // 0 at 4.0 → 1 at 5.0
  const volumeFactor = Math.min(1, total / 1000); // saturates at 1 000 reviews
  return +(ratingFactor * volumeFactor).toFixed(4);
};

/**
 * Transforms a raw Google Nearby Search result into our place schema.
 * Returns null for unmappable or incomplete results (will be filtered out).
 *
 * @param {object} raw — one element from the Google API results array
 * @returns {object|null}
 */
const transformPlace = (raw) => {
  const types       = raw.types ?? [];
  const internalType = resolveInternalType(types);
  if (!internalType) return null;

  const lat = raw.geometry?.location?.lat;
  const lng = raw.geometry?.location?.lng;
  if (lat == null || lng == null) return null;

  const rating           = raw.rating            ?? null;
  const userRatingsTotal = raw.user_ratings_total ?? 0;
  const priceLevel       = raw.price_level;

  const photoRefs = (raw.photos ?? [])
    .map((p) => p.photo_reference)
    .filter(Boolean)
    .slice(0, 8);
  const photoReferences = photoRefs.slice(0, 5);
  const images =
    photoReferences.length > 0
      ? buildPlacePhotoPaths(raw.place_id, photoReferences, { max: 5, width: 720 })
      : [];

  const place = {
    id:               raw.place_id,
    name:             raw.name,
    type:             internalType,
    location:         { lat, lng, city: raw.vicinity ?? "" },
    priceRange:       PRICE_LEVEL_MAP[priceLevel ?? 2] ?? "medium",
    tags:             types.filter((t) => !GENERIC_TYPES.has(t)).slice(0, 5),
    rating:           rating ?? 0,
    popularityScore:  computePopularityScore(rating, userRatingsTotal),
    isIndoor:         !types.some((t) => OUTDOOR_TYPES.has(t)),
    isOpen:           raw.opening_hours?.open_now ?? null,
    trendScore:       computeTrendScore(rating, userRatingsTotal),
    userRatingsTotal,
    source:           "google_maps",
    ...(photoReferences.length ? { photoReferences, images } : {}),
  };

  // ── Denomination enrichment for church-type places ────────────────────────
  if (internalType === "church") {
    const denom = classifyDenomination(place);
    if (denom.isReligious) {
      place.denominationType       = denom.denomination;
      place.denominationConfidence = denom.confidence;
      place.denominationEvidence   = denom.evidence;
    }
  }

  return place;
};

// ─── API Fetch ────────────────────────────────────────────────────────────────

/**
 * Single Nearby Search API call for one Google place type.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radius — in metres
 * @param {string} googleType
 * @param {string} apiKey
 * @returns {Promise<object[]>} raw Google result objects
 */
const fetchNearby = async (lat, lng, radius, googleType, apiKey) => {
  const url = new URL(`${GOOGLE_API_BASE}/nearbysearch/json`);
  url.searchParams.set("location", `${lat},${lng}`);
  url.searchParams.set("radius",   String(radius));
  url.searchParams.set("type",     googleType);
  url.searchParams.set("key",      apiKey);

  const res  = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`${json.status}: ${json.error_message ?? ""}`);
  }
  return json.results ?? [];
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches real nearby places from the Google Maps Places API.
 *
 * Makes parallel Nearby Search calls for each type in QUERY_TYPES, deduplicates
 * by place_id, transforms results into our internal schema, and caches them.
 *
 * @param {{ lat: number, lng: number }} userLocation
 * @param {number} [radiusMeters=5000] — search radius in metres (Google max: 50 000)
 * @returns {Promise<object[]>} normalised place objects, or [] on any error
 */
export const getNearbyPlaces = async (userLocation, radiusMeters = 5000) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn("[googlePlaces] GOOGLE_MAPS_API_KEY not set — skipping Google Places fetch");
    return [];
  }

  const { lat, lng } = userLocation;
  if (lat == null || lng == null) {
    logger.warn("[googlePlaces] Invalid userLocation — lat and lng are required");
    return [];
  }

  // Cache key: round to 2 d.p. (~1 km grid) + radius in km for human-readable key.
  const cacheKey = `${Math.round(lat * 100) / 100}_${Math.round(lng * 100) / 100}_${Math.round(radiusMeters / 1000)}km`;
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    logger.debug(`[googlePlaces] Cache hit for ${cacheKey} — ${cached.places.length} place(s)`);
    return cached.places;
  }

  logger.info(`[googlePlaces] Fetching nearby places lat=${lat} lng=${lng} radius=${radiusMeters}m`);

  try {
    // Fire all type queries in parallel; use allSettled so one failure doesn't abort.
    const batches = await Promise.allSettled(
      QUERY_TYPES.map((t) => fetchNearby(lat, lng, radiusMeters, t, apiKey))
    );

    const seen   = new Set();
    const places = [];

    for (const result of batches) {
      if (result.status !== "fulfilled") {
        logger.warn("[googlePlaces] One type query failed:", { message: result.reason?.message });
        continue;
      }
      for (const raw of result.value) {
        if (seen.has(raw.place_id)) continue; // deduplicate
        seen.add(raw.place_id);
        const place = transformPlace(raw);
        if (place) places.push(place);
      }
    }

    logger.info(`[googlePlaces] Fetched ${places.length} unique mappable place(s) for ${cacheKey}`);
    _cache.set(cacheKey, { places, ts: Date.now() });
    return places;
  } catch (err) {
    logger.error("[googlePlaces] Fetch failed:", { message: err.message });
    return [];
  }
};

/**
 * Narrow Nearby Search for an active Discover chip (category-specific, no mixing).
 */
const DISCOVER_NEARBY_GOOGLE_TYPES = {
  gym:       ["gym"],
  cafe:      ["cafe", "restaurant", "bakery", "meal_takeaway"],
  hotel:     ["lodging"],
  sports:    ["stadium", "bowling_alley", "golf_course", "sports_club"],
  church:    ["church", "hindu_temple", "mosque", "synagogue"],
  workspace: ["library"],
};

/**
 * @param {{ lat: number, lng: number }} userLocation
 * @param {number} radiusMeters
 * @param {"gym"|"cafe"|"hotel"|"sports"|"church"} discoverKey
 * @returns {Promise<object[]>}
 */
export const getNearbyPlacesForDiscoverKey = async (userLocation, radiusMeters = 5000, discoverKey) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];

  const { lat, lng } = userLocation;
  if (lat == null || lng == null) return [];

  const googleTypes = DISCOVER_NEARBY_GOOGLE_TYPES[discoverKey];
  if (!googleTypes?.length) return [];

  const baseKey = `${Math.round(lat * 100) / 100}_${Math.round(lng * 100) / 100}_${Math.round(radiusMeters / 1000)}km`;
  const cacheKey  = `${baseKey}_discover_${discoverKey}`;
  const cached    = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    logger.debug(`[googlePlaces] discover cache hit ${cacheKey} (${cached.places.length})`);
    return cached.places;
  }

  try {
    const batches = await Promise.allSettled(
      googleTypes.map((t) => fetchNearby(lat, lng, radiusMeters, t, apiKey)),
    );
    const seen   = new Set();
    const places = [];
    for (const result of batches) {
      if (result.status !== "fulfilled") continue;
      for (const raw of result.value) {
        if (seen.has(raw.place_id)) continue;
        seen.add(raw.place_id);
        const place = transformPlace(raw);
        if (place) places.push(place);
      }
    }
    logger.info(`[googlePlaces] discover ${discoverKey}: ${places.length} places`);
    _cache.set(cacheKey, { places, ts: Date.now() });
    return places;
  } catch (err) {
    logger.error("[googlePlaces] discover fetch failed:", { message: err.message });
    return [];
  }
};

/** Purges all cached entries (useful in tests). */
export const invalidateGoogleCache = () => {
  _cache.clear();
  logger.info("[googlePlaces] Cache purged");
};

// ─── Place Details + Photo bytes ─────────────────────────────────────────────

const PLACE_DETAILS_FIELDS = [
  "place_id",
  "name",
  "geometry",
  "formatted_address",
  "formatted_phone_number",
  "international_phone_number",
  "opening_hours",
  "photos",
  "rating",
  "user_ratings_total",
  "reviews",
  "types",
  "website",
  "vicinity",
  "price_level",
].join(",");

/**
 * Fetches Place Details and merges photo URLs (high-res for detail UI).
 *
 * @param {string} placeId
 * @returns {Promise<object|null>}
 */
export const getPlaceDetails = async (placeId) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !placeId) {
    logger.warn("[googlePlaces] getPlaceDetails: missing key or placeId");
    return null;
  }

  try {
    const url = new URL(`${GOOGLE_API_BASE}/details/json`);
    url.searchParams.set("place_id", String(placeId));
    url.searchParams.set("fields", PLACE_DETAILS_FIELDS);
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.status !== "OK" || !json.result) {
      logger.warn(
        `[googlePlaces] details status=${json.status} msg=${json.error_message ?? ""}`,
      );
      return null;
    }

    const raw = json.result;
    let base = transformPlace(raw);

    if (!base) {
      const lat = raw.geometry?.location?.lat;
      const lng = raw.geometry?.location?.lng;
      if (lat == null || lng == null) return null;
      const types = raw.types ?? [];
      base = {
        id: raw.place_id,
        name: raw.name ?? "Place",
        type: resolveInternalType(types) ?? "Place",
        location: {
          lat,
          lng,
          city: raw.vicinity ?? raw.formatted_address ?? "",
        },
        priceRange: PRICE_LEVEL_MAP[raw.price_level ?? 2] ?? "medium",
        tags: types.filter((t) => !GENERIC_TYPES.has(t)).slice(0, 5),
        rating: raw.rating ?? 0,
        popularityScore: computePopularityScore(
          raw.rating,
          raw.user_ratings_total ?? 0,
        ),
        isIndoor: !types.some((t) => OUTDOOR_TYPES.has(t)),
        isOpen: raw.opening_hours?.open_now ?? null,
        trendScore: computeTrendScore(
          raw.rating,
          raw.user_ratings_total ?? 0,
        ),
        userRatingsTotal: raw.user_ratings_total ?? 0,
        source: "google_maps",
      };
    }

    const photoRefs = (raw.photos ?? [])
      .map((p) => p.photo_reference)
      .filter(Boolean)
      .slice(0, 8);
    const photoReferences = photoRefs.slice(0, 6);
    const images =
      photoReferences.length > 0
        ? buildPlacePhotoPaths(raw.place_id, photoReferences, {
            max: 6,
            width: 1280,
          })
        : [];

    const googleReviews = (raw.reviews ?? []).map((r, i) => ({
      id: `g_${r.time ?? "t"}_${i}`,
      name: r.author_name ?? "Google Maps user",
      rating: typeof r.rating === "number" ? r.rating : 0,
      comment: (r.text ?? "").trim(),
      timeAgo: r.relative_time_description ?? "",
      profilePhotoUrl: r.profile_photo_url ?? null,
    }));

    return {
      ...base,
      photoReferences,
      images,
      reviews: googleReviews,
      address: raw.formatted_address ?? base.location?.city ?? "",
      website: raw.website ?? null,
      phone: raw.international_phone_number ?? raw.formatted_phone_number ?? null,
      openingHours: raw.opening_hours ?? null,
    };
  } catch (err) {
    logger.error("[googlePlaces] getPlaceDetails failed:", { message: err.message });
    return null;
  }
};

/**
 * Downloads a single photo from Google (follows redirect) and returns bytes.
 *
 * @param {string} photoReference
 * @param {number} [maxWidth=900]
 * @returns {Promise<{ buffer: Buffer, contentType: string }|null>}
 */
export const fetchPlacePhotoFromGoogle = async (photoReference, maxWidth = 900) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !photoReference) return null;

  try {
    const url = new URL(`${GOOGLE_API_BASE}/photo`);
    url.searchParams.set("maxwidth", String(maxWidth));
    url.searchParams.set("photo_reference", String(photoReference));
    url.searchParams.set("key", apiKey);

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      logger.warn(`[googlePlaces] photo HTTP ${res.status}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get("content-type") || "image/jpeg";

    return { buffer, contentType };
  } catch (err) {
    logger.warn("[googlePlaces] fetchPlacePhotoFromGoogle:", err.message);
    return null;
  }
};

/**
 * Fetches image bytes after following Google's redirect (for HTTP 200 proxy to mobile).
 * React Native Image often fails on 302 + Authorization; streaming avoids that.
 *
 * @returns {Promise<{ buffer: Buffer, contentType: string }|null>}
 */
export const fetchPlacePhotoBuffer = async (photoReference, maxWidth = 800) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !photoReference) return null;

  try {
    const url = new URL(`${GOOGLE_API_BASE}/photo`);
    url.searchParams.set("photoreference", photoReference);
    url.searchParams.set("maxwidth", String(maxWidth));
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), { redirect: "follow" });
    if (!res.ok) {
      logger.warn(`[googlePlaces] fetchPlacePhotoBuffer HTTP ${res.status}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return { buffer, contentType };
  } catch (err) {
    logger.error("[googlePlaces] fetchPlacePhotoBuffer failed:", { message: err.message });
    return null;
  }
};
