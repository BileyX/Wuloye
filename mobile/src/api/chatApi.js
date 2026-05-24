/**
 * chatApi.js — AI chat assistant client.
 */

import { apiClient } from "./client";

export async function sendChatMessage({ message, location }) {
    const res = await apiClient.post("/chat/message", { message, location });
    return res.data?.data ?? null;
}

export async function fetchChatHistory(limit = 30) {
    const res = await apiClient.get("/chat/history", { params: { limit } });
    return res.data?.data ?? [];
}

export async function clearChatHistory() {
    const res = await apiClient.delete("/chat/history");
    return res.data?.data ?? null;
}

export async function fetchChatSuggestions() {
    const res = await apiClient.get("/chat/suggestions");
    return res.data?.data?.suggestions ?? [];
}
