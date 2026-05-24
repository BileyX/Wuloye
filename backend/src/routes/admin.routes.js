/**
 * admin.routes.js — Admin-only management routes.
 *
 * All routes require authenticate + requireAdmin middleware.
 *
 * Mounted at: /api/admin
 */

import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.middleware.js";
import {
  getAllUsers,
  getUserById,
  setSuspendedStatus,
  deleteUserById,
} from "../services/user.service.js";
import {
  getAllPlaces,
  getPlaceById,
  createPlace,
  updatePlace,
  deletePlaceById,
  VALID_TYPES,
  VALID_PRICE_RANGES,
} from "../services/place.service.js";
import { db } from "../config/firebase.js";
import { logger } from "../utils/logger.js";
import {
  TRENDING_COLLECTION,
  getAdminTrendingList,
  getPersonalizedTrendingFeed,
  invalidateTrendingCache,
} from "../services/trending.service.js";
import { sendAdminPushBroadcast } from "../services/pushNotification.service.js";
import { countActiveDevices } from "../services/pushToken.service.js";

const router = Router();

// Apply auth to every route in this file.
router.use(authenticate, requireAdmin);

// ─── Verify ──────────────────────────────────────────────────────────────────

router.get("/verify", (req, res) => {
  return res.status(200).json({
    success: true,
    data: { uid: req.user.uid, email: req.user.email ?? null },
    message: "Admin verified",
  });
});

// ─── User management ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/users
 * Query: limit, startAfter
 */
