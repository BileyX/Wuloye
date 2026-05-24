/**
 * app.js — Express application factory
 *
 * Responsibility: configure middleware, mount routes, and attach error handlers.
 * Does NOT call app.listen() — that responsibility belongs to server.js.
 */

import express from "express";
import cors from "cors";

import healthRouter from "./routes/health.js";
import userRouter from "./routes/user.routes.js";
import routineRouter from "./routes/routine.routes.js";
import interactionRouter from "./routes/interaction.routes.js";
import recommendationRouter from "./routes/recommendation.routes.js";
import placesRouter from "./routes/places.routes.js";
import eventRouter from "./routes/event.routes.js";
import devRouter from "./routes/dev.routes.js";
import adminRouter from "./routes/admin.routes.js";
import aiRouter from "./routes/ai.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import reminderRouter from "./routes/reminder.routes.js";
import chatRouter from "./routes/chat.routes.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { initModelCache } from "./services/ai/modelService.js";
import { logger } from "./utils/logger.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { globalLimiter } from "./middleware/rateLimiter.js";
import helmet from "helmet";
import { metricsMiddleware } from "./middleware/metrics.js";

const app = express();

// ─── Global Middleware ────────────────────────────────────────────────────────

// Security HTTP headers — Phase 18
app.use(helmet());

// HTTP request logging (morgan → winston) — Phase 18
app.use(requestLogger);

// Global rate limiter (300 req / 15 min per IP) — Phase 18
app.use(globalLimiter);

// In-process metrics counters — Phase 18
app.use(metricsMiddleware);

// Parse incoming JSON request bodies (50 kb cap prevents megabyte JSON DoS)
app.use(express.json({ limit: "50kb" }));

// Parse URL-encoded bodies (form submissions)
app.use(express.urlencoded({ extended: true, limit: "50kb" }));

// CORS — origins are controlled via the ALLOWED_ORIGINS environment variable
const normalizeOrigin = (value) => (value || "").replace(/\/+$/, "");

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => normalizeOrigin(o.trim())).filter(Boolean)
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (allowedOrigins.length === 0) return callback(null, true);
      // Allow requests with no origin (e.g. mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
      callback(new Error(`CORS policy: origin ${origin} is not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/api/health", healthRouter);

// Admin verification route
app.use("/api/admin", adminRouter);

// User routes — provides /api/profile and (future) /api/users/* endpoints.
// Mounted at /api so the router controls the full path for each resource.
app.use("/api", userRouter);

// Routine routes — full CRUD under /api/routines
app.use("/api/routines", routineRouter);

// Interaction routes — data collection for AI recommendations under /api/interactions
app.use("/api/interactions", interactionRouter);

// Recommendation routes — personalised ranked place list under /api/recommendations
app.use("/api/recommendations", recommendationRouter);

// Places — Google-backed details + photo proxy under /api/places
app.use("/api/places", placesRouter);

// Events routes — scraped Ethiopian events under /api/events
app.use("/api/events", eventRouter);

// AI service proxy routes — manual train, reset, status under /api/ai
app.use("/api/ai", aiRouter);

// Notification system — preferences, AI content generation, history under /api/notifications
app.use("/api/notifications", notificationRouter);

// User-created custom reminders (sync + metadata)
app.use("/api/reminders", reminderRouter);

// AI chat assistant — conversational recommendations under /api/chat
app.use("/api/chat", chatRouter);

// Dev routes — seeding and inspection tools, only active outside production
if (process.env.NODE_ENV !== "production") {
  app.use("/api/dev", devRouter);
  logger.info("[app] Dev routes mounted at /api/dev (NODE_ENV:", process.env.NODE_ENV ?? "development", ")");
}

// ─── Error Handlers (must be registered last) ────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── AI model warm-up ────────────────────────────────────────────────────────
// Load the trained model from Firestore (or file backup) into the in-memory
// cache so the first recommendation request is not delayed by a cold read.
// Non-fatal: failure only means the model stays in its untrained default state.
initModelCache().catch((err) =>
  logger.warn(`[app] AI model init failed: ${err.message} — will use rule-based scoring only`)
);

export default app;
