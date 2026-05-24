/**
 * recommendation.controller.js — HTTP handler for GET /api/recommendations.
 *
 * Responsibility: parse the request, delegate to the recommendation service,
 * and return a consistent JSON envelope.
 *
 * Supports optional query parameters:
 *   ?debug=true       — includes scoreBreakdown on each result AND meta.context
 *                       (timeOfDay, isWeekend, hour) in the response.
 *   ?lat=<number>     — Phase 14: user latitude  (decimal degrees)
 *   ?lng=<number>     — Phase 14: user longitude (decimal degrees)
 *   ?radius=<number>  — Phase 14: search radius in km (default 5, max 50)
 *   ?fast=true        — Phase 15: fallback mode — skip embedding cosine-similarity
 *                       and AI model scoring for lower latency.  Results are cached
 *                       under a separate key from full-mode responses.
 *   ?refresh=true     — Bypass recommendation cache, reload profile + interactions
 *                       from Firestore, and rotate recently shown places to the back.
 *
 * When lat + lng are supplied and GOOGLE_MAPS_API_KEY is configured, the engine
 * fetches real nearby places from Google Maps instead of the static Firestore
 * catalogue.  The response meta.location block reports which source was used.
 *
 * No Firestore logic lives here. The service layer owns all data access and
 * scoring. The controller only handles HTTP concerns.
 */

import { getRecommendations } from "../services/recommendation.service.js";
import { resolveDiscoverFilter } from "../utils/discoverCategory.js";

/**
 * GET /api/recommendations[?debug=true&lat=9.025&lng=38.747&radius=5]
 *
 * Returns a ranked, diverse, context-aware list of up to 10 places
 * personalised for the authenticated user based on their profile, routines,
 * and past interactions.
 *
 * Query params:
 *   debug  {string} — "true" to include per-rule scoreBreakdown + meta.context
 *   lat    {number} — user latitude  (enables Google Maps place source)
 *   lng    {number} — user longitude (enables Google Maps place source)
 *   radius {number} — search radius in km, default 5, capped at 50
 *   fast   {string} — "true" to enable fallback mode (skip embedding + AI model)
 *   type     {string} — legacy substring filter when not a Discover chip
 *   category {string} — Discover chip: gym|cafe|hotel|sports|events|church
 *   types    {string} — comma-separated legacy filters
 *
 * Error cases:
 *   404 — user profile document does not exist in Firestore
 *   500 — unexpected error (caught by errorHandler.js)
 *
 * @type {import("express").RequestHandler}
 */
export const getRecommendationsHandler = async (req, res, next) => {
  try {
    const debug = req.query.debug === "true";

    // ── Phase 14: optional location for Google Maps place sourcing ───────────────
    const rawLat    = parseFloat(req.query.lat);
    const rawLng    = parseFloat(req.query.lng);
    const rawRadius = parseFloat(req.query.radius);

    const hasLocation = !isNaN(rawLat) && !isNaN(rawLng);
    const radiusKm    = hasLocation && !isNaN(rawRadius)
      ? Math.min(50, Math.max(1, rawRadius))  // clamp 1–50 km
      : 5;

    const userLocation = hasLocation
      ? { lat: rawLat, lng: rawLng, radiusMeters: radiusKm * 1000 }
      : null;

    const rawType     = req.query.type     ?? null;
    const rawCategory = req.query.category ?? null;
    const rawTypes    = req.query.types    ?? null;

    const { discoverKey, legacyTypeFilter } = resolveDiscoverFilter(
      rawCategory,
      rawType,
      rawTypes
    );

    // Discover category taps skip heavy AI/embedding work for sub-3s responses.
    const fastMode =
      req.query.fast === "true" || Boolean(discoverKey);

    // ─ Mode filter: changes the final sort strategy ─────────────────────────
    // ?mode=trending  → re-rank by trendScore × rating
    // ?mode=nearby    → re-rank by distanceKm ascending
    const VALID_MODES = new Set(["trending", "nearby"]);
    const rawMode  = req.query.mode ?? null;
    const modeFilter = rawMode && VALID_MODES.has(rawMode.toLowerCase())
      ? rawMode.toLowerCase()
      : null;

    const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";

    const { recommendations, meta } = await getRecommendations(
      req.user.uid,
      debug,
      10,
      userLocation,
      fastMode,
      legacyTypeFilter,
      modeFilter,
      discoverKey,
      forceRefresh,
    );

    return res.status(200).json({
      success: true,
      data:    recommendations,
      message: "Recommendations generated successfully",
      meta,
    });
  } catch (error) {
    next(error);
  }
};
