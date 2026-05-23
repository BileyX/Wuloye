/**
 * Church denomination label + color for UI badges.
 * @param {object|null|undefined} place
 * @returns {{ label: string|null, color: string|null }}
 */
export function getDenominationDisplay(place) {
    const denomType = (place?.denominationType ?? "").toLowerCase().trim();
    const isChurch =
        (place?.type ?? place?.category ?? "").toLowerCase() === "church";

    if (!denomType || !isChurch) {
        return { label: null, color: null };
    }

    let label = null;
    switch (denomType) {
        case "orthodox":
            label = "Orthodox";
            break;
        case "protestant":
            label = "Protestant";
            break;
        case "catholic":
            label = "Catholic";
            break;
        case "muslim":
            label = "Mosque";
            break;
        default:
            return { label: null, color: null };
    }

    let color = "#7C3AED";
    switch (denomType) {
        case "orthodox":
            color = "#B5651D";
            break;
        case "protestant":
            color = "#3B6FBF";
            break;
        case "catholic":
            color = "#7B2D8B";
            break;
        case "muslim":
            color = "#2E8B57";
            break;
        default:
            break;
    }

    return { label, color };
}
