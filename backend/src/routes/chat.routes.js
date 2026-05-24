/**
 * chat.routes.js — AI chat assistant.
 *
 * Mounted at /api/chat in app.js. All routes require authentication.
 *
 *   POST   /api/chat/message      — send a message, get assistant reply + cards
 *   GET    /api/chat/history      — recent conversation
 *   DELETE /api/chat/history      — clear conversation
 *   GET    /api/chat/suggestions  — quick-prompt chips
 */

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  postMessage,
  getHistory,
  deleteHistory,
  getSuggestions,
} from "../controllers/chat.controller.js";

const router = Router();

router.post("/message", authenticate, postMessage);
router.get("/history", authenticate, getHistory);
router.delete("/history", authenticate, deleteHistory);
router.get("/suggestions", authenticate, getSuggestions);

export default router;
