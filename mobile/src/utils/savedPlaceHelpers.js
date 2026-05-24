import { enrichPlaceLocation } from "./placeLocation";

/** Normalize a save interaction into a display-ready place object. */
export function asSavedPlace(interaction, index) {
    const place = interaction?.metadata?.place;
    const placeId = interaction?.placeId ?? place?.placeId ?? `${index}`;

    const merged = {
        id: placeId,
        placeId,
        name: place?.name ?? "Saved place",
        type: place?.type ?? "Place",
        score: place?.score ?? "Saved",
        distance: place?.distance ?? "Nearby",
        description:
            place?.description ?? "Saved from your recommendation history.",
        ...place,
    };

    return enrichPlaceLocation(merged, index);
}
