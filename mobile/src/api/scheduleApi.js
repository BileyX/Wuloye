import apiClient from "./client";

/**
 * GET /api/ai/schedule
 *
 * Returns a personalized AI daily schedule split into four periods:
 *   { morning: [...], afternoon: [...], evening: [...], night: [...] }
 *
 * Each slot contains:
 *   { id, period, time, title, activityType, icon, color, duration,
 *     source, reason, badges, confidence,
 *     places: [ { ...up to 3 enriched picks } ],
 *     place:  legacy alias for places[0] | null }
 *
 * @param {{ lat?: number, lng?: number, radius?: number, refresh?: boolean }} params
 */
export async function getAiSchedule(params = {}) {
    const query = { ...params };
    if (query.refresh === true)  query.refresh = "true";
    if (query.refresh === false) delete query.refresh;
    const { data } = await apiClient.get("/ai/schedule", { params: query });
    return data;
}
