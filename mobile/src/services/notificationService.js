/**
 * notificationService.js — Intelligent Notification System
 *
 * Handles all notification operations for Wuloye:
 *   - Permission flow (Android channels + iOS permissions)
 *   - Scheduling morning / afternoon / evening / dynamic notifications
 *   - AI-generated personalized content
 *   - Deep link data attached to every notification
 *   - Notification response handling (tap → navigate)
 *   - Frequency throttling to avoid fatigue
 */

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiClient } from "../api/client";
import {
    ensureCustomReminderAndroidChannel,
    deepLinkForReminderCategory,
} from "./customReminderService";

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
    PERMISSION_STATUS: "@wuloye/notification_permission",
    PREFERENCES: "@wuloye/notification_preferences",
    LAST_DYNAMIC: "@wuloye/last_dynamic_notification",
    DYNAMIC_COUNT_TODAY: "@wuloye/dynamic_count_today",
    DYNAMIC_COUNT_DATE: "@wuloye/dynamic_count_date",
    SHOWN_PERMISSION_SCREEN: "@wuloye/shown_notification_permission_screen",
    INBOX: "@wuloye/notification_inbox",
    PUSH_TOKEN: "@wuloye/expo_push_token",
};

const DAILY_NOTIFICATION_TYPES = new Set(["morning", "afternoon", "evening"]);

const INBOX_MAX = 50;

const CHANNELS = {
    MORNING: "wuloye-morning",
    AFTERNOON: "wuloye-afternoon",
    EVENING: "wuloye-evening",
    DYNAMIC: "wuloye-dynamic",
    DEFAULT: "wuloye-default",
};

const MAX_DYNAMIC_PER_DAY = 3;
const MIN_DYNAMIC_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ─── Notification handler (foreground) ───────────────────────────────────────

Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
    }),
});

// ─── Default preferences ─────────────────────────────────────────────────────

export const DEFAULT_PREFERENCES = {
    enabled: true,
    morningEnabled: true,
    morningTime: "08:00",
    afternoonEnabled: true,
    afternoonTime: "12:30",
    eveningEnabled: true,
    eveningTime: "20:00",
    dynamicEnabled: true,
    eventReminders: true,
    recommendationReminders: true,
    sound: true,
    vibration: true,
};

// ─── Android channel setup ────────────────────────────────────────────────────

