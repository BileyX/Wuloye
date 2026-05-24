/**
 * pushNotification.service.js — Expo Push API delivery engine.
 */

import Expo from "expo-server-sdk";
import { db } from "../config/firebase.js";
import { logger } from "../utils/logger.js";
import {
  getAllActiveTokens,
  deactivateTokensByValue,
} from "./pushToken.service.js";
import { getNotificationPreferences } from "./notification.service.js";

const expo = new Expo();

const BATCH_SIZE = 100;

function matchesUserTargeting(profile, targeting = {}) {
  if (!targeting || Object.keys(targeting).length === 0) return true;

  if (targeting.religion) {
    const allowed = Array.isArray(targeting.religion) ? targeting.religion : [targeting.religion];
    const userRel = (profile.religion || "").toLowerCase();
    if (userRel && !allowed.some((r) => r.toLowerCase() === userRel)) return false;
  }

  if (targeting.budgetRange || targeting.budget) {
    const allowed = Array.isArray(targeting.budgetRange || targeting.budget)
      ? (targeting.budgetRange || targeting.budget)
      : [targeting.budgetRange || targeting.budget];
    const userBudget = (profile.budgetRange || profile.weeklyBudgetTier || "").toLowerCase();
    if (userBudget) {
      const norm = userBudget.includes("cheap") ? "cheap"
        : userBudget.includes("expens") ? "expensive"
        : userBudget.includes("mid") ? "medium"
        : userBudget;
      if (!allowed.some((b) => String(b).toLowerCase().includes(norm) || norm.includes(String(b).toLowerCase()))) {
        return false;
      }
    }
  }

  if (targeting.city) {
    const userCity = (profile.city || profile.location?.city || "").toLowerCase();
    if (userCity && !userCity.includes(String(targeting.city).toLowerCase())) return false;
  }

  return true;
}

async function filterTokensByTargeting(tokens, targeting) {
  if (!targeting || Object.keys(targeting).length === 0) return tokens;

  const userIds = [...new Set(tokens.map((t) => t.userId))];
  const profiles = new Map();

  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const snap = await db.collection("users").doc(uid).get();
        if (snap.exists) profiles.set(uid, snap.data());
      } catch { /* skip */ }
    }),
  );

  return tokens.filter((t) => {
    const profile = profiles.get(t.userId);
    if (!profile) return false;
    return matchesUserTargeting(profile, targeting);
  });
}

async function filterTokensByPreferences(tokens, type) {
  const promoTypes = new Set(["promo", "promotional", "marketing"]);
  if (!promoTypes.has(String(type).toLowerCase())) return tokens;

  const result = [];
  for (const t of tokens) {
    try {
      const prefs = await getNotificationPreferences(t.userId);
      if (prefs.enabled !== false) result.push(t);
    } catch {
      result.push(t);
    }
  }
  return result;
}

/**
 * Send push notifications to Expo tokens in batches.
 */
export async function sendExpoPushMessages(messages) {
  const valid = messages.filter((m) => Expo.isExpoPushToken(m.to));
  if (!valid.length) {
    return { sent: 0, failed: 0, invalidTokens: [] };
  }

  const chunks = expo.chunkPushNotifications(valid);
  let sent = 0;
  let failed = 0;
  const invalidTokens = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        if (receipt.status === "ok") {
          sent++;
        } else {
          failed++;
          const token = chunk[i]?.to;
          if (receipt.details?.error === "DeviceNotRegistered" && token) {
            invalidTokens.push(token);
          }
        }
      }
    } catch (err) {
      logger.warn(`[push] chunk send failed: ${err.message}`);
      failed += chunk.length;
    }
  }

  if (invalidTokens.length) {
    await deactivateTokensByValue(invalidTokens);
  }

  return { sent, failed, invalidTokens };
}

/**
 * Admin broadcast — send to all (or targeted) active devices.
 */
export async function sendAdminPushBroadcast({
  title,
  body,
  type = "announcement",
  deepLink = "wuloye://home",
  subtitle = "",
  imageUrl = null,
  notificationId = null,
  targeting = null,
}) {
  let tokens = await getAllActiveTokens();
  tokens = await filterTokensByTargeting(tokens, targeting);
  tokens = await filterTokensByPreferences(tokens, type);

  if (!tokens.length) {
    return { sent: 0, failed: 0, targetedDevices: 0, invalidTokens: [] };
  }

  const messages = tokens.map((t) => ({
    to: t.expoPushToken,
    sound: "default",
    title: subtitle ? `${title}` : title,
    subtitle: subtitle || undefined,
    body,
    data: {
      type,
      deepLink,
      notificationId: notificationId ?? null,
      adminBroadcast: true,
    },
    ...(imageUrl ? { richContent: { image: imageUrl } } : {}),
    channelId: "wuloye-default",
  }));

  const stats = await sendExpoPushMessages(messages);
  return { ...stats, targetedDevices: tokens.length };
}
