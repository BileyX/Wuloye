/** Lightweight place snapshot for interaction metadata (keeps POST bodies small). */
export function slimPlaceMetadata(place) {
    if (!place || typeof place !== "object") return null;
    return {
        id: place.placeId ?? place.id ?? null,
        name: place.name ?? null,
        type: place.type ?? null,
        category: place.category ?? null,
    };
}