export async function setupAndroidChannels() {
    if (Platform.OS !== "android") return;

    await Notifications.setNotificationChannelAsync(CHANNELS.MORNING, {
        name: "Morning Briefing",
        description: "Your personalized morning summary and day plan",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#38AEFF",
        sound: "default",
        enableVibrate: true,
        showBadge: false,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.AFTERNOON, {
        name: "Midday Suggestions",
        description: "Lunch and afternoon activity recommendations",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250],
        lightColor: "#26C97A",
        sound: "default",
        enableVibrate: true,
        showBadge: false,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.EVENING, {
        name: "Evening Recap",
        description: "Evening plan and tomorrow's preparation",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200],
        lightColor: "#1A62BA",
        sound: "default",
        enableVibrate: true,
        showBadge: false,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.DYNAMIC, {
        name: "Smart Suggestions",
        description: "Contextual AI-driven recommendations",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100],
        lightColor: "#38AEFF",
        sound: "default",
        enableVibrate: true,
        showBadge: false,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.DEFAULT, {
        name: "General",
        description: "General Wuloye notifications",
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: "default",
        showBadge: false,
    });

    await ensureCustomReminderAndroidChannel();
}

// ─── Permission helpers ───────────────────────────────────────────────────────

/**
 * Returns whether the app has already shown the permission explanation screen.
 */
export async function hasShownPermissionScreen() {
    const val = await AsyncStorage.getItem(
        STORAGE_KEYS.SHOWN_PERMISSION_SCREEN,
    );
    return val === "true";
}

export async function markPermissionScreenShown() {
    await AsyncStorage.setItem(STORAGE_KEYS.SHOWN_PERMISSION_SCREEN, "true");
}

/**
 * Requests notification permissions from the OS.
 * Returns the final PermissionStatus string.
 */
export async function requestNotificationPermissions() {
    if (!Device.isDevice) {
        // Physical device required for push; simulators can schedule local
        console.warn("[Notifications] Running on simulator — push token skipped");
    }

    await setupAndroidChannels();

    const { status: existingStatus } =
        await Notifications.getPermissionsAsync();

    if (existingStatus === "granted") {
        await AsyncStorage.setItem(
            STORAGE_KEYS.PERMISSION_STATUS,
            "granted",
        );
        return "granted";
    }

    const { status } = await Notifications.requestPermissionsAsync({
        ios: {
            allowAlert: true,
            allowBadge: false,
            allowSound: true,
            allowCriticalAlerts: false,
            provideAppNotificationSettings: true,
        },
    });

    await AsyncStorage.setItem(STORAGE_KEYS.PERMISSION_STATUS, status);
    return status;
}

/**
 * Returns the last known permission status (from cache, no OS prompt).
 */
export async function getStoredPermissionStatus() {
    return AsyncStorage.getItem(STORAGE_KEYS.PERMISSION_STATUS);
}

/** Sync permission status from the OS (not just AsyncStorage cache). */
export async function syncPermissionStatusFromOS() {
    const { status } = await Notifications.getPermissionsAsync();
    await AsyncStorage.setItem(STORAGE_KEYS.PERMISSION_STATUS, status);
    return status;
}

// ─── Expo push token registration ────────────────────────────────────────────

function getExpoProjectId() {
    return (
        Constants.expoConfig?.extra?.eas?.projectId ??
        Constants.easConfig?.projectId ??
        null
    );
}

/**
 * Registers this device's Expo push token with the backend.
 * Call after permission is granted and user is authenticated.
 */
export async function registerExpoPushToken() {
    if (!Device.isDevice) {
        console.warn("[Notifications] Push token skipped — not a physical device");
        return null;
    }

    // Android remote push requires google-services.json + native rebuild (FCM).
    // Local reminders/schedules work without it; skip until FCM is configured.
    if (Platform.OS === "android") {
        return null;
    }

    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") return null;

    const projectId = getExpoProjectId();
    if (!projectId) {
        console.warn("[Notifications] Missing EAS projectId — cannot get push token");
        return null;
    }

    try {
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        const expoPushToken = tokenData.data;

        await apiClient.post("/notifications/device-token", {
            expoPushToken,
            platform: Platform.OS,
            deviceName: Device.deviceName ?? "",
            appVersion: Constants.expoConfig?.version ?? "",
        });

        await AsyncStorage.setItem(STORAGE_KEYS.PUSH_TOKEN, expoPushToken);
        console.log("[Notifications] Push token registered:", expoPushToken.slice(0, 30) + "...");
        return expoPushToken;
    } catch (err) {
        const msg = err?.message ?? String(err);
        if (
            msg.includes("FirebaseApp is not initialized") ||
            msg.includes("FCM credentials")
        ) {
            console.warn(
                "[Notifications] Remote push unavailable — Android needs google-services.json + dev client rebuild.\n" +
                "  1. Firebase Console → Project wuloye → Add Android app (com.wuloye.mobile)\n" +
                "  2. Download google-services.json → Wuloye-/mobile/google-services.json\n" +
                "  3. Rebuild: npx expo prebuild --clean && npx expo run:android\n" +
                "  Local reminders still work; admin dashboard push requires this step.",
            );
        } else {
            console.warn("[Notifications] Push token registration failed:", msg);
        }
        return null;
    }
}

/** Remove push token from backend on logout. */
export async function unregisterExpoPushToken() {
    const token = await AsyncStorage.getItem(STORAGE_KEYS.PUSH_TOKEN);
    if (!token) return;
    try {
        await apiClient.delete("/notifications/device-token", {
            data: { expoPushToken: token },
        });
    } catch {
        // Offline-tolerant
    }
    await AsyncStorage.removeItem(STORAGE_KEYS.PUSH_TOKEN);
}

/** Subscribe to Expo token refresh events. Returns cleanup function. */
export function subscribePushTokenRefresh(onRefresh) {
    const sub = Notifications.addPushTokenListener(({ data }) => {
        if (data) onRefresh(data);
    });
    return () => sub.remove();
}

// ─── Preference helpers ───────────────────────────────────────────────────────

/**
 * Loads notification preferences.
 * Merges stored prefs with defaults derived from the user profile's onboarding
 * data (wakeTime → morning, dailyRoutine.lunchTime → afternoon, sleepTime → evening).
 */
export async function loadPreferences(profile = null) {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.PREFERENCES);
    const stored = raw ? JSON.parse(raw) : {};

    // Derive sensible defaults from onboarding data if available
    const onboardingDefaults = {};
    if (profile) {
        if (profile.wakeTime) {
            onboardingDefaults.morningTime = addMinutes(profile.wakeTime, 30);
        }
        const lunchTime = profile.dailyRoutine?.afternoon?.lunchTime;
        if (lunchTime) {
            onboardingDefaults.afternoonTime = lunchTime;
        }
        if (profile.sleepTime) {
            onboardingDefaults.eveningTime = subtractMinutes(
                profile.sleepTime,
                60,
            );
        }
    }

    return {
        ...DEFAULT_PREFERENCES,
        ...onboardingDefaults,
        ...stored,
    };
}

