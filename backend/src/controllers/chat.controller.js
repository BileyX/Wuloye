/**
 * chat.controller.js — AI chat assistant HTTP handlers.
 */

import {
  sendChatMessage,
  getChatHistory,
  clearChatHistory,
  getDefaultSuggestions,
} from "../services/chat.service.js";
import { getUserById } from "../services/user.service.js";

export async function postMessage(req, res, next) {
  try {
    const { uid } = req.user;
    const { message, location } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        data: null,
        message: "Field 'message' (string) is required",
      });
    }

    const result = await sendChatMessage(uid, message, { location: location || null });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req, res, next) {
  try {
    const { uid } = req.user;
    const limit = Math.min(parseInt(req.query.limit ?? "30", 10), 100);
    const history = await getChatHistory(uid, limit);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
}

export async function deleteHistory(req, res, next) {
  try {
    const { uid } = req.user;
    const result = await clearChatHistory(uid);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getSuggestions(req, res, next) {
  try {
    const { uid } = req.user;
    const profile = await getUserById(uid).catch(() => null);
    const suggestions = getDefaultSuggestions(profile ?? {});
    res.json({ success: true, data: { suggestions } });
  } catch (err) {
    next(err);
  }
}
