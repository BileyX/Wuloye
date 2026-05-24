import { apiClient } from "@/services/apiClient";

// ─── Endpoint path map ────────────────────────────────────────────────────────

export const endpoints = {
  health: "/health",
  metrics: "/health/metrics",
  profile: "/profile",
  recommendations: "/recommendations",
  interactions: "/interactions",
  routines: "/routines",
  events: "/events",
  eventsStats: "/events/stats",
  experiments: "/dev/experiment-metrics",

  // AI
  aiStatus: "/ai/status",
  aiTrain: "/ai/train",
  aiReset: "/ai/reset",
  aiSchedule: "/ai/schedule",

  // Admin
  adminUsers: "/admin/users",
  adminPlaces: "/admin/places",
  adminPlacesMeta: "/admin/places/meta",
  adminAnalytics: "/admin/analytics",
  adminOnboardingInsights: "/admin/analytics/onboarding",
  adminAiInsights: "/admin/ai/insights",
  adminNotifications: "/admin/notifications",
  adminRecommendationControl: "/admin/recommendation-control",
  adminRecommendationAnalytics: "/admin/recommendation-analytics",
  adminTrending: "/admin/trending",
  adminTrendingFeed: "/admin/trending/feed",

  // Dev (dev mode only)
  devUser: "/dev/user",
  devInteractions: "/dev/interactions",
  devModel: "/dev/model",
  devSystem: "/dev/system",
  devSystemExperiment: "/dev/system/experiment",
  devSystemFallback: "/dev/system/fallback",
  devSeed: "/dev/seed",
  devSeedPlaces: "/dev/seed-places",
};

// ─── System health ────────────────────────────────────────────────────────────

export async function getHealth() {
  const response = await apiClient.get(endpoints.health);
  return response.data;
}

export async function getMetrics() {
  const response = await apiClient.get(endpoints.metrics);
  return response.data;
}

// ─── User profile (own user) ──────────────────────────────────────────────────

export async function getUserProfile({ uid, email } = {}) {
  if (uid || email) {
    if (!import.meta.env.DEV) {
      throw new Error("User lookup by uid/email is only available in development mode");
    }
    const response = await apiClient.get(endpoints.devUser, { params: { uid, email } });
    return response.data;
  }
  const response = await apiClient.get(endpoints.profile);
  return response.data;
}

// ─── Recommendations ─────────────────────────────────────────────────────────

export async function getRecommendations(params) {
  const response = await apiClient.get(endpoints.recommendations, { params });
  return response.data;
}

// ─── Interactions ─────────────────────────────────────────────────────────────

export async function getInteractions({ uid, email, limit } = {}) {
  if (uid || email) {
    if (!import.meta.env.DEV) {
      throw new Error("Interactions lookup by uid/email is only available in development mode");
    }
    const response = await apiClient.get(endpoints.devInteractions, {
      params: { uid, email, limit },
    });
    return response.data;
  }
  const response = await apiClient.get(endpoints.interactions);
  return response.data;
}

// ─── Routines ────────────────────────────────────────────────────────────────

export async function getRoutines() {
  const response = await apiClient.get(endpoints.routines);
  return response.data;
}

// ─── Experiments ─────────────────────────────────────────────────────────────

