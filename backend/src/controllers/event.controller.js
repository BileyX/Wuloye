/**
 * event.controller.js — HTTP handlers for the events resource.
 *
 * Routes (mounted at /api/events):
 *   GET  /                 — list events with optional filters
 *   GET  /recommended      — AI-personalised event list for the authed user
 *   GET  /:id              — single event by ID
 *   PATCH /:id             — admin: edit event fields
 *   DELETE /:id            — admin: delete event
 *   PATCH /:id/featured    — admin: toggle featured flag
 */

import {
  getAllEvents,
  getEventById,
  getEventCandidates,
  createEvent,
  updateEvent,
  deleteEvent,
  setEventFeatured,
  countEvents,
} from "../services/event.service.js";
import { getUserById }              from "../services/user.service.js";
import { getInteractionsByUser }    from "../services/interaction.service.js";
import { logger }                   from "../utils/logger.js";
import {
  sortEventsByTrustAndDate,
  prioritizeTrustedSources,
} from "../utils/eventSourcePriority.js";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const AI_SERVICE_ENABLED = process.env.AI_SERVICE_ENABLED !== "false";

// ─── Personalised recommendation cache (per user, 3-minute TTL) ─────────────
const RECO_TTL_MS = 3 * 60 * 1000;
const recoCache = new Map(); // uid -> { t, payload }
const recoCacheGet = (uid) => {
  const hit = recoCache.get(uid);
  if (!hit) return null;
  if (Date.now() - hit.t > RECO_TTL_MS) {
    recoCache.delete(uid);
    return null;
  }
  return hit.payload;
};
const recoCacheSet = (uid, payload) => recoCache.set(uid, { t: Date.now(), payload });

/**
 * Map Discover-style place-type affinities → event category affinities so that
 * a user who frequently visits gyms gets a "fitness" / "sports" event affinity.
 *
 * The Discover system tracks affinities for place types ("gym", "outdoor", …)
 * while the event ranker expects event category names ("fitness", "sports", …).
 * Without this bridge, typeAffinity is always 0 for every event category.
 */
const PLACE_TO_EVENT_CATEGORY = {
  gym:       ["fitness", "sports"],
  outdoor:   ["sports", "fitness", "social"],
  park:      ["social", "sports"],
  cafe:      ["social", "food"],
  social:    ["social"],
  workspace: ["tech", "business", "education"],
  hotel:     ["social", "food", "business"],
  walk:      ["social"],
  cinema:    ["art", "social"],
  study:     ["education"],
  restaurant:["food", "social"],
  museum:    ["art", "education"],
  gallery:   ["art"],
  church:    ["church"],
  mosque:    ["church"],
  sports:    ["sports", "fitness"],
  market:    ["food", "social"],
};

const bridgeTypeAffinityToEvents = (typeAffinity) => {
  if (!typeAffinity || typeof typeAffinity !== "object") return {};
  const result = {};
  for (const [placeType, score] of Object.entries(typeAffinity)) {
    const cats = PLACE_TO_EVENT_CATEGORY[String(placeType).toLowerCase()] || [];
    for (const cat of cats) {
      result[cat] = Math.max(result[cat] || 0, Number(score) || 0);
    }
  }
  return result;
};

/**
 * Build an InteractionMemory blob from a user's recent interactions
 * to send to the AI ranker.
 */
