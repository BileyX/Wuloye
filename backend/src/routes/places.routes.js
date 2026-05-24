/**
 * places.routes.js — Routes for the /api/places resource.
 *
 * Mounted at /api/places in app.js.
 * Details require auth; photo proxy is public (rate-limited) for reliable RN Image loads.
 */

import { Router }              from "express";
import { authenticate }        from "../middleware/auth.middleware.js";
import { authLimiter }         from "../middleware/rateLimiter.js";
import {
  getPlaceHandler,
  getPlacePhotoHandler,
  getSavedPlacesHandler,
} from "../controllers/places.controller.js";

const router = Router();

// IMPORTANT: register specific routes BEFORE the catch-all `/:id` route so
// `/saved` is not interpreted as `/:id="saved"`.
// GET /api/places/saved — the user's persistent saved-places list (v18)
router.get("/saved", authLimiter, authenticate, getSavedPlacesHandler);

// GET /api/places/:id — full place details (Google → Firestore fallback)
router.get("/:id", authLimiter, authenticate, getPlaceHandler);

// GET /api/places/:id/photo?ref=<ref>&w=<width> — stream bytes; no auth (see controller)
router.get("/:id/photo", authLimiter, getPlacePhotoHandler);

export default router;
