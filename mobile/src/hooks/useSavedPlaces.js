import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { createInteraction, getInteractions } from "../api/interactionApi";
import { getSavedPlaces } from "../api/placeApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { getApiErrorMessage, unwrapApiData } from "../utils/api";
import { enrichPlaceLocation } from "../utils/placeLocation";

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

/**
 * Loads SAVE interactions from the API (same persistence as the former Saved tab).
 */
export function useSavedPlaces() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState([]);
    const [refreshing, setRefreshing] = useState(false);

    const loadSaved = useCallback(async (opts = {}) => {
        const silent = opts.silent === true;
        try {
            if (!silent) {
                setLoading(true);
            }
            setError("");

            // v18: prefer the dedicated /places/saved endpoint, which returns
            // enriched, sorted, server-authoritative results. Fall back to
            // interaction replay only when the endpoint is unavailable (older
            // backend) so the screen never goes blank during a rolling deploy.
            const fromServer = await getSavedPlaces();
            if (Array.isArray(fromServer)) {
                const enriched = fromServer.map((p, idx) =>
                    enrichPlaceLocation(
                        {
                            id:          p.id ?? p.placeId,
                            placeId:     p.placeId ?? p.id,
                            name:        p.name ?? "Saved place",
                            type:        p.type ?? "Place",
                            score:       p.score ?? "Saved",
                            distance:    p.distance ?? "Nearby",
                            description: p.description ?? "Saved from your recommendation history.",
                            ...p,
                        },
                        idx,
                    ),
                );
                setSaved(enriched);
                return;
            }

            const envelope = await getInteractions();
            const interactions = unwrapApiData(envelope, []);
            const ordered = Array.isArray(interactions) ? interactions : [];
            const savedByPlace = new Map();

            // Fallback: replay every interaction that changes saved-ness so
            // the list matches the same source-of-truth rules used in the
            // interaction store.
            ordered.forEach((interaction, index) => {
                const pid = interaction?.placeId;
                if (!pid) {
                    return;
                }

                switch (interaction?.actionType) {
                    case INTERACTION_TYPES.SAVE:
                        savedByPlace.set(pid, asSavedPlace(interaction, index));
                        break;
                    case INTERACTION_TYPES.REMOVE_SAVE:
                    case INTERACTION_TYPES.DISMISS:
                    case INTERACTION_TYPES.DISLIKE:
                    case INTERACTION_TYPES.NOT_INTERESTED:
                        savedByPlace.delete(pid);
                        break;
                    default:
                        break;
                }
            });

            setSaved(Array.from(savedByPlace.values()));
        } catch (err) {
            setError(getApiErrorMessage(err, "Unable to load saved places."));
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    }, []);

    const handleRefresh = useCallback(async () => {
        try {
            setRefreshing(true);
            await loadSaved({ silent: true });
        } finally {
            setRefreshing(false);
        }
    }, [loadSaved]);

    const handleDismiss = useCallback(async (place, opts = {}) => {
        const source = opts.source ?? "profile_saved_places";
        try {
            // v18: removing from the Saved tab is semantically a REMOVE_SAVE
            // (not a DISMISS). Using DISMISS here doubled as a soft "stop
            // showing me" signal, which is too aggressive — the user might
            // still want this place to surface elsewhere.
            await createInteraction({
                placeId: place.placeId,
                actionType: INTERACTION_TYPES.REMOVE_SAVE,
                metadata: {
                    source,
                    place,
                },
            });
            setSaved((current) =>
                current.filter((item) => item.placeId !== place.placeId),
            );
        } catch (err) {
            Alert.alert("Unable to remove", getApiErrorMessage(err));
        }
    }, []);

    return {
        loading,
        error,
        saved,
        refreshing,
        loadSaved,
        handleRefresh,
        handleDismiss,
    };
}