export async function getExperimentMetrics() {
  const response = await apiClient.get(endpoints.experiments);
  return response.data;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function getAdminEvents(params = {}) {
  const response = await apiClient.get(endpoints.events, { params });
  return response.data;
}

export async function getEventsStats() {
  const response = await apiClient.get(endpoints.eventsStats);
  return response.data;
}

export async function createAdminEvent(data) {
  const response = await apiClient.post(endpoints.events, data);
  return response.data;
}

export async function updateAdminEvent(id, updates) {
  const response = await apiClient.patch(`${endpoints.events}/${id}`, updates);
  return response.data;
}

export async function deleteAdminEvent(id) {
  const response = await apiClient.delete(`${endpoints.events}/${id}`);
  return response.data;
}

export async function setEventFeatured(id, featured) {
  const response = await apiClient.patch(`${endpoints.events}/${id}/featured`, { featured });
  return response.data;
}

// ─── AI ──────────────────────────────────────────────────────────────────────

export async function getAiStatus() {
  const response = await apiClient.get(endpoints.aiStatus);
  return response.data;
}

export async function trainAiModel() {
  const response = await apiClient.post(endpoints.aiTrain);
  return response.data;
}

export async function resetAiModel() {
  const response = await apiClient.post(endpoints.aiReset);
  return response.data;
}

export async function getAiSchedule() {
  const response = await apiClient.get(endpoints.aiSchedule);
  return response.data;
}

// ─── Admin: Users ─────────────────────────────────────────────────────────────

export async function getAdminUsers({ limit = 50, startAfter } = {}) {
  const params = { limit };
  if (startAfter) params.startAfter = startAfter;
  const response = await apiClient.get(endpoints.adminUsers, { params });
  return response.data;
}

export async function getAdminUser(uid) {
  const response = await apiClient.get(`${endpoints.adminUsers}/${uid}`);
  return response.data;
}

export async function suspendAdminUser(uid, suspended) {
  const response = await apiClient.patch(`${endpoints.adminUsers}/${uid}/suspend`, { suspended });
  return response.data;
}

export async function deleteAdminUser(uid) {
  const response = await apiClient.delete(`${endpoints.adminUsers}/${uid}`);
  return response.data;
}

// ─── Admin: Places ────────────────────────────────────────────────────────────

export async function getAdminPlaces() {
  const response = await apiClient.get(endpoints.adminPlaces);
  return response.data;
}

export async function getAdminPlacesMeta() {
  const response = await apiClient.get(endpoints.adminPlacesMeta);
  return response.data;
}

export async function createAdminPlace(data) {
  const response = await apiClient.post(endpoints.adminPlaces, data);
  return response.data;
}

export async function updateAdminPlace(id, data) {
  const response = await apiClient.put(`${endpoints.adminPlaces}/${id}`, data);
  return response.data;
}

export async function deleteAdminPlace(id) {
  const response = await apiClient.delete(`${endpoints.adminPlaces}/${id}`);
  return response.data;
}

// ─── Admin: Analytics ────────────────────────────────────────────────────────

export async function getAdminAnalytics() {
  const response = await apiClient.get(endpoints.adminAnalytics);
  return response.data;
}

export async function getAdminOnboardingInsights() {
  const response = await apiClient.get(endpoints.adminOnboardingInsights);
  return response.data;
}

// ─── Admin: AI Insights ───────────────────────────────────────────────────────

export async function getAdminAiInsights() {
  const response = await apiClient.get(endpoints.adminAiInsights);
  return response.data;
}

// ─── Admin: Notifications ─────────────────────────────────────────────────────

export async function sendAdminNotification(data) {
  const response = await apiClient.post(endpoints.adminNotifications, data);
  return response.data;
}

/** Alias used by NotificationsAdminPage — maps {title, body, severity} → backend {title, message, type}. */
export async function postAdminAnnouncement({ title, body, severity }) {
  const response = await apiClient.post(endpoints.adminNotifications, {
    title,
    message: body,
    type: severity ?? "announcement",
  });
  return response.data;
}

export async function getAdminNotifications() {
  const response = await apiClient.get(endpoints.adminNotifications);
  return response.data;
}

// ─── Admin: Recommendation Control Center ────────────────────────────────────

export async function getAdminRecommendationControl(params = {}) {
  const response = await apiClient.get(endpoints.adminRecommendationControl, { params });
  return response.data;
}

export async function createAdminRecommendation(data) {
  const response = await apiClient.post(endpoints.adminRecommendationControl, data);
  return response.data;
}

export async function updateAdminRecommendation(id, data) {
  const response = await apiClient.put(`${endpoints.adminRecommendationControl}/${id}`, data);
  return response.data;
}

export async function deleteAdminRecommendation(id) {
  const response = await apiClient.delete(`${endpoints.adminRecommendationControl}/${id}`);
  return response.data;
}

export async function boostAdminRecommendation(id, boostData) {
  const response = await apiClient.patch(`${endpoints.adminRecommendationControl}/${id}/boost`, boostData);
  return response.data;
}

export async function featureAdminRecommendation(id, featured) {
  const response = await apiClient.patch(`${endpoints.adminRecommendationControl}/${id}/feature`, { featured });
  return response.data;
}

export async function getAdminRecommendationAnalytics() {
  const response = await apiClient.get(endpoints.adminRecommendationAnalytics);
  return response.data;
}

// ─── Admin: Trending Management ──────────────────────────────────────────────

export async function getAdminTrending(params = {}) {
  const response = await apiClient.get(endpoints.adminTrending, { params });
  return response.data;
}

export async function createAdminTrending(data) {
  const response = await apiClient.post(endpoints.adminTrending, data);
  return response.data;
}

export async function updateAdminTrending(id, data) {
  const response = await apiClient.patch(`${endpoints.adminTrending}/${id}`, data);
  return response.data;
}

export async function deleteAdminTrending(id) {
  const response = await apiClient.delete(`${endpoints.adminTrending}/${id}`);
  return response.data;
}

// ─── Dev (dev mode only) ─────────────────────────────────────────────────────

export async function getModelStatus() {
  if (!import.meta.env.DEV) {
    throw new Error("Model status is only available in development mode");
  }
  const response = await apiClient.get(endpoints.devModel);
  return response.data;
}

export async function getSystemStatus() {
  if (!import.meta.env.DEV) {
    throw new Error("System controls are only available in development mode");
  }
  const response = await apiClient.get(endpoints.devSystem);
  return response.data;
}

export async function setExperimentActive(enabled) {
  if (!import.meta.env.DEV) {
    throw new Error("System controls are only available in development mode");
  }
  const response = await apiClient.post(endpoints.devSystemExperiment, { enabled });
  return response.data;
}

export async function setFallbackMode(enabled) {
  if (!import.meta.env.DEV) {
    throw new Error("System controls are only available in development mode");
  }
  const response = await apiClient.post(endpoints.devSystemFallback, { enabled });
  return response.data;
}

export async function runSeed() {
  if (!import.meta.env.DEV) {
    throw new Error("Seeding is only available in development mode");
  }
  const response = await apiClient.post(endpoints.devSeed);
  return response.data;
}

export async function runSeedPlaces() {
  if (!import.meta.env.DEV) {
    throw new Error("Seeding is only available in development mode");
  }
  const response = await apiClient.post(endpoints.devSeedPlaces);
  return response.data;
}
