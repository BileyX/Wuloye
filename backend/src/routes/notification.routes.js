/**
 * routes/notification.routes.js — Notification system endpoints
 *
 * Mounted at /api/notifications in app.js.
 * All routes require a valid Firebase ID token.
 *
 *   GET  /api/notifications/preferences   — get user notification preferences
 *   PUT  /api/notifications/preferences   — update preferences
 *   GET  /api/notifications/generate      — generate AI notification content
 *   POST /api/notifications/interaction   — log notification interaction (tap/dismiss)
 *   GET  /api/notifications/history       — get notification history
 */

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
    getPreferences,
    putPreferences,
    generateContent,
    logInteraction,
    getHistory,
    postDeviceToken,
    deleteDeviceToken,
    getDeviceStatus,
} from "../controllers/notification.controller.js";

const router = Router();

router.get("/preferences", authenticate, getPreferences);
router.put("/preferences", authenticate, putPreferences);
router.get("/generate", authenticate, generateContent);
router.post("/interaction", authenticate, logInteraction);
router.get("/history", authenticate, getHistory);
router.post("/device-token", authenticate, postDeviceToken);
router.delete("/device-token", authenticate, deleteDeviceToken);
router.get("/device-status", authenticate, getDeviceStatus);

export default router;
