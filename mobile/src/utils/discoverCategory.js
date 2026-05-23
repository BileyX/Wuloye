/**
 * Discover / Nearby category helpers — single source for filter matching.
 * Align with backend `src/utils/discoverCategory.js`.
 */

import { resolveEventThumbnailUri } from "./eventMedia";

/** UI filter keys (canonical). */
export const DISCOVER_FILTER_KEYS = Object.freeze([
    "all",
    "gym",
    "cafe",
    "hotel",
    "sports",
    "event",
    "church",
    "workspace",
]);

/**
 * Derive canonical discover category from a list item (place or event-shaped).
 * @param {object} item
 * @returns {string}
 */
export function deriveDiscoverCategory(item) {
    if (!item || typeof item !== "object") return "other";
    if (item.isEvent === true) return "event";
    if (item.category === "event" || item.type === "event") return "event";

    const id = String(item.placeId ?? item.id ?? "");
    if (id.startsWith("event:") || id.startsWith("evt_")) return "event";

    const raw = (item.type ?? item.category ?? "").toString().trim().toLowerCase();
    if (!raw || raw === "place") return "other";

    if (raw === "coffee" || raw === "restaurant") return "cafe";
    if (raw === "study") return "workspace";
    if (raw === "lodging") return "hotel";

    const singles = new Set([
        "gym",
        "hotel",
        "sports",
        "church",
        "workspace",
        "event",
    ]);
    if (singles.has(raw)) return raw;

    return raw;
}

/**
 * Client-side strict filter (defence in depth vs API).
 * @param {object[]} items
 * @param {string|null|undefined} selectedFilter  — "all" or null = no filter
 * @returns {object[]}
 */
export function filterDiscoverItemsByCategory(items, selectedFilter) {
    if (!Array.isArray(items)) return [];
    if (!selectedFilter || selectedFilter === "all") return items;
    return items.filter(
        (item) => deriveDiscoverCategory(item) === selectedFilter,
    );
}

// ─── Religion sub-filtering (client-side defence) ─────────────────────────────

/**
 * Mapping: user religion → allowed place religion tags.
 * Mirrors the server's placeAllowedByReligion logic.
 */
/** Strict: only exact denomination — never generic "christian". */
const RELIGION_ALLOWED_PLACE_TAGS = Object.freeze({
    orthodox:   new Set(["orthodox"]),
    protestant: new Set(["protestant"]),
    catholic:   new Set(["catholic"]),
    muslim:     new Set(["muslim"]),
});

/**
 * Detect the religion type of a place from its name, type and tags on the client.
 * Returns null for non-religious venues (they are always shown).
 *
 * @param {object} item
 * @returns {"muslim"|"orthodox"|"protestant"|"catholic"|"christian"|null}
 */
function detectPlaceReligionClient(item) {
    const parts = [
        item?.name ?? "",
        item?.type ?? "",
        item?.category ?? "",
        ...(Array.isArray(item?.tags) ? item.tags : []),
    ];
    const text = parts.join(" ").toLowerCase();
    const t    = (item?.type ?? item?.category ?? "").toLowerCase();

    const isReligious =
        ["church", "mosque", "masjid", "mesjid", "jami", "jamia",
         "temple", "chapel", "worship", "prayer", "islamic", "synagogue",
         "orthodox", "protestant", "catholic", "muslim", "hindu_temple"]
            .some((k) => text.includes(k) || t.includes(k));

    if (!isReligious) return null;

    if (
        text.includes("mosque")  || text.includes("masjid")  || text.includes("mesjid") ||
        text.includes("jami")    || text.includes("jamia")   || text.includes("muslim")  ||
        text.includes("islamic") || text.includes("musalla") || t.includes("mosque")
    ) return "muslim";

    if (
        text.includes("orthodox") || text.includes("debre") || text.includes("kidus")  ||
        text.includes("kidist")   || text.includes("kiddis") || text.includes("giorgis") ||
        text.includes("medhanealem") || text.includes("medhane alem")
    ) return "orthodox";

    if (
        text.includes("eecmy") || text.includes("eec my") ||
        text.includes("protestant") || text.includes("evangelical") ||
        text.includes("mekane yesus") || text.includes("kale hiwot") ||
        text.includes("adventist")   || text.includes("pentecost")   ||
        text.includes("full gospel") || text.includes("baptist")     ||
        text.includes("lutheran") ||
        text.includes("latter-day") || text.includes("latter day") ||
        text.includes("mormon") || text.includes("jesus christ of")
    ) return "protestant";

    if (
        text.includes("catholic") || text.includes("franciscan") || text.includes("jesuit")
    ) return "catholic";

    return "christian";
}

/**
 * Filter an array of church-category items by the user's religion preference.
 *
 * Rules (mirrors backend placeAllowedByReligion):
 *   - Non-religious items are always shown.
 *   - null / "other" / "prefer_not_to_say" → no filtering, all items shown.
 *   - Otherwise → only items whose religion matches the allowed set.
 *
 * @param {object[]} items
 * @param {string|null|undefined} userReligion
 * @returns {object[]}
 */
export function filterReligiousPlacesByUserReligion(items, userReligion) {
    if (!Array.isArray(items) || !userReligion) return items ?? [];
    if (userReligion === "other" || userReligion === "prefer_not_to_say") return items;

    const allowed = RELIGION_ALLOWED_PLACE_TAGS[userReligion.toLowerCase().trim()];
    if (!allowed) return items;

    return items.filter((item) => {
        const isChurch =
            (item?.category ?? item?.type ?? "").toLowerCase() === "church";
        if (!isChurch) return true;

        const serverDenom = (item?.denominationType ?? "").toLowerCase().trim();
        const placeReligion =
            serverDenom && serverDenom !== "other"
                ? serverDenom
                : detectPlaceReligionClient(item);

        if (!placeReligion || placeReligion === "christian") {
            return false;
        }
        return allowed.has(placeReligion);
    });
}

/**
 * Map scraped event → shape compatible with DiscoverCard + enrichPlaceLocation.
 * @param {object} event
 * @param {number} index
 * @returns {object}
 */
export function eventToDiscoverListItem(event, index) {
    const rawId = event?.id != null ? String(event.id) : `idx-${index}`;
    return {
        ...event,
        _eventForDetail: event,
        id: `event:${rawId}`,
        placeId: `event:${rawId}`,
        category: "event",
        isEvent: true,
        type: "event",
        name: event?.title ?? "Event",
        description:
            typeof event?.description === "string"
                ? event.description.slice(0, 400)
                : "",
        latitude: event?.coordinates?.lat,
        longitude: event?.coordinates?.lng,
        location: event?.coordinates
            ? {
                  lat: event.coordinates.lat,
                  lng: event.coordinates.lng,
                  city: event?.location ?? "",
              }
            : undefined,
        images: (() => {
            const u = resolveEventThumbnailUri(event);
            return u ? [u] : [];
        })(),
    };
}
