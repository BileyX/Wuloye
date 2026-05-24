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
import {
  getPlaceById,
  getPlacesByIds,
} from "../services/place.service.js";
import { getUserById }                          from "../services/user.service.js";
import { getInteractionsByUser }                from "../services/interaction.service.js";
import { logger }                               from "../utils/logger.js";
import { buildPlacePhotoPaths }                from "../utils/placePhotoPaths.js";
import {
  savedPlacesCache,
} from "../utils/cache.js";

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
function buildSaveMetaFromInteractions(interactions) {
  const savesByPlace = new Map();
  for (const ix of interactions) {
    const pid = ix?.placeId;
    if (!pid || ix.actionType !== INTERACTION_TYPE_SAVE) continue;
    if (!savesByPlace.has(pid)) {
      savesByPlace.set(pid, {
        savedAt:  ix.createdAt ?? null,
        snapshot: ix.metadata?.place ?? null,
      });
    }
  }
  return savesByPlace;
}

function resolveSavedPlace(pid, catalogueDoc, meta) {
  const base = catalogueDoc ?? meta?.snapshot ?? null;
  if (!base) {
    return {
      placeId: pid,
      id:      pid,
      name:    "Saved place",
      type:    "place",
      savedAt: meta?.savedAt ?? null,
      source:  "stub",
    };
  }
  const refs = base.photoReferences ?? [];
  const images = Array.isArray(base.images) && base.images.length
    ? base.images.slice(0, 3)
    : (catalogueDoc ? buildPlacePhotoPaths(pid, refs, 400, 3) : []);
  return {
    ...base,
    id:      base.id ?? pid,
    placeId: pid,
    images,
    savedAt: meta?.savedAt ?? null,
    source:  catalogueDoc ? "catalogue" : "interaction_snapshot",
  };
}

export const getSavedPlacesHandler = async (req, res, next) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    const cacheKey = `sp:${uid}`;
    const cached = savedPlacesCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const user = await getUserById(uid);
    const persistedIds = Array.isArray(user?.savedPlaceIds) ? user.savedPlaceIds : [];

    let effectiveIds = persistedIds;
    let source = persistedIds.length > 0 ? "user_profile" : "interaction_replay";
    let savesByPlace = new Map();

    if (effectiveIds.length === 0) {
      const recentInteractions = await getInteractionsByUser(uid, 100);
      savesByPlace = buildSaveMetaFromInteractions(recentInteractions);
      effectiveIds = Array.from(savesByPlace.keys());
    }

    if (effectiveIds.length === 0) {
      const emptyPayload = {
        status: "ok",
        data:   [],
        meta:   { count: 0, source: "empty" },
      };
      savedPlacesCache.set(cacheKey, emptyPayload);
      return res.json(emptyPayload);
    }

    const catalogueMap = await getPlacesByIds(effectiveIds);
    const missingFromCatalogue = effectiveIds.filter((pid) => !catalogueMap.has(pid));

    if (missingFromCatalogue.length > 0 && savesByPlace.size === 0) {
      const recentInteractions = await getInteractionsByUser(uid, 100);
      savesByPlace = buildSaveMetaFromInteractions(recentInteractions);
    }

    const resolved = effectiveIds.map((pid) => {
      const meta = savesByPlace.get(pid) ?? {};
      const catalogueDoc = catalogueMap.get(pid) ?? null;
      return resolveSavedPlace(pid, catalogueDoc, meta);
    });

    const payload = {
      status: "ok",
      data:   resolved,
      meta: {
        count:  resolved.length,
        source,
      },
    };

    savedPlacesCache.set(cacheKey, payload);
    return res.json(payload);
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