export async function savePreferences(prefs) {
    await AsyncStorage.setItem(STORAGE_KEYS.PREFERENCES, JSON.stringify(prefs));

    // Sync to backend (fire-and-forget — don't block the UI)
    try {
        await apiClient.put("/notifications/preferences", prefs);
    } catch {
        // Offline-tolerant — local storage is source of truth
    }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Parses "HH:mm" into { hour, minute }.
 */
function parseTime(timeStr) {
    const [hour, minute] = (timeStr || "08:00").split(":").map(Number);
    return { hour: isNaN(hour) ? 8 : hour, minute: isNaN(minute) ? 0 : minute };
}

/**
 * Returns the next Date object for a given "HH:mm" time.
 * If that time has already passed today, schedules for tomorrow.
 */
function nextOccurrence(timeStr) {
    const { hour, minute } = parseTime(timeStr);
    const now = new Date();
    const target = new Date();
    target.setHours(hour, minute, 0, 0);
    if (target <= now) {
        target.setDate(target.getDate() + 1);
    }
    return target;
}

function addMinutes(timeStr, mins) {
    const { hour, minute } = parseTime(timeStr);
    const d = new Date();
    d.setHours(hour, minute + mins, 0, 0);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
}

function subtractMinutes(timeStr, mins) {
    return addMinutes(timeStr, -mins);
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/** Cancel only daily briefing schedules — preserves custom reminders. */
export async function cancelDailyScheduledNotifications() {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
        all
            .filter((n) =>
                DAILY_NOTIFICATION_TYPES.has(n.content?.data?.type),
            )
            .map((n) =>
                Notifications.cancelScheduledNotificationAsync(n.identifier),
            ),
    );
}

/** @deprecated Prefer cancelDailyScheduledNotifications to preserve reminders. */
export async function cancelAllScheduled() {
    await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * Schedules the three daily notifications (morning / afternoon / evening)
 * using the user's stored preferences. Each is a repeating daily trigger.
 *
 * @param {object} prefs — result of loadPreferences()
 * @param {object} content — { morning, afternoon, evening } each with { title, body, data }
 */
export async function scheduleDailyNotifications(prefs, content) {
    await cancelDailyScheduledNotifications();

    const scheduled = [];

    if (prefs.morningEnabled && prefs.enabled) {
        const id = await scheduleDailyAt(
            prefs.morningTime,
            {
                title: content.morning.title,
                body: content.morning.body,
                data: { ...content.morning.data, type: "morning" },
            },
            CHANNELS.MORNING,
        );
        scheduled.push({ type: "morning", id });
    }

    if (prefs.afternoonEnabled && prefs.enabled) {
        const id = await scheduleDailyAt(
            prefs.afternoonTime,
            {
                title: content.afternoon.title,
                body: content.afternoon.body,
                data: { ...content.afternoon.data, type: "afternoon" },
            },
            CHANNELS.AFTERNOON,
        );
        scheduled.push({ type: "afternoon", id });
    }

    if (prefs.eveningEnabled && prefs.enabled) {
        const id = await scheduleDailyAt(
            prefs.eveningTime,
            {
                title: content.evening.title,
                body: content.evening.body,
                data: { ...content.evening.data, type: "evening" },
            },
            CHANNELS.EVENING,
        );
        scheduled.push({ type: "evening", id });
    }

    return scheduled;
}

async function scheduleDailyAt(timeStr, notifContent, channelId) {
    const { hour, minute } = parseTime(timeStr);

    const id = await Notifications.scheduleNotificationAsync({
        content: {
            title: notifContent.title,
            body: notifContent.body,
            data: notifContent.data ?? {},
            sound: true,
            ...(Platform.OS === "android" && { channelId }),
        },
        trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour,
            minute,
        },
    });

    return id;
}

/**
 * Sends a single immediate dynamic notification (throttled).
 */
export async function sendDynamicNotification(notifContent, prefs) {
    if (!prefs?.dynamicEnabled || !prefs?.enabled) return null;

    // Throttle: max MAX_DYNAMIC_PER_DAY per day
    const todayStr = new Date().toDateString();
    const countDate = await AsyncStorage.getItem(
        STORAGE_KEYS.DYNAMIC_COUNT_DATE,
    );
    let count = 0;

    if (countDate === todayStr) {
        const raw = await AsyncStorage.getItem(
            STORAGE_KEYS.DYNAMIC_COUNT_TODAY,
        );
        count = parseInt(raw ?? "0", 10);
    } else {
        await AsyncStorage.setItem(STORAGE_KEYS.DYNAMIC_COUNT_DATE, todayStr);
    }

    if (count >= MAX_DYNAMIC_PER_DAY) return null;

    // Throttle: min MIN_DYNAMIC_INTERVAL_MS between dynamic notifs
    const lastRaw = await AsyncStorage.getItem(STORAGE_KEYS.LAST_DYNAMIC);
    if (lastRaw) {
        const elapsed = Date.now() - parseInt(lastRaw, 10);
        if (elapsed < MIN_DYNAMIC_INTERVAL_MS) return null;
    }

    const id = await Notifications.scheduleNotificationAsync({
        content: {
            title: notifContent.title,
            body: notifContent.body,
            data: { ...notifContent.data, type: "dynamic" },
            sound: true,
            ...(Platform.OS === "android" && { channelId: CHANNELS.DYNAMIC }),
        },
        trigger: null, // immediate
    });

    await AsyncStorage.setItem(STORAGE_KEYS.LAST_DYNAMIC, String(Date.now()));
    await AsyncStorage.setItem(
        STORAGE_KEYS.DYNAMIC_COUNT_TODAY,
        String(count + 1),
    );

    return id;
}

// ─── Content generation ───────────────────────────────────────────────────────

/**
 * Asks the backend (which calls the AI service) to generate personalized
 * notification content. Falls back to template content on failure.
 */
export async function generateNotificationContent(profile, type = "all") {
    try {
        const res = await apiClient.get("/notifications/generate", {
            params: { type },
        });
        return res.data?.data ?? null;
    } catch {
        return buildTemplateContent(profile, type);
    }
}

/**
 * Rule-based fallback content when the AI service is unreachable.
 */
function buildTemplateContent(profile, type) {
    const name = profile?.name?.split(" ")[0] || "there";
    const hour = new Date().getHours();

    if (type === "morning" || type === "all") {
        const morning = {
            title: `Good morning, ${name} ☀️`,
            body: buildMorningBody(profile),
            data: { deepLink: "wuloye://schedule" },
        };
        if (type === "morning") return morning;
        return {
            morning,
            afternoon: buildAfternoonTemplate(profile, name),
            evening: buildEveningTemplate(profile, name),
        };
    }

    if (type === "afternoon") return buildAfternoonTemplate(profile, name);
    if (type === "evening") return buildEveningTemplate(profile, name);

    return {
        morning: {
            title: `Good morning, ${name}`,
            body: buildMorningBody(profile),
            data: { deepLink: "wuloye://schedule" },
        },
        afternoon: buildAfternoonTemplate(profile, name),
        evening: buildEveningTemplate(profile, name),
    };
}

function buildMorningBody(profile) {
    const activities = profile?.dailyRoutine?.morning?.activities ?? [];
    if (activities.length > 0) {
        const act = activities[0];
        return `Your ${act} is scheduled this morning. Today's plan is ready.`;
    }
    const interests = profile?.interests ?? [];
    if (interests.includes("coffee") || interests.includes("cafe")) {
        return "Your AI assistant has your morning sorted. Tap for today's plan.";
    }
    return "Your personalized day plan is ready. Tap to see what's ahead.";
}

function buildAfternoonTemplate(profile, name) {
    const lunchType = profile?.dailyRoutine?.afternoon?.lunchType ?? "restaurant";
    const budget = profile?.budgetRange ?? "medium";
    const body =
        budget === "low"
            ? "A budget-friendly lunch spot matching your taste is nearby."
            : "A great lunch spot matching your routine is close by.";
    return {
        title: `Midday, ${name}`,
        body,
        data: { deepLink: "wuloye://discover?category=restaurant" },
    };
}

function buildEveningTemplate(profile, name) {
    const eventInterests = profile?.eventInterests ?? [];
    const body =
        eventInterests.length > 0
            ? `An event matching your interests is happening tonight.`
            : "Wind down with a personalized evening suggestion from your AI.";
    return {
        title: `Good evening, ${name}`,
        body,
        data: { deepLink: "wuloye://home" },
    };
}

// ─── In-app notification inbox (badge + list) ────────────────────────────────

function normalizeInboxEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
        id: String(raw.id ?? ""),
        title: String(raw.title ?? "Wuloye"),
        body: String(raw.body ?? ""),
        data:
            raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
                ? raw.data
                : {},
        receivedAt: String(raw.receivedAt ?? new Date().toISOString()),
        read: Boolean(raw.read),
    };
}