router.get("/users", async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const startAfter = req.query.startAfter || null;
    const result = await getAllUsers({ limit, startAfter });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/users/:uid
 */
router.get("/users/:uid", async (req, res, next) => {
  try {
    const user = await getUserById(req.params.uid);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/users/:uid/suspend
 * Body: { suspended: boolean }
 */
router.patch("/users/:uid/suspend", async (req, res, next) => {
  try {
    const { suspended } = req.body;
    if (typeof suspended !== "boolean") {
      return res.status(400).json({ success: false, message: "`suspended` must be a boolean" });
    }
    const user = await setSuspendedStatus(req.params.uid, suspended);
    return res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/users/:uid
 */
router.delete("/users/:uid", async (req, res, next) => {
  try {
    await deleteUserById(req.params.uid);
    return res.status(200).json({ success: true, message: "User deleted" });
  } catch (err) {
    next(err);
  }
});

// ─── Places management ───────────────────────────────────────────────────────

/**
 * GET /api/admin/places
 */
router.get("/places", async (req, res, next) => {
  try {
    const places = await getAllPlaces();
    return res.status(200).json({ success: true, data: places, total: places.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/places/meta
 * Returns allowed types and price ranges for form validation.
 */
router.get("/places/meta", (req, res) => {
  return res.status(200).json({
    success: true,
    data: { types: VALID_TYPES, priceRanges: VALID_PRICE_RANGES },
  });
});

/**
 * GET /api/admin/places/:id
 */
router.get("/places/:id", async (req, res, next) => {
  try {
    const place = await getPlaceById(req.params.id);
    if (!place) {
      return res.status(404).json({ success: false, message: "Place not found" });
    }
    return res.status(200).json({ success: true, data: place });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/places
 */
router.post("/places", async (req, res, next) => {
  try {
    const place = await createPlace(req.body);
    return res.status(201).json({ success: true, data: place });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/places/:id
 */
router.put("/places/:id", async (req, res, next) => {
  try {
    const place = await updatePlace(req.params.id, req.body);
    return res.status(200).json({ success: true, data: place });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/places/:id
 */
router.delete("/places/:id", async (req, res, next) => {
  try {
    await deletePlaceById(req.params.id);
    return res.status(200).json({ success: true, message: "Place deleted" });
  } catch (err) {
    next(err);
  }
});

// ─── Onboarding Analytics ────────────────────────────────────────────────────

/**
 * GET /api/admin/analytics/onboarding
 * Aggregates user onboarding fields: religion, budgetRange, topEventInterests,
 * usersWithDailyRoutine.  Samples up to 500 users for performance.
 */
router.get("/analytics/onboarding", async (req, res, next) => {
  try {
    const snap = await db.collection("users").limit(500).get();
    const users = snap.docs.map((d) => d.data());

    const religion   = {};
    const budgetRange = {};
    const interestCounts = {};
    let usersWithDailyRoutine = 0;

    for (const u of users) {
      // religion
      const rel = u.religion || u.onboarding?.religion;
      if (rel) religion[rel] = (religion[rel] || 0) + 1;

      // budgetRange
      const bud = u.budgetRange ?? u.onboarding?.budgetRange ?? u.weeklyBudget;
      if (bud) {
        const key = typeof bud === "number"
          ? (bud <= 2000 ? "cheap" : bud <= 10000 ? "medium" : "expensive")
          : String(bud).toLowerCase();
        budgetRange[key] = (budgetRange[key] || 0) + 1;
      }

      // event interests
      const interests = u.eventInterests ?? u.onboarding?.eventInterests ?? [];
      if (Array.isArray(interests)) {
        for (const tag of interests) {
          interestCounts[tag] = (interestCounts[tag] || 0) + 1;
        }
      }

      // has daily routine
      if (u.wakeUpTime || u.onboarding?.wakeUpTime || u.dailyRoutine?.length) {
        usersWithDailyRoutine++;
      }
    }

    const topEventInterests = Object.entries(interestCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));

    return res.status(200).json({
      success: true,
      data: {
        sampleSize: users.length,
        usersWithDailyRoutine,
        religion,
        budgetRange,
        topEventInterests,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

/**
 * GET /api/admin/analytics
 * Returns platform-wide aggregated analytics.
 */
router.get("/analytics", async (req, res, next) => {
  try {
    const [usersSnap, interactionsSnap, placesSnap, eventsSnap] = await Promise.all([
      db.collection("users").count().get(),
      db.collection("interactions").count().get(),
      db.collection("places").count().get(),
      db.collection("events").count().get(),
    ]);

    const totalUsers = usersSnap.data().count;
    const totalInteractions = interactionsSnap.data().count;
    const totalPlaces = placesSnap.data().count;
    const totalEvents = eventsSnap.data().count;

    // Recent interactions for action breakdown
    const recentInterSnap = await db
      .collection("interactions")
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();
    const recentInteractions = recentInterSnap.docs.map((d) => d.data());

    const actionCounts = { view: 0, click: 0, save: 0, dismiss: 0 };
    const typeCounts = {};
    const dailyCounts = {};

    for (const inter of recentInteractions) {
      if (inter.actionType && actionCounts[inter.actionType] !== undefined) {
        actionCounts[inter.actionType]++;
      }
      if (inter.placeType) {
        typeCounts[inter.placeType] = (typeCounts[inter.placeType] || 0) + 1;
      }
      if (inter.createdAt) {
        const day = inter.createdAt.slice(0, 10);
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
    }

    // Top categories by interaction
    const topCategories = Object.entries(typeCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([category, count]) => ({ category, count }));

    // Daily activity last 14 days
    const now = new Date();
    const dailyActivity = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyActivity.push({ date: key, count: dailyCounts[key] || 0 });
    }

    // Recent users (last 10)
    const recentUsersSnap = await db
      .collection("users")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    const recentUsers = recentUsersSnap.docs.map((d) => {
      const data = d.data();
      return { uid: d.id, email: data.email, createdAt: data.createdAt };
    });

    return res.status(200).json({
      success: true,
      data: {
        totals: { users: totalUsers, interactions: totalInteractions, places: totalPlaces, events: totalEvents },
        actionBreakdown: actionCounts,
        topCategories,
        dailyActivity,
        recentUsers,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── AI Insights ─────────────────────────────────────────────────────────────

/**
 * GET /api/admin/ai/insights
 * Returns AI recommendation quality metrics derived from interactions.
 */
router.get("/ai/insights", async (req, res, next) => {
  try {
    const interSnap = await db
      .collection("interactions")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .get();
    const interactions = interSnap.docs.map((d) => d.data());

    const totalRecs = interactions.length;
    const saves = interactions.filter((i) => i.actionType === "save").length;
    const dismisses = interactions.filter((i) => i.actionType === "dismiss").length;
    const clicks = interactions.filter((i) => i.actionType === "click").length;

    const successRate = totalRecs > 0 ? ((saves + clicks) / totalRecs) * 100 : 0;
    const dismissRate = totalRecs > 0 ? (dismisses / totalRecs) * 100 : 0;

    // Category performance
    const catSuccess = {};
    const catTotal = {};
    for (const inter of interactions) {
      const cat = inter.placeType || "unknown";
      catTotal[cat] = (catTotal[cat] || 0) + 1;
      if (inter.actionType === "save" || inter.actionType === "click") {
        catSuccess[cat] = (catSuccess[cat] || 0) + 1;
      }
    }

    const categoryPerformance = Object.entries(catTotal)
      .map(([category, total]) => ({
        category,
        total,
        successes: catSuccess[category] || 0,
        rate: total > 0 ? (((catSuccess[category] || 0) / total) * 100).toFixed(1) : "0",
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Experiment breakdown if present
    const withExperiment = interactions.filter((i) => i.experimentVariant);
    const variantA = withExperiment.filter((i) => i.experimentVariant === "A");
    const variantB = withExperiment.filter((i) => i.experimentVariant === "B");
    const expScore = (arr) => {
      const s = arr.filter((i) => i.actionType === "save" || i.actionType === "click").length;
      return arr.length > 0 ? ((s / arr.length) * 100).toFixed(1) : "0";
    };

    // Get model from Firestore
    let modelInfo = null;
    try {
      const modelSnap = await db.collection("models").doc("current").get();
      if (modelSnap.exists) {
        const m = modelSnap.data();
        modelInfo = {
          version: m.version,
          trainedAt: m.trainedAt,
          sampleCount: m.sampleCount,
          finalLoss: m.finalLoss,
          modelActive: m.modelActive,
        };
      }
    } catch {
      // non-fatal
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalInteractions: totalRecs,
          saves,
          clicks,
          dismisses,
          successRate: successRate.toFixed(1),
          dismissRate: dismissRate.toFixed(1),
        },
        categoryPerformance,
        experiments: {
          variantA: { count: variantA.length, score: expScore(variantA) },
          variantB: { count: variantB.length, score: expScore(variantB) },
        },
        model: modelInfo,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * POST /api/admin/notifications
 * Broadcast push notification to registered devices + persist record.
 * Body: { title, message, type, deepLink?, subtitle?, imageUrl?, targeting? }
 */
router.post("/notifications", async (req, res, next) => {
  try {
    const {
      title,
      message,
      body,
      type,
      severity,
      deepLink = "wuloye://home",
      subtitle = "",
      imageUrl = null,
      targeting = null,
    } = req.body;

    const msgBody = message || body;
    const notifType = type || severity || "announcement";

    if (!title || !msgBody) {
      return res.status(400).json({ success: false, message: "title and message are required" });
    }

    const docRef = db.collection("admin_notifications").doc();
    const doc = {
      id: docRef.id,
      title,
      message: msgBody,
      type: notifType,
      deepLink,
      subtitle: subtitle || null,
      imageUrl: imageUrl || null,
      targeting: targeting || null,
      sentBy: req.user.email ?? req.user.uid,
      sentAt: new Date().toISOString(),
      pushStats: null,
    };
    await docRef.set(doc);

    const pushStats = await sendAdminPushBroadcast({
      title,
      body: msgBody,
      type: notifType,
      deepLink,
      subtitle,
      imageUrl,
      notificationId: docRef.id,
      targeting,
    });

    await docRef.update({ pushStats });

    logger.info(
      `[admin] Push broadcast "${title}" by ${doc.sentBy} — sent=${pushStats.sent} failed=${pushStats.failed} devices=${pushStats.targetedDevices}`,
    );

    return res.status(201).json({ success: true, data: { ...doc, pushStats } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications/stats
 * Active registered device counts for admin dashboard.
 */
router.get("/notifications/stats", async (req, res, next) => {
  try {
    const stats = await countActiveDevices();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications
 */
router.get("/notifications", async (req, res, next) => {
  try {
    const snap = await db
      .collection("admin_notifications")
      .orderBy("sentAt", "desc")
      .limit(50)
      .get();
    const notifications = snap.docs.map((d) => d.data());
    return res.status(200).json({ success: true, data: notifications });
  } catch (err) {
    next(err);
  }
});

// ─── Recommendation Control Center ───────────────────────────────────────────
// Collection: "curated_recommendations"
// Stores admin-managed places with AI boost metadata.  These are injected into
// the recommendation ranking engine as trusted high-quality candidates.

const CURATED_COLLECTION = "curated_recommendations";

/**
 * GET /api/admin/recommendation-control
 * List all curated recommendations. Supports ?category, ?featured, ?limit.
 */
router.get("/recommendation-control", async (req, res, next) => {
  try {
    let query = db.collection(CURATED_COLLECTION).orderBy("createdAt", "desc");
    if (req.query.featured === "true") query = query.where("featured", "==", true);
    if (req.query.category) query = query.where("category", "==", req.query.category);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const snap = await query.limit(limit).get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ success: true, data, total: data.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/recommendation-control
 * Create a new curated recommendation.
 */
router.post("/recommendation-control", async (req, res, next) => {
  try {
    const {
      name, description, category, subcategory, tags = [], keywords = [],
      audience = [], lifestyleType, quietSocialLevel, indoorOutdoor,
      familyFriendly = false, studentFriendly = false, professionalFriendly = false,
      budgetTier, estimatedCost = {},
      location = {}, googlePlaceId, googleMapsUrl,
      thumbnailUrl, coverUrl, gallery = [],
      aiBoostScore = 0, adminPriority = 50, featured = false,
      trending = false, eventBoost = false, seasonalBoost = false, sponsored = false,
      audienceTags = [], onboardingMatchCriteria = {}, categoryAffinity = {},
    } = req.body;

    if (!name || !category) {
      return res.status(400).json({ success: false, message: "name and category are required" });
    }

    const docRef = db.collection(CURATED_COLLECTION).doc();
    const now = new Date().toISOString();
    const doc = {
      id: docRef.id,
      name: String(name).trim(),
      description: description ? String(description).trim() : "",
      category: String(category).toLowerCase().trim(),
      subcategory: subcategory ?? null,
      tags: Array.isArray(tags) ? tags : [],
      keywords: Array.isArray(keywords) ? keywords : [],
      audience: Array.isArray(audience) ? audience : [],
      lifestyleType: lifestyleType ?? null,
      quietSocialLevel: quietSocialLevel ?? null,
      indoorOutdoor: indoorOutdoor ?? null,
      familyFriendly: Boolean(familyFriendly),
      studentFriendly: Boolean(studentFriendly),
      professionalFriendly: Boolean(professionalFriendly),
      budgetTier: budgetTier ?? "medium",
      estimatedCost,
      location,
      googlePlaceId: googlePlaceId ?? null,
      googleMapsUrl: googleMapsUrl ?? null,
      thumbnailUrl: thumbnailUrl ?? null,
      coverUrl: coverUrl ?? null,
      gallery: Array.isArray(gallery) ? gallery : [],
      aiBoostScore: Math.min(100, Math.max(0, Number(aiBoostScore) || 0)),
      adminPriority: Math.min(100, Math.max(0, Number(adminPriority) || 50)),
      featured: Boolean(featured),
      trending: Boolean(trending),
      eventBoost: Boolean(eventBoost),
      seasonalBoost: Boolean(seasonalBoost),
      sponsored: Boolean(sponsored),
      audienceTags: Array.isArray(audienceTags) ? audienceTags : [],
      onboardingMatchCriteria,
      categoryAffinity,
      engagementStats: { likes: 0, saves: 0, dismisses: 0, clicks: 0, views: 0 },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.email ?? req.user.uid,
      source: "admin_curated",
    };

    await docRef.set(doc);
    logger.info(`[admin] Curated recommendation created: "${name}" by ${doc.createdBy}`);
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/recommendation-control/:id
 * Update a curated recommendation.
 */
router.put("/recommendation-control/:id", async (req, res, next) => {
  try {
    const ref = db.collection(CURATED_COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "Curated recommendation not found" });
    }
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    delete updates.id;
    delete updates.createdAt;
    delete updates.createdBy;
    await ref.update(updates);
    return res.status(200).json({ success: true, data: { id: req.params.id, ...snap.data(), ...updates } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/recommendation-control/:id
 */
router.delete("/recommendation-control/:id", async (req, res, next) => {
  try {
    await db.collection(CURATED_COLLECTION).doc(req.params.id).delete();
    return res.status(200).json({ success: true, message: "Curated recommendation deleted" });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/recommendation-control/:id/boost
 * Update only AI boost controls without full update.
 */
router.patch("/recommendation-control/:id/boost", async (req, res, next) => {
  try {
    const { aiBoostScore, adminPriority, trending, eventBoost, seasonalBoost, sponsored } = req.body;
    const updates = { updatedAt: new Date().toISOString() };
    if (aiBoostScore  !== undefined) updates.aiBoostScore  = Math.min(100, Math.max(0, Number(aiBoostScore)));
    if (adminPriority !== undefined) updates.adminPriority = Math.min(100, Math.max(0, Number(adminPriority)));
    if (trending      !== undefined) updates.trending      = Boolean(trending);
    if (eventBoost    !== undefined) updates.eventBoost    = Boolean(eventBoost);
    if (seasonalBoost !== undefined) updates.seasonalBoost = Boolean(seasonalBoost);
    if (sponsored     !== undefined) updates.sponsored     = Boolean(sponsored);
    await db.collection(CURATED_COLLECTION).doc(req.params.id).update(updates);
    return res.status(200).json({ success: true, data: updates });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/recommendation-control/:id/feature
 * Toggle featured status.
 */
router.patch("/recommendation-control/:id/feature", async (req, res, next) => {
  try {
    const featured = Boolean(req.body.featured);
    await db.collection(CURATED_COLLECTION).doc(req.params.id).update({
      featured,
      updatedAt: new Date().toISOString(),
    });
    return res.status(200).json({ success: true, data: { featured } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/recommendation-analytics
 * Returns engagement analytics for curated recommendations.
 */
router.get("/recommendation-analytics", async (req, res, next) => {
  try {
    // Interaction stats by placeId for curated places
    const curatedSnap = await db.collection(CURATED_COLLECTION).limit(200).get();
    const curatedIds  = new Set(curatedSnap.docs.map((d) => d.id));

    const interSnap = await db
      .collection("interactions")
      .orderBy("createdAt", "desc")
      .limit(2000)
      .get();

    const stats = {};
    for (const d of interSnap.docs) {
      const data = d.data();
      const pid  = data.placeId;
      if (!pid || !curatedIds.has(pid)) continue;
      if (!stats[pid]) stats[pid] = { placeId: pid, likes: 0, saves: 0, dismisses: 0, clicks: 0, views: 0 };
      const s = stats[pid];
      if (data.actionType === "like")    s.likes++;
      if (data.actionType === "save")    s.saves++;
      if (data.actionType === "dismiss") s.dismisses++;
      if (data.actionType === "click")   s.clicks++;
      if (data.actionType === "view")    s.views++;
    }

    const places = curatedSnap.docs.map((d) => {
      const place = { id: d.id, ...d.data() };
      const s = stats[d.id] ?? { likes: 0, saves: 0, dismisses: 0, clicks: 0, views: 0 };
      const total = s.likes + s.saves + s.clicks + s.views;
      const ctr   = total > 0 ? +((( s.likes + s.saves + s.clicks) / total) * 100).toFixed(1) : 0;
      return {
        id: d.id,
        name: place.name,
        category: place.category,
        featured: place.featured ?? false,
        adminPriority: place.adminPriority ?? 50,
        aiBoostScore: place.aiBoostScore ?? 0,
        ...s,
        ctr,
        engagementScore: +(s.likes * 3 + s.saves * 5 + s.clicks * 2 - s.dismisses * 2).toFixed(0),
      };
    });

    places.sort((a, b) => b.engagementScore - a.engagementScore);

    return res.status(200).json({ success: true, data: places });
  } catch (err) {
    next(err);
  }
});

// ─── Trending Management ──────────────────────────────────────────────────────
// Admins explicitly mark places/events as trending with targeting metadata.
// Mobile Trending screen shows admin-controlled content only.

/**
 * GET /api/admin/trending
 * List all admin-controlled trending entries.
 */
router.get("/trending", async (req, res, next) => {
  try {
    const data = await getAdminTrendingList({ type: req.query.type ?? null });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/trending
 * Add a place or event to the admin trending list.
 */
router.post("/trending", async (req, res, next) => {
  try {
    const {
      contentId, contentType = "place", name, description = "",
      thumbnailUrl, category, city = "",
      rank = 99, active = true,
      audience = [], budgetLevel = "all", lifestyleType = "",
      startDate = null, endDate = null,
      aiBoostScore = 70, adminPriority = 70,
      tags = [],
    } = req.body;

    if (!contentId || !name) {
      return res.status(400).json({ success: false, message: "contentId and name are required" });
    }

    const docRef = db.collection(TRENDING_COLLECTION).doc();
    const now = new Date().toISOString();
    const doc = {
      id: docRef.id,
      contentId: String(contentId),
      contentType: ["place", "event", "curated"].includes(contentType) ? contentType : "place",
      name: String(name).trim(),
      description: String(description).trim(),
      thumbnailUrl: thumbnailUrl ?? null,
      category: category ?? null,
      city: String(city).trim(),
      rank: Math.max(1, Number(rank) || 99),
      active: Boolean(active),
      audience: Array.isArray(audience) ? audience : [],
      budgetLevel: String(budgetLevel).trim(),
      lifestyleType: String(lifestyleType).trim(),
      startDate, endDate,
      aiBoostScore: Math.min(100, Math.max(0, Number(aiBoostScore) || 70)),
      adminPriority: Math.min(100, Math.max(0, Number(adminPriority) || 70)),
      tags: Array.isArray(tags) ? tags : [],
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.email ?? req.user.uid,
    };
    await docRef.set(doc);
    invalidateTrendingCache();
    logger.info(`[admin] Trending item added: "${name}" by ${doc.createdBy}`);
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/trending/:id
 * Update a trending entry (rank, active status, targeting, etc.)
 */
router.patch("/trending/:id", async (req, res, next) => {
  try {
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    delete updates.id;
    delete updates.createdAt;
    delete updates.createdBy;
    await db.collection(TRENDING_COLLECTION).doc(req.params.id).update(updates);
    invalidateTrendingCache();
    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/trending/:id
 */
router.delete("/trending/:id", async (req, res, next) => {
  try {
    await db.collection(TRENDING_COLLECTION).doc(req.params.id).delete();
    invalidateTrendingCache();
    return res.status(200).json({ success: true, message: "Removed from trending" });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/trending/feed
 * Preview personalized trending feed (admin QA).
 */
router.get("/trending/feed", async (req, res, next) => {
  try {
    let profile = null;
    const uid = req.query.uid ?? req.user?.uid ?? null;
    if (uid) {
      try {
        const snap = await db.collection("users").doc(uid).get();
        if (snap.exists) profile = snap.data();
      } catch { /* non-fatal */ }
    }

    const { items, meta } = await getPersonalizedTrendingFeed(profile);
    return res.status(200).json({ success: true, data: items, meta });
  } catch (err) {
    next(err);
  }
});

// Also expose boost/feature on existing admin places (/api/admin/places/:id/boost|feature)

/**
 * PATCH /api/admin/places/:id/boost
 */
router.patch("/places/:id/boost", async (req, res, next) => {
  try {
    const { aiBoostScore, adminPriority, trending, featured } = req.body;
    const updates = { updatedAt: new Date().toISOString() };
    if (aiBoostScore  !== undefined) updates.aiBoostScore  = Math.min(100, Math.max(0, Number(aiBoostScore)));
    if (adminPriority !== undefined) updates.adminPriority = Math.min(100, Math.max(0, Number(adminPriority)));
    if (trending      !== undefined) updates.trending      = Boolean(trending);
    if (featured      !== undefined) updates.featured      = Boolean(featured);
    const ref = db.collection("places").doc(req.params.id);
    await ref.update(updates);
    logger.info(`[admin] Place ${req.params.id} boost updated`);
    return res.status(200).json({ success: true, data: updates });
  } catch (err) {
    next(err);
  }
});

export default router;
