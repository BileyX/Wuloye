/**
 * pushToken.service.js — Expo push token registration & lifecycle.
 *
 * Collection: device_tokens/{tokenKey}
 *   tokenKey = sanitized Expo push token (safe as doc id)
 */

import { db } from "../config/firebase.js";
import { logger } from "../utils/logger.js";

export const DEVICE_TOKENS_COLLECTION = "device_tokens";

const tokenDocId = (expoPushToken) =>
  String(expoPushToken).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);

/**
 * Register or refresh a device push token for the authenticated user.
 */
export async function registerDeviceToken(uid, {
  expoPushToken,
  platform = "unknown",
  deviceName = "",
  appVersion = "",
} = {}) {
  if (!uid || !expoPushToken) {
    const err = new Error("uid and expoPushToken are required");
    err.statusCode = 400;
    throw err;
  }

  if (!expoPushToken.startsWith("ExponentPushToken[") && !expoPushToken.startsWith("ExpoPushToken[")) {
    const err = new Error("Invalid Expo push token format");
    err.statusCode = 400;
    throw err;
  }

  const id = tokenDocId(expoPushToken);
  const now = new Date().toISOString();
  const ref = db.collection(DEVICE_TOKENS_COLLECTION).doc(id);
  const existing = await ref.get();

  const doc = {
    id,
    userId: uid,
    expoPushToken,
    platform,
    deviceName,
    appVersion,
    active: true,
    lastSeenAt: now,
    updatedAt: now,
    ...(existing.exists ? {} : { createdAt: now }),
  };

  await ref.set(doc, { merge: true });
  logger.info(`[pushToken] registered uid=${uid} platform=${platform}`);
  return doc;
}

/**
 * Deactivate token on logout or when user disables push.
 */
export async function deactivateDeviceToken(uid, expoPushToken) {
  if (!expoPushToken) return;
  const id = tokenDocId(expoPushToken);
  const ref = db.collection(DEVICE_TOKENS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (snap.data().userId !== uid) return;
  await ref.update({ active: false, updatedAt: new Date().toISOString() });
}

/** List active tokens for one user. */
export async function getTokensForUser(uid) {
  const snap = await db.collection(DEVICE_TOKENS_COLLECTION)
    .where("userId", "==", uid)
    .limit(20)
    .get();
  return snap.docs
    .map((d) => d.data())
    .filter((t) => t.active !== false && t.expoPushToken);
}

/** All active tokens (for admin broadcast). */
export async function getAllActiveTokens() {
  const snap = await db.collection(DEVICE_TOKENS_COLLECTION).limit(5000).get();
  return snap.docs
    .map((d) => d.data())
    .filter((t) => t.active !== false && t.expoPushToken);
}

/** Mark tokens invalid after Expo reports DeviceNotRegistered. */
export async function deactivateTokensByValue(tokens = []) {
  await Promise.all(
    tokens.map(async (expoPushToken) => {
      const id = tokenDocId(expoPushToken);
      try {
        await db.collection(DEVICE_TOKENS_COLLECTION).doc(id).update({
          active: false,
          invalidatedAt: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    }),
  );
}

/** Count active registered devices. */
export async function countActiveDevices() {
  const tokens = await getAllActiveTokens();
  const users = new Set(tokens.map((t) => t.userId));
  return { devices: tokens.length, users: users.size };
}
