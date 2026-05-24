/**
 * trending.service.js — Admin-controlled trending feed.
 *
 * All Firestore reads use simple queries (no composite indexes).
 * Filtering and sorting happen in memory on small lists (≤200 items).
 */

import { db } from "../config/firebase.js";
import { getPlaceById } from "./place.service.js";
import { getEventById } from "./event.service.js";
import { logger } from "../utils/logger.js";

export const TRENDING_COLLECTION = "admin_trending";
const CURATED_COLLECTION = "curated_recommendations";
const PLACES_COLLECTION = "places";
const EVENTS_COLLECTION = "events";

const MAX_POOL = 200;

let _entriesCache = null;
let _entriesCacheTime = 0;
const ENTRIES_CACHE_TTL_MS = 15_000;

export function invalidateTrendingCache() {
  _entriesCache = null;
  _entriesCacheTime = 0;
}

// ─── Load & filter (no composite-index queries) ───────────────────────────────

/** Load every admin_trending doc (sorted in memory). */
export async function loadAdminTrendingDocs() {
  const snap = await db.collection(TRENDING_COLLECTION).limit(MAX_POOL).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Places / curated recs flagged trending=true (admin boost panel). */
async function loadFlaggedTrendingSources() {
  const [placesSnap, curatedSnap, eventsSnap] = await Promise.all([
    db.collection(PLACES_COLLECTION).where("trending", "==", true).limit(50).get().catch(() => ({ docs: [] })),
    db.collection(CURATED_COLLECTION).where("trending", "==", true).limit(50).get().catch(() => ({ docs: [] })),
    db.collection(EVENTS_COLLECTION).where("trending", "==", true).limit(50).get().catch(() => ({ docs: [] })),
  ]);

  const virtual = [];

  for (const d of placesSnap.docs) {
    const p = d.data();
    virtual.push({
      id: `place-flag-${d.id}`,
      contentId: d.id,
      contentType: "place",
      name: p.name ?? "Place",
      description: p.description ?? "",
      thumbnailUrl: p.thumbnailUrl ?? p.images?.[0] ?? null,
      category: p.type ?? p.category ?? "place",
      city: p.location?.city ?? p.city ?? "",
      rank: p.adminPriority ?? 50,
      active: true,
      audience: [],
      budgetLevel: p.priceRange ?? "all",
      aiBoostScore: p.aiBoostScore ?? 50,
      adminPriority: p.adminPriority ?? 50,
      source: "place_trending_flag",
    });
  }

  for (const d of curatedSnap.docs) {
    const c = d.data();
    virtual.push({
      id: `curated-flag-${d.id}`,
      contentId: d.id,
      contentType: "curated",
      name: c.name ?? "Curated",
      description: c.description ?? "",
      thumbnailUrl: c.thumbnailUrl ?? c.coverUrl ?? null,
      category: c.category ?? "place",
      city: c.city ?? c.location?.city ?? "",
      rank: c.adminPriority ?? 50,
      active: true,
      audience: c.audienceTags ?? [],
      budgetLevel: c.budgetTier ?? "all",
      aiBoostScore: c.aiBoostScore ?? 50,
      adminPriority: c.adminPriority ?? 50,
      source: "curated_trending_flag",
    });
  }

  for (const d of eventsSnap.docs) {
    const e = d.data();
    virtual.push({
      id: `event-flag-${d.id}`,
      contentId: d.id,
      contentType: "event",
      name: e.title ?? "Event",
      description: e.description ?? "",
      thumbnailUrl: e.image ?? null,
      category: e.category ?? "event",
      city: e.city ?? e.location ?? "",
      rank: e.adminPriority ?? 50,
      active: true,
      audience: e.audience ?? [],
      budgetLevel: e.budgetLevel ?? e.price_tier ?? "all",
      aiBoostScore: e.aiBoostScore ?? 50,
      adminPriority: e.adminPriority ?? 50,
      source: "event_trending_flag",
    });
  }

  return virtual;
}

/** Merge admin_trending docs + flagged sources, dedupe by contentId. */
export async function loadAllTrendingEntries({ noCache = false } = {}) {
  if (
    !noCache &&
    Array.isArray(_entriesCache) &&
    Date.now() - _entriesCacheTime < ENTRIES_CACHE_TTL_MS
  ) {
    return _entriesCache;
  }

  const [adminDocs, flagged] = await Promise.all([
    loadAdminTrendingDocs(),
    loadFlaggedTrendingSources(),
  ]);

  const byContent = new Map();
  for (const item of flagged) {
    byContent.set(`${item.contentType}:${item.contentId}`, item);
  }
  for (const item of adminDocs) {
    byContent.set(`${item.contentType}:${item.contentId}`, item);
  }

  const merged = [...byContent.values()].sort(
    (a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99),
  );

  _entriesCache = merged;
  _entriesCacheTime = Date.now();
  return merged;
}

export function filterTrendingByType(items, type) {
  if (!type || type === "all") return items;
  return items.filter((i) => i.contentType === type);
}

export function filterActiveTrending(items) {
  const now = new Date();
  return items.filter((item) => {
    if (item.active === false) return false;
    if (item.startDate && new Date(item.startDate) > now) return false;
    if (item.endDate && new Date(item.endDate) < now) return false;
    return true;
  });
}

/** Personalize trending list — only hide items with explicit audience targeting. */
export function filterTrendingForProfile(items, profile) {
  if (!profile) return items;

  const userReligion = (profile.religion || "").toLowerCase();
  const userInterests = new Set([
    ...(profile.preferredActivities ?? []),
    ...(profile.eventInterests ?? []),
    ...(profile.weeklyActivities ?? []),
    ...(profile.interests ?? []),
  ].map((t) => String(t).toLowerCase()));

  return items.filter((item) => {
    // Budget targeting is opt-in only — admin-added trending items always show
    // unless the admin explicitly enabled budget targeting on this entry.
    if (item.budgetTargeting === true && item.budgetLevel && item.budgetLevel !== "all") {
      const userBudget = (profile.budgetRange || profile.weeklyBudgetTier || "").toLowerCase();
      if (userBudget) {
        const allowed = String(item.budgetLevel).toLowerCase();
        const normalizedUser = userBudget.includes("cheap") || userBudget.includes("free") ? "cheap"
          : userBudget.includes("expens") ? "expensive"
          : userBudget.includes("mid") ? "medium"
          : userBudget;
        const normalizedAllowed = allowed.includes("afford") ? "medium"
          : allowed === "free" ? "cheap"
          : allowed;
        if (normalizedAllowed !== "all" && normalizedUser && normalizedAllowed !== normalizedUser) {
          return false;
        }
      }
    }

    // Audience tags — only filter when admin explicitly set targeting tags
    if (Array.isArray(item.audience) && item.audience.length > 0) {
      const hasMatch = item.audience.some((tag) => {
        const t = String(tag).toLowerCase();
        return userInterests.has(t)
          || (t === "religious" && userReligion)
          || (t === "students" && profile.isStudent);
      });
      if (!hasMatch) return false;
    }

    return true;
  });
}

// ─── Resolve content → recommendation-shaped card ───────────────────────────

function baseEntryFromTrending(item) {
  return {
    placeId: item.contentId,
    id: item.contentId,
    name: item.name,
    type: item.category ?? "place",
    category: item.category ?? "place",
    description: item.description ?? "",
    thumbnailUrl: item.thumbnailUrl ?? null,
    images: item.thumbnailUrl ? [item.thumbnailUrl] : [],
    city: item.city ?? "",
    trending: true,
    adminCurated: true,
    adminTrending: true,
    featured: Boolean(item.featured),
    score: Math.min(99, Math.max(60, Number(item.adminPriority ?? 70))),
    adminBoostApplied: item.aiBoostScore ?? 0,
    trendingRank: item.rank ?? 99,
    trendingEntryId: item.id,
    contentType: item.contentType,
  };
}

async function resolvePlaceContent(contentId, item) {
  let place = await getPlaceById(contentId);
  if (!place) {
    const byGoogle = await db.collection(PLACES_COLLECTION)
      .where("googlePlaceId", "==", contentId).limit(1).get();
    if (!byGoogle.empty) place = { id: byGoogle.docs[0].id, ...byGoogle.docs[0].data() };
  }
  const base = baseEntryFromTrending(item);
  if (!place) return base;

  return {
    ...base,
    placeId: place.id ?? place.googlePlaceId ?? contentId,
    id: place.id ?? place.googlePlaceId ?? contentId,
    name: place.name ?? base.name,
    type: place.type ?? place.category ?? base.type,
    category: place.category ?? place.type ?? base.category,
    description: place.description ?? base.description,
    rating: place.rating ?? null,
    priceRange: place.priceRange ?? null,
    location: place.location ?? null,
    images: place.images?.length ? place.images : base.images,
    thumbnailUrl: place.thumbnailUrl ?? place.images?.[0] ?? base.thumbnailUrl,
    googlePlaceId: place.googlePlaceId ?? null,
    googleMapsUrl: place.googleMapsUrl ?? null,
    tags: place.tags ?? [],
  };
}

async function resolveCuratedContent(contentId, item) {
  const snap = await db.collection(CURATED_COLLECTION).doc(contentId).get();
  const base = baseEntryFromTrending(item);
  if (!snap.exists) return base;
  const c = snap.data();
  return {
    ...base,
    name: c.name ?? base.name,
    type: c.category ?? base.type,
    category: c.category ?? base.category,
    description: c.description ?? base.description,
    priceRange: c.budgetTier ?? null,
    location: c.location ?? null,
    images: c.coverUrl ? [c.coverUrl, ...(c.gallery ?? [])] : (c.gallery ?? base.images),
    thumbnailUrl: c.thumbnailUrl ?? c.coverUrl ?? base.thumbnailUrl,
    googlePlaceId: c.googlePlaceId ?? null,
    googleMapsUrl: c.googleMapsUrl ?? null,
    featured: c.featured ?? base.featured,
    sponsored: c.sponsored ?? false,
  };
}

async function resolveEventContent(contentId, item) {
  const ev = await getEventById(contentId);
  const base = baseEntryFromTrending(item);
  if (!ev) return { ...base, category: "event", type: "event" };

  return {
    ...base,
    placeId: contentId,
    id: contentId,
    name: ev.title ?? base.name,
    type: "event",
    category: "event",
    description: ev.description ?? base.description,
    images: ev.image ? [ev.image] : base.images,
    thumbnailUrl: ev.image ?? base.thumbnailUrl,
    location: ev.coordinates
      ? { lat: ev.coordinates.lat, lng: ev.coordinates.lng, address: ev.location }
      : { address: ev.location },
    city: ev.city ?? ev.location ?? base.city,
    _eventForDetail: ev,
    eventDate: ev.date ?? null,
    bookingUrl: ev.booking_url ?? ev.source_url ?? null,
  };
}

export async function resolveTrendingEntry(item) {
  try {
    switch (item.contentType) {
      case "event":
        return resolveEventContent(item.contentId, item);
      case "curated":
        return resolveCuratedContent(item.contentId, item);
      default:
        return resolvePlaceContent(item.contentId, item);
    }
  } catch (err) {
    logger.warn(`[trending] resolve failed for ${item.contentId}: ${err.message}`);
    return baseEntryFromTrending(item);
  }
}

export async function resolveTrendingEntries(items) {
  return Promise.all(items.map((item) => resolveTrendingEntry(item)));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Admin dashboard list (all entries, optional type filter). */
export async function getAdminTrendingList({ type } = {}) {
  const all = await loadAllTrendingEntries();
  return filterTrendingByType(all, type);
}

/** Mobile personalized trending feed — admin-controlled only. */
export async function getPersonalizedTrendingFeed(profile) {
  const all = await loadAllTrendingEntries();
  const active = filterActiveTrending(all);
  const personalized = filterTrendingForProfile(active, profile);
  const resolved = await resolveTrendingEntries(personalized);

  const filteredOut = active.length - personalized.length;

  return {
    items: resolved,
    meta: {
      source: "admin_trending",
      total: resolved.length,
      totalActive: active.length,
      filteredOut,
      adminControlled: true,
    },
  };
}