const buildInteractionMemory = (interactions, candidatesById) => {
  const memory = {
    saved_event_ids:      [],
    dismissed_event_ids:  [],
    opened_event_ids:     [],
    liked_categories:     {},
    dismissed_categories: {},
  };
  if (!Array.isArray(interactions) || !interactions.length) return memory;

  const savedSet = new Set();
  const dismissedSet = new Set();
  const openedSet = new Set();

  for (const it of interactions) {
    const placeId = String(it.placeId || "");
    const action = String(it.actionType || "");
    if (!placeId || !candidatesById.has(placeId)) {
      // We still want to track category-level signals even if the event has rolled out
      // of the candidate window, so don't skip here.
    }
    const cat =
      (candidatesById.get(placeId)?.category || it?.metadata?.category || "")
        .toString()
        .toLowerCase();

    if (["save", "like", "join_event"].includes(action)) {
      if (placeId) savedSet.add(placeId);
      if (cat) memory.liked_categories[cat] = (memory.liked_categories[cat] || 0) + 1;
    } else if (["dismiss", "dislike", "not_interested", "remove_save", "skip"].includes(action)) {
      if (placeId) dismissedSet.add(placeId);
      if (cat) memory.dismissed_categories[cat] = (memory.dismissed_categories[cat] || 0) + 1;
    } else if (["open_event", "click", "view_long"].includes(action)) {
      if (placeId) openedSet.add(placeId);
      if (cat) memory.liked_categories[cat] = (memory.liked_categories[cat] || 0) + 0.3;
    }
  }

  memory.saved_event_ids     = Array.from(savedSet).slice(0, 80);
  memory.dismissed_event_ids = Array.from(dismissedSet).slice(0, 80);
  memory.opened_event_ids    = Array.from(openedSet).slice(0, 80);

  // Normalise category boosts to a 0..1 band
  const norm = (obj) => {
    const max = Math.max(0, ...Object.values(obj));
    if (max <= 0) return obj;
    for (const k of Object.keys(obj)) obj[k] = obj[k] / max;
    return obj;
  };
  memory.liked_categories     = norm(memory.liked_categories);
  memory.dismissed_categories = norm(memory.dismissed_categories);
  return memory;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ok = (res, data, status = 200) => res.status(status).json(data);
const fail = (res, status, message) => res.status(status).json({ error: message });

/** Express may stringify `category` as a string or (rarely) an array — normalize once. */
const normalizeCategoryQuery = (raw) => {
  if (raw == null || raw === "") return undefined;
  const piece =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.length
        ? String(raw[0])
        : "";
  const trimmed = piece.trim().toLowerCase();
  return trimmed || undefined;
};

// ─── GET /api/events ──────────────────────────────────────────────────────────

// ─── Haversine distance (km) ─────────────────────────────────────────────────
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const getEventsHandler = async (req, res, next) => {
  try {
    const { category, dateFrom, dateTo, location, limit, lat, lng, refresh } = req.query;
    const filters = {
      category: normalizeCategoryQuery(category),
      dateFrom,
      dateTo,
      location,
      noCache: refresh === "1" || refresh === "true",
      // Cap high enough for admin dashboards; getAllEvents clamps in the service layer too.
      limit: limit ? Math.min(parseInt(limit, 10) || 50, 500) : 50,
    };

    let events = await getAllEvents(filters);

    // Chapa Events and other trusted platforms always appear before Telegram scrapes.
    events = prioritizeTrustedSources(sortEventsByTrustAndDate(events), 90);

    // Sort by proximity when user sends coordinates — Chapa rows stay pinned at top.
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    if (!isNaN(userLat) && !isNaN(userLng)) {
      const chapaFirst = events.filter((e) =>
        String(e.source || "").toLowerCase().includes("chapa"),
      );
      const chapaIds = new Set(chapaFirst.map((e) => e.id));
      const remainder = events.filter((e) => !chapaIds.has(e.id));

      const sortByDist = (list) =>
        list
          .map((e) => {
            const coords = e.coordinates;
            const distKm =
              coords?.lat && coords?.lng
                ? haversine(userLat, userLng, coords.lat, coords.lng)
                : 9999;
            return { ...e, _distKm: distKm };
          })
          .sort((a, b) => a._distKm - b._distKm)
          .map(({ _distKm, ...e }) => e);

      events = [...chapaFirst, ...sortByDist(remainder)];
    }

    return ok(res, { events, total: events.length });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/events/recommended ─────────────────────────────────────────────

export const getRecommendedEventsHandler = async (req, res, next) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return fail(res, 401, "Authentication required");

    const cached = recoCacheGet(uid);
    if (cached) return ok(res, cached);

    // ── Fetch candidates + profile + interactions IN PARALLEL ─────────────────
    const [candidatesResult, profileResult, interactionsResult] = await Promise.allSettled([
      getEventCandidates(80),
      getUserById(uid),
      getInteractionsByUser(uid, 60),
    ]);

    const candidates =
      candidatesResult.status === "fulfilled" ? (candidatesResult.value || []) : [];

    if (!candidates.length) {
      const payload = { events: [] };
      recoCacheSet(uid, payload);
      return ok(res, payload);
    }

    const rawProfile =
      profileResult.status === "fulfilled" ? profileResult.value : null;
    if (profileResult.status === "rejected") {
      logger.warn(`[events/recommended] profile fetch failed: ${profileResult.reason?.message}`);
    }

    const rawInteractions =
      interactionsResult.status === "fulfilled" ? interactionsResult.value : [];
    if (interactionsResult.status === "rejected") {
      logger.warn(`[events/recommended] interactions fetch failed: ${interactionsResult.reason?.message}`);
    }

    // ── Build user profile ─────────────────────────────────────────────────────
    let budgetTier = "";
    const weekly = rawProfile?.weeklyBudget;
    if (typeof weekly === "number" && weekly > 0) {
      if (weekly <= 2000)       budgetTier = "cheap";
      else if (weekly <= 10000) budgetTier = "mid";
      else                      budgetTier = "expensive";
    } else {
      const label = (rawProfile?.budgetRange || "").toLowerCase().trim();
      if (["cheap", "low", "budget", "affordable"].includes(label)) budgetTier = "cheap";
      else if (["expensive", "high", "luxury", "premium", "flexible"].includes(label)) budgetTier = "expensive";
      else if (label) budgetTier = "mid";
    }

    // Merge place-type affinities into event-category affinities so the ranker
    // receives useful signals even before the user has any event history.
    const placeAffinity  = rawProfile?.typeAffinity || {};
    const eventAffinity  = bridgeTypeAffinityToEvents(placeAffinity);
    // Let explicit event typeAffinity (if any) override the bridge values.
    const mergedAffinity = { ...eventAffinity, ...placeAffinity };

    // Merge dailyRoutine activities into weeklyActivities for the AI ranker
    const dailyRoutine  = rawProfile?.dailyRoutine || {};
    const routineActs   = Object.values(dailyRoutine).flat().filter((v) => typeof v === "string");
    const weeklyActs    = Array.isArray(rawProfile?.weeklyActivities) ? rawProfile.weeklyActivities : [];
    const mergedActivities = [...new Set([...weeklyActs, ...routineActs])];

    const userProfile = {
      interests:         Array.isArray(rawProfile?.interests)         ? rawProfile.interests         : [],
      typeAffinity:      mergedAffinity,
      religion:          rawProfile?.religion          || "",
      gender:            rawProfile?.gender            || "",
      weekendPreference: rawProfile?.weekendPreference || "",
      eventInterests:    Array.isArray(rawProfile?.eventInterests)    ? rawProfile.eventInterests    : [],
      weeklyActivities:  mergedActivities,
      dailyRoutine,
      budgetTier,
      weeklyBudget:      typeof rawProfile?.weeklyBudget === "number" ? rawProfile.weeklyBudget : 0,
    };

    // ── Budget pre-filter: hard-block luxury events for cheap-budget users ───────
    // This runs before the AI ranker to reduce candidate noise and protect UX.
    const parsePriceEtb = (ticket) => {
      if (!ticket) return null;
      const t = String(ticket).toLowerCase();
      if (t === "free" || t === "free entry") return 0;
      const m = t.match(/([\d][\d,.]*)/);
      if (!m) return null;
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(val)) return null;
      if (t.includes("usd") || t.includes("$")) return val * 130;
      return val;
    };
    const budgetFilteredCandidates = budgetTier === "cheap"
      ? candidates.filter((e) => {
          const etb = parsePriceEtb(e.ticket_price || e.ticketPrice);
          if (etb === null) {
            // No price info — exclude only if clearly "expensive" tier
            return (e.price_tier || e.priceTier || "").toLowerCase() !== "expensive";
          }
          return etb <= 2500; // keep under ETB 2500 for cheap users
        })
      : candidates;

    // Always keep at least 20 events even if budget filter is aggressive
    const filteredCandidates = budgetFilteredCandidates.length >= 20
      ? budgetFilteredCandidates
      : candidates;

    // ── Build interaction memory ───────────────────────────────────────────────
    const candidatesById = new Map(filteredCandidates.map((c) => [c.id, c]));
    const memory = buildInteractionMemory(rawInteractions, candidatesById);

    // ── AI ranking ────────────────────────────────────────────────────────────
    if (AI_SERVICE_ENABLED) {
      try {
        const body = {
          user_id: uid,
          user_profile: userProfile,
          memory,
          events: filteredCandidates.map((e) => ({
            id:           e.id,
            title:        e.title        || "",
            category:     e.category     || "other",
            date:         e.date         || "",
            location:     e.location     || "",
            description: (e.description  || "").slice(0, 500),
            image:        e.image        || "",
            source_url:   e.source_url   || "",
            booking_url:  e.booking_url  || e.source_url || "",
            source:       e.source       || "",
            is_paid:      Boolean(e.isPaid    || e.is_paid),
            price_tier:   e.priceTier    || e.price_tier || "",
            ticket_price: e.ticketPrice  || e.ticket_price || "",
            organizer:    e.organizer    || "",
            is_featured:  Boolean(e.is_featured),
          })),
        };

        const resp = await fetch(`${AI_SERVICE_URL}/events/rank`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });

        if (resp.ok) {
          const { ranked } = await resp.json();
          const allRanked = ranked || [];

          // Only hard-block events with strong negative signals (religion mismatch,
          // explicit dismissal). Do NOT filter by minimum score — the ranker produces
          // low baselines when the user has no event history yet.
          const visible = allRanked.filter((r) => (r.score ?? 0) > 0.04);

          // Always guarantee at least some events by falling back to the full sorted list.
          const source = visible.length >= 3 ? visible : allRanked;
          const top = source.slice(0, 15).map((r) => {
            const base = candidatesById.get(r.id) || {};
            return {
              ...base,
              ...r,
              explain:     r.explain     || "",
              reasons:     Array.isArray(r.reasons) ? r.reasons : [],
              recommended: (r.score ?? 0) >= 0.35,
            };
          });

          // Pin Chapa / Eventbrite / Meetup ahead of Telegram in the reco feed.
          const payload = { events: prioritizeTrustedSources(top, 90) };
          recoCacheSet(uid, payload);
          return ok(res, payload);
        }
      } catch (aiErr) {
        logger.warn(`[events/recommended] AI service error: ${aiErr.message} — falling back`);
      }
    }

    // ── Fallback: sort by created_at desc and take top 15 ─────────────────────
    const sorted = prioritizeTrustedSources(
      [...filteredCandidates].sort((a, b) => {
        const ta = a.scraped_at || a.created_at || a.date || "";
        const tb = b.scraped_at || b.created_at || b.date || "";
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      }),
      90,
    ).slice(0, 15);

    const payload = { events: sorted };
    recoCacheSet(uid, payload);
    return ok(res, payload);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/events/stats ────────────────────────────────────────────────────

export const getEventsStatsHandler = async (req, res, next) => {
  try {
    const total = await countEvents();
    return ok(res, { total });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/events/:id ──────────────────────────────────────────────────────

export const getEventByIdHandler = async (req, res, next) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return fail(res, 404, "Event not found");
    return ok(res, { event });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/events/:id ────────────────────────────────────────────────────

// ─── POST /api/events (admin) ─────────────────────────────────────────────────

export const createEventHandler = async (req, res, next) => {
  try {
    const event = await createEvent(req.body);
    return res.status(201).json({ success: true, data: event });
  } catch (err) {
    if (err.message === "title is required") {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

export const updateEventHandler = async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = [
      "title", "description", "location", "coordinates", "date", "end_date",
      "category", "image", "gallery", "source_url", "booking_url",
      "organizer", "contact", "city", "is_paid", "ticket_price", "price_tier",
      "is_featured", "trending", "aiBoostScore", "adminPriority",
      "audience", "budgetLevel", "eventType", "recurring", "expiryDate",
      "tags", "keywords",
    ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }

    if (!Object.keys(updates).length) {
      return fail(res, 400, "No valid fields to update");
    }

    await updateEvent(id, updates);
    return ok(res, { success: true });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/events/:id ───────────────────────────────────────────────────

export const deleteEventHandler = async (req, res, next) => {
  try {
    await deleteEvent(req.params.id);
    return ok(res, { success: true });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/events/:id/featured ──────────────────────────────────────────

export const setFeaturedHandler = async (req, res, next) => {
  try {
    const featured = req.body?.featured;
    if (typeof featured !== "boolean") {
      return fail(res, 400, "Body must contain { featured: boolean }");
    }
    await setEventFeatured(req.params.id, featured);
    return ok(res, { success: true });
  } catch (err) {
    next(err);
  }
};