export async function loadNotificationInbox() {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.INBOX);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeInboxEntry).filter(Boolean);
    } catch {
        return [];
    }
}

export function countUnreadInbox(items) {
    if (!Array.isArray(items)) return 0;
    return items.filter((e) => !e.read).length;
}

/**
 * Persist one notification (foreground / background delivery) for the in-app inbox.
 */
export async function appendNotificationToInbox(notification) {
    const request = notification?.request;
    if (!request?.content) return loadNotificationInbox();

    const content = request.content;
    const id =
        request.identifier && String(request.identifier).length > 0
            ? String(request.identifier)
            : `wuloye-${Date.now()}`;

    const entry = {
        id,
        title: content.title ? String(content.title) : "Wuloye",
        body: content.body ? String(content.body) : "",
        data:
            content.data &&
            typeof content.data === "object" &&
            !Array.isArray(content.data)
                ? { ...content.data }
                : {},
        receivedAt: new Date().toISOString(),
        read: false,
    };

    const prev = await loadNotificationInbox();
    const merged = [entry, ...prev.filter((e) => e.id !== entry.id)].slice(
        0,
        INBOX_MAX,
    );
    await AsyncStorage.setItem(STORAGE_KEYS.INBOX, JSON.stringify(merged));
    return merged;
}

