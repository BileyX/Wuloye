/**
 * controllers/ai.controller.js — Proxy handlers for the Python AI microservice
 * plus the internal AI daily schedule endpoint.
 *
 * Each proxy handler:
 *   1. Calls the relevant AI service endpoint.
 *   2. Returns the AI service response (or a meaningful error) to the client.
 *   3. On failure, returns a graceful 503 rather than crashing.
 */

import { logger }              from "../utils/logger.js";
import { getAiDailySchedule }  from "../services/aiSchedule.service.js";

const AI_SERVICE_URL     = process.env.AI_SERVICE_URL     || "http://localhost:8000";
const AI_SERVICE_TIMEOUT = parseInt(process.env.AI_SERVICE_TIMEOUT_MS || "10000", 10);

// ─── Shared fetch helper ──────────────────────────────────────────────────────

async function aiProxy(method, path, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_SERVICE_TIMEOUT);

  try {
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body:    body ? JSON.stringify(body) : undefined,
      signal:  controller.signal,
    });

    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ─── POST /api/ai/train ───────────────────────────────────────────────────────

/**
 * Triggers a full training pipeline on the Python AI service.
 * Returns the AI service response plus meta.ai fields.
 *
 * @type {import("express").RequestHandler}
 */
export const triggerAiTrain = async (req, res, next) => {
  try {
    logger.info(`[ai.controller] POST /train triggered by uid=${req.user.uid}`);

    const { ok, status, data } = await aiProxy("POST", "/train");

    if (!ok) {
      return res.status(status).json({
        success: false,
        data:    null,
        message: data?.detail ?? "AI service training failed",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...data,
        meta: {
          modelActive:   true,
          modelVersion:  data?.model_version ?? data?.version ?? "unknown",
          lastTrainedAt: data?.trained_at    ?? new Date().toISOString(),
        },
      },
      message: "AI model training triggered successfully",
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        success: false,
        data:    null,
        message: `AI service did not respond within ${AI_SERVICE_TIMEOUT}ms`,
      });
    }
    logger.warn(`[ai.controller] train proxy error: ${err.message}`);
    return res.status(503).json({
      success: false,
      data:    null,
      message: `AI service unavailable: ${err.message}`,
    });
  }
};

// ─── POST /api/ai/reset ───────────────────────────────────────────────────────

/**
 * Wipes all AI model artefacts via the Python AI service.
 *
 * @type {import("express").RequestHandler}
 */
export const triggerAiReset = async (req, res, next) => {
  try {
    logger.info(`[ai.controller] POST /reset triggered by uid=${req.user.uid}`);

    const { ok, status, data } = await aiProxy("POST", "/reset");

    if (!ok) {
      return res.status(status).json({
        success: false,
        data:    null,
        message: data?.detail ?? "AI service reset failed",
      });
    }

    return res.status(200).json({
      success: true,
      data,
      message: "AI model artefacts wiped. System is in cold-start state.",
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        success: false,
        data:    null,
        message: `AI service did not respond within ${AI_SERVICE_TIMEOUT}ms`,
      });
    }
    logger.warn(`[ai.controller] reset proxy error: ${err.message}`);
    return res.status(503).json({
      success: false,
      data:    null,
      message: `AI service unavailable: ${err.message}`,
    });
  }
};

// ─── GET /api/ai/status ───────────────────────────────────────────────────────

/**
 * Returns the current AI model status.
 *
 * @type {import("express").RequestHandler}
 */
export const getAiStatus = async (req, res, next) => {
  try {
    const { ok, status, data } = await aiProxy("GET", "/model/status");

    if (!ok) {
      return res.status(status).json({
        success: false,
        data:    null,
        message: "AI service returned an error",
      });
    }

    return res.status(200).json({
      success: true,
      data,
      message: "AI model status retrieved",
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        success: false,
        data:    null,
        message: "AI service timeout",
      });
    }
    return res.status(503).json({
      success: false,
      data:    null,
      message: `AI service unavailable: ${err.message}`,
    });
  }
};

// ─── GET /api/ai/schedule ─────────────────────────────────────────────────────

/**
 * Returns a personalized AI daily schedule split into four periods
 * (morning / afternoon / evening / night).
 *
 * Query params:
 *   lat    {number} — user latitude  (enables Google Maps place sourcing)
 *   lng    {number} — user longitude
 *   radius {number} — search radius in km (default 5, max 50)
 *
 * @type {import("express").RequestHandler}
 */
export const getAiScheduleHandler = async (req, res, next) => {
  try {
    const rawLat    = parseFloat(req.query.lat);
    const rawLng    = parseFloat(req.query.lng);
    const rawRadius = parseFloat(req.query.radius);

    const hasLocation = !isNaN(rawLat) && !isNaN(rawLng);
    const radiusKm    = hasLocation && !isNaN(rawRadius)
      ? Math.min(50, Math.max(1, rawRadius))
      : 5;

    const userLocation = hasLocation
      ? { lat: rawLat, lng: rawLng, radiusMeters: radiusKm * 1000 }
      : null;

    const refresh = req.query.refresh === "true" || req.query.refresh === "1";
    const { schedule, meta } = await getAiDailySchedule(
      req.user.uid,
      userLocation,
      { refresh },
    );

    return res.status(200).json({
      success: true,
      data:    schedule,
      message: "AI daily schedule generated",
      meta,
    });
  } catch (err) {
    logger.error(`[ai.controller] getAiScheduleHandler error: ${err.message}`);
    next(err);
  }
};
