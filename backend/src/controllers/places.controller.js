/**
 * places.controller.js — HTTP handlers for the /api/places resource.
 *
 * GET /api/places/:id
 *   Returns full place details from Google Places API (or Firestore fallback).
 *   The response includes real reviews, opening hours, photos, and coordinates.
 *
 * GET /api/places/:id/photo?ref=<photoReference>&w=<maxWidth>
 *   Streams JPEG/WebP bytes (HTTP 200) after fetching from Google server-side.
 *   No 302 to the client — avoids React Native Image + redirect issues.
 */

import {
  getPlaceDetails,
  fetchPlacePhotoBuffer,
} from "../services/googlePlaces.service.js";
import { getPlaceById }                         from "../services/place.service.js";
import { getUserById }                          from "../services/user.service.js";
import { getInteractionsByUser }                from "../services/interaction.service.js";
import { logger }                               from "../utils/logger.js";
import { buildPlacePhotoPaths }                from "../utils/placePhotoPaths.js";

const INTERACTION_TYPE_SAVE = "save";

/**
 * GET /api/places/:id
 *
 * 1. If GOOGLE_MAPS_API_KEY is set, tries Google Place Details first.
 * 2. Falls back to Firestore if Google fails or key is absent.
 * 3. Returns 404 when neither source has the place.
 */
export const getPlaceHandler = async (req, res, next) => {
  try {
    const { id } = req.params;

    // ── Try Google Place Details ──────────────────────────────────────────────
    const googleDetails = await getPlaceDetails(id);
    if (googleDetails) {
      return res.json({ status: "ok", data: googleDetails });
    }

    // ── Fallback: Firestore ───────────────────────────────────────────────────
    const firestorePlace = await getPlaceById(id);
    if (firestorePlace) {
      const fid  = firestorePlace.id ?? id;
      const refs = firestorePlace.photoReferences ?? [];
      const images = Array.isArray(firestorePlace.images) && firestorePlace.images.length
        ? firestorePlace.images.slice(0, 5)
        : buildPlacePhotoPaths(fid, refs, 400, 5);
      return res.json({
        status: "ok",
        data: { ...firestorePlace, id: fid, source: "firestore", images },
      });
    }

    return res.status(404).json({ status: "error", message: "Place not found" });
  } catch (err) {
    logger.error("[places] getPlaceHandler error:", { message: err.message });
    next(err);
  }
};

/**
 * GET /api/places/:id/photo?ref=<photoReference>&w=<maxWidth>
 *
 * Streams image bytes (200). Photo route is unauthenticated: photo_reference
 * is an unguessable capability token; rate-limiting still applies.
 */
/**
 * GET /api/places/saved
 *
 * v18: dedicated endpoint that returns every place the user currently has saved,
 * enriched with the live catalogue row when possible. Falls back to the place
 * snapshot stored in the save interaction's metadata so the response still
 * carries name/type/image/description even for places that aren't in the
 * Firestore catalogue (e.g. Google Maps live places).
 *
 * Response:
 *   {
 *     status: "ok",
 *     data:   [{ placeId, savedAt, ...placeFields }],
 *     meta:   { count, source: "user_profile" | "interaction_replay" }
 *   }
 */
export const getSavedPlacesHandler = async (req, res, next) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    const user = await getUserById(uid);
    const persistedIds = Array.isArray(user?.savedPlaceIds) ? user.savedPlaceIds : [];

    // Pull recent save/remove interactions so we can attach savedAt + a place
    // snapshot for ids that aren't in the catalogue (Google live results, etc.)
    const recentInteractions = await getInteractionsByUser(uid, 200);
    const savesByPlace = new Map();
    for (const ix of recentInteractions) {
      const pid = ix?.placeId;
      if (!pid) continue;
      if (ix.actionType === INTERACTION_TYPE_SAVE) {
        if (!savesByPlace.has(pid)) {
          savesByPlace.set(pid, {
            savedAt:  ix.createdAt ?? null,
            snapshot: ix.metadata?.place ?? null,
          });
        }
      }
    }

    // The persistent savedPlaceIds list on the user doc is the authoritative
    // source — if it's empty (older accounts before v18) fall back to the
    // interaction replay so the user still sees their old saves.
    const effectiveIds = persistedIds.length > 0
      ? persistedIds
      : Array.from(savesByPlace.keys());

    if (effectiveIds.length === 0) {
      return res.json({
        status: "ok",
        data:   [],
        meta:   { count: 0, source: "empty" },
      });
    }

    // Resolve each id against the live catalogue in parallel, falling back to
    // the snapshot stored in the save metadata when the catalogue doesn't
    // have the place (e.g. Google Maps live places that were never seeded).
    const resolved = await Promise.all(
      effectiveIds.map(async (pid) => {
        const meta = savesByPlace.get(pid) ?? {};
        const catalogueDoc = await getPlaceById(pid).catch(() => null);
        const base = catalogueDoc ?? meta.snapshot ?? null;
        if (!base) {
          return {
            placeId: pid,
            id:      pid,
            name:    "Saved place",
            type:    "place",
            savedAt: meta.savedAt ?? null,
            source:  "stub",
          };
        }
        const refs = base.photoReferences ?? [];
        const images = Array.isArray(base.images) && base.images.length
          ? base.images.slice(0, 5)
          : (catalogueDoc ? buildPlacePhotoPaths(pid, refs, 400, 5) : []);
        return {
          ...base,
          id:      base.id ?? pid,
          placeId: pid,
          images,
          savedAt: meta.savedAt ?? null,
          source:  catalogueDoc ? "catalogue" : "interaction_snapshot",
        };
      }),
    );

    return res.json({
      status: "ok",
      data:   resolved,
      meta: {
        count:  resolved.length,
        source: persistedIds.length > 0 ? "user_profile" : "interaction_replay",
      },
    });
  } catch (err) {
    logger.error("[places] getSavedPlacesHandler error:", { message: err.message });
    next(err);
  }
};

export const getPlacePhotoHandler = async (req, res, next) => {
  try {
    const { ref } = req.query;
    if (!ref) {
      return res.status(400).json({ status: "error", message: "ref query param is required" });
    }

    const maxWidth = Math.min(1600, Math.max(100, parseInt(req.query.w ?? "800", 10) || 800));
    const result = await fetchPlacePhotoBuffer(ref, maxWidth);

    if (!result) {
      return res.status(502).json({ status: "error", message: "Could not load photo" });
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(200).send(result.buffer);
  } catch (err) {
    logger.error("[places] getPlacePhotoHandler error:", { message: err.message });
    next(err);
  }
};