/**
 * Merge notifications still in the system tray into the inbox (deduped by id).
 */
export async function mergePresentedNotificationsIntoInbox() {
    let presented = [];
    try {
        presented = await Notifications.getPresentedNotificationsAsync();
    } catch {
        return loadNotificationInbox();
    }

    for (const n of presented) {
        await appendNotificationToInbox(n);
    }
    return loadNotificationInbox();
}

export async function markInboxNotificationRead(id) {
    const list = await loadNotificationInbox();
    const next = list.map((e) =>
        e.id === id ? { ...e, read: true } : e,
    );
    await AsyncStorage.setItem(STORAGE_KEYS.INBOX, JSON.stringify(next));
    return next;
}

export async function markAllInboxNotificationsRead() {
    const list = await loadNotificationInbox();
    const next = list.map((e) => ({ ...e, read: true }));
    await AsyncStorage.setItem(STORAGE_KEYS.INBOX, JSON.stringify(next));
    return next;
}

export async function clearInboxNotification(id) {
    const list = await loadNotificationInbox();
    const next = list.filter((e) => e.id !== id);
    await AsyncStorage.setItem(STORAGE_KEYS.INBOX, JSON.stringify(next));
    return next;
}

// ─── Notification response handler ────────────────────────────────────────────

/**
 * Target screen + params from notification `data` payload (deep link or type).
 * @returns {{ screen: string, params?: object } | null}
 */
