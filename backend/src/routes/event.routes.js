/**
 * event.routes.js — Route definitions for the events resource.
 *
 * Public (no auth):
 *   GET  /api/events             — list events with optional filters
 *   GET  /api/events/:id         — single event by ID
 *
 * Authenticated:
 *   GET  /api/events/recommended — AI-personalised list for the current user
 *
 * Admin only:
 *   GET    /api/events/stats       — total event count
 *   PATCH  /api/events/:id         — edit event fields
 *   DELETE /api/events/:id         — delete event
 *   PATCH  /api/events/:id/featured — toggle featured flag
 */

import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.middleware.js";
import { authLimiter }   from "../middleware/rateLimiter.js";
import {
  getEventsHandler,
  getRecommendedEventsHandler,
  getEventsStatsHandler,
  getEventByIdHandler,
  createEventHandler,
  updateEventHandler,
  deleteEventHandler,
  setFeaturedHandler,
} from "../controllers/event.controller.js";

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────
router.get("/", getEventsHandler);

// ── Authenticated routes ──────────────────────────────────────────────────────
router.get("/recommended", authLimiter, authenticate, getRecommendedEventsHandler);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get("/stats", authenticate, requireAdmin, getEventsStatsHandler);
router.post("/", authenticate, requireAdmin, createEventHandler);
router.patch("/:id", authenticate, requireAdmin, updateEventHandler);
router.delete("/:id", authenticate, requireAdmin, deleteEventHandler);
router.patch("/:id/featured", authenticate, requireAdmin, setFeaturedHandler);
router.patch("/:id/trending", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { updateEvent: svc } = await import("../services/event.service.js");
    await svc(req.params.id, { trending: Boolean(req.body.trending) });
    return res.status(200).json({ success: true });
  } catch (err) { next(err); }
});
router.patch("/:id/boost", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { aiBoostScore, adminPriority } = req.body;
    const updates = {};
    if (aiBoostScore  !== undefined) updates.aiBoostScore  = Math.min(100, Math.max(0, Number(aiBoostScore)));
    if (adminPriority !== undefined) updates.adminPriority = Math.min(100, Math.max(0, Number(adminPriority)));
    const { updateEvent: svc } = await import("../services/event.service.js");
    await svc(req.params.id, updates);
    return res.status(200).json({ success: true, data: updates });
  } catch (err) { next(err); }
});

// ── Single event (public, after named routes to avoid route conflicts) ─────────
router.get("/:id", getEventByIdHandler);

export default router;
