/**
 * controllers/notification.controller.js — Notification API handlers
 *
 * Endpoints:
 *   GET  /api/notifications/preferences    — get user notification preferences
 *   PUT  /api/notifications/preferences    — update preferences
 *   GET  /api/notifications/generate       — generate AI notification content
 *   POST /api/notifications/interaction    — log notification interaction
 *   GET  /api/notifications/history        — get notification history
 */

import {
    getNotificationPreferences,
    updateNotificationPreferences,
    generateNotificationContent,
    logNotificationInteraction,
    getNotificationHistory,
} from "../services/notification.service.js";
import {
    registerDeviceToken,
    deactivateDeviceToken,
} from "../services/pushToken.service.js";

// ─── GET /api/notifications/preferences ──────────────────────────────────────

export async function getPreferences(req, res, next) {
    try {
        const { uid } = req.user;
        const prefs = await getNotificationPreferences(uid);
        res.json({ success: true, data: prefs });
    } catch (err) {
        next(err);
    }
}

// ─── PUT /api/notifications/preferences ──────────────────────────────────────

export async function putPreferences(req, res, next) {
    try {
        const { uid } = req.user;
        const updates = req.body;

        if (!updates || typeof updates !== "object") {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Request body must be a preferences object",
            });
        }

        const updated = await updateNotificationPreferences(uid, updates);
        res.json({ success: true, data: updated });
    } catch (err) {
        next(err);
    }
}

// ─── GET /api/notifications/generate ─────────────────────────────────────────

export async function generateContent(req, res, next) {
    try {
        const { uid } = req.user;
        const type = req.query.type ?? "all";

        const validTypes = ["morning", "afternoon", "evening", "dynamic", "all"];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                data: null,
                message: `type must be one of: ${validTypes.join(", ")}`,
            });
        }

        const content = await generateNotificationContent(uid, type);
        res.json({ success: true, data: content });
    } catch (err) {
        next(err);
    }
}

// ─── POST /api/notifications/interaction ─────────────────────────────────────

export async function logInteraction(req, res, next) {
    try {
        const { uid } = req.user;
        const { notificationId, action, type, timestamp } = req.body;

        if (!action) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "action is required",
            });
        }

        await logNotificationInteraction(uid, {
            notificationId,
            action,
            type,
            timestamp,
        });

        res.json({ success: true, data: { logged: true } });
    } catch (err) {
        next(err);
    }
}

// ─── GET /api/notifications/history ──────────────────────────────────────────

export async function getHistory(req, res, next) {
    try {
        const { uid } = req.user;
        const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 50);

        const history = await getNotificationHistory(uid, limit);
        res.json({ success: true, data: history });
    } catch (err) {
        next(err);
    }
}

// ─── POST /api/notifications/device-token ────────────────────────────────────

export async function postDeviceToken(req, res, next) {
    try {
        const { uid } = req.user;
        const { expoPushToken, platform, deviceName, appVersion } = req.body;

        if (!expoPushToken) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "expoPushToken is required",
            });
        }

        const doc = await registerDeviceToken(uid, {
            expoPushToken,
            platform,
            deviceName,
            appVersion,
        });

        res.json({ success: true, data: doc });
    } catch (err) {
        next(err);
    }
}

// ─── DELETE /api/notifications/device-token ──────────────────────────────────

export async function deleteDeviceToken(req, res, next) {
    try {
        const { uid } = req.user;
        const { expoPushToken } = req.body;

        if (!expoPushToken) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "expoPushToken is required",
            });
        }

        await deactivateDeviceToken(uid, expoPushToken);
        res.json({ success: true, data: { removed: true } });
    } catch (err) {
        next(err);
    }
}

// ─── GET /api/notifications/device-status ────────────────────────────────────

export async function getDeviceStatus(req, res, next) {
    try {
        const { uid } = req.user;
        const { getTokensForUser } = await import("../services/pushToken.service.js");
        const tokens = await getTokensForUser(uid);
        res.json({
            success: true,
            data: {
                registered: tokens.length > 0,
                deviceCount: tokens.length,
            },
        });
    } catch (err) {
        next(err);
    }
}
