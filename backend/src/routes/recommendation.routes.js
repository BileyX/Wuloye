/**
 * recommendation.routes.js — Route definitions for the recommendations resource.
 *
 * All routes require a valid Firebase ID token via the authenticate middleware.
 * Mounted at /api/recommendations in app.js.
 */

import { Router } from "express";

import { authenticate } from "../middleware/auth.middleware.js";
import { getRecommendationsHandler } from "../controllers/recommendation.controller.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { getUserById } from "../services/user.service.js";
import { getPersonalizedTrendingFeed } from "../services/trending.service.js";

const router = Router();

// GET /api/recommendations  — personalised ranked place list
router.get("/", authLimiter, authenticate, getRecommendationsHandler);

// GET /api/recommendations/trending-feed — admin-controlled trending (mobile)
router.get("/trending-feed", authLimiter, authenticate, async (req, res, next) => {
  try {
    let profile = null;
    try {
      profile = await getUserById(req.user.uid);
    } catch { /* non-fatal */ }

    const { items, meta } = await getPersonalizedTrendingFeed(profile);
    return res.status(200).json({
      success: true,
      data: items,
      meta: { ...meta, modeFilter: "admin_trending" },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