export function extractNavigationFromData(data) {
    if (!data || typeof data !== "object") return null;

    const deepLink = data.deepLink;
    if (deepLink) {
        return parseDeepLink(deepLink);
    }

    switch (data.type) {
        case "morning":
            return { screen: "YourSchedule", params: {} };
        case "afternoon":
            return { screen: "Discover", params: {} };
        case "evening":
            return { screen: "Home", params: {} };
        case "dynamic":
            if (data.placeId) {
                return {
                    screen: "PlaceDetail",
                    params: { placeId: data.placeId },
                };
            }
            if (data.eventId) {
                return {
                    screen: "EventDetail",
                    params: { eventId: data.eventId },
                };
            }
            return { screen: "Discover", params: {} };
        case "custom_reminder": {
            const link =
                typeof data.deepLink === "string"
                    ? data.deepLink
                    : deepLinkForReminderCategory(data.category);
            return parseDeepLink(link) ?? { screen: "Reminders", params: {} };
        }
        case "announcement":
        case "info":
        case "warning":
        case "maint":
        case "maintenance":
        case "promo":
        case "promotional":
            return parseDeepLink(data.deepLink) ?? { screen: "Home", params: {} };
        default:
            return { screen: "Home", params: {} };
    }
}

/**
 * Extracts deep-link navigation params from a notification response.
 * Returns { screen, params } or null.
 */
export function extractNavigationFromResponse(response) {
    const data = response?.notification?.request?.content?.data;
    return extractNavigationFromData(data);
}

/**
 * Maps notification navigation targets to the route param shapes our screens expect.
 */
export function normalizeNavigateTarget(target) {
    if (!target?.screen) return null;
    const { screen, params = {} } = target;

    if (screen === "PlaceDetail") {
        const pid = params.placeId ?? params.place?.placeId ?? params.place?.id;
        if (pid) {
            return {
                screen: "PlaceDetail",
                params: { place: { placeId: String(pid) } },
            };
        }
    }

    if (screen === "EventDetail") {
        const eid = params.eventId ?? params.event?.id;
        if (eid) {
            return {
                screen: "EventDetail",
                params: { event: { id: String(eid) } },
            };
        }
    }

    return { screen, params };
}

/**
 * Parses a wuloye:// deep link into { screen, params }.
 */
export function parseDeepLink(url) {
    if (!url) return null;

    const withoutScheme = url.replace(/^wuloye:\/\//, "");
    const [pathPart, queryPart] = withoutScheme.split("?");
    const segments = pathPart.split("/").filter(Boolean);
    const query = {};
    if (queryPart) {
        queryPart.split("&").forEach((pair) => {
            const [k, v] = pair.split("=");
            query[k] = decodeURIComponent(v ?? "");
        });
    }

    const route = segments[0];
    const param = segments[1];

    switch (route) {
        case "home":
            return { screen: "Home", params: {} };
        case "schedule":
            return { screen: "YourSchedule", params: {} };
        case "discover":
            return {
                screen: "Discover",
                params: { category: query.category },
            };
        case "events":
            return { screen: "Events", params: {} };
        case "place":
            return {
                screen: "PlaceDetail",
                params: { placeId: param ?? query.id },
            };
        case "event":
            return {
                screen: "EventDetail",
                params: { eventId: param ?? query.id },
            };
        case "recommendations":
            return {
                screen: "ActivityRecommendations",
                params: { category: query.category },
            };
        case "saved":
            return { screen: "SavedPlaces", params: {} };
        case "reminders":
            return { screen: "Reminders", params: {} };
        case "trending":
            return { screen: "Trending", params: {} };
        case "profile":
            return { screen: "Profile", params: {} };
        default:
            return { screen: "Home", params: {} };
    }
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function logNotificationInteraction(notifId, action, data = {}) {
    try {
        await apiClient.post("/notifications/interaction", {
            notificationId: notifId,
            action,
            ...data,
        });
    } catch {
        // Fire-and-forget analytics — never block UX
    }
}
