import { useCallback } from "react";
import { Alert } from "react-native";
import { createInteraction } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { getApiErrorMessage } from "../utils/api";
import { useSavedPlacesContext } from "../context/SavedPlacesContext";
import {
    hydrateSavedPlaces,
    invalidateSavedPlaces,
} from "../store/savedPlacesStore";
import { useAuth } from "../context/AuthContext";

export { asSavedPlace } from "../utils/savedPlaceHelpers";

/**
 * Shared saved-places hook — reads from SavedPlacesProvider cache (memory +
 * AsyncStorage) and refreshes in the background (stale-while-revalidate).
 */
export function useSavedPlaces() {
    const { user } = useAuth();
    const uid = user?.uid ?? null;
    const {
        loading,
        refreshing,
        hasCache,
        error,
        saved,
        loadSaved,
        handleRefresh,
        optimisticAddSavedPlace,
        optimisticRemoveSavedPlace,
    } = useSavedPlacesContext();

    const handleDismiss = useCallback(
        async (place, opts = {}) => {
            const source = opts.source ?? "profile_saved_places";
            if (!uid || !place?.placeId) return;

            optimisticRemoveSavedPlace(place.placeId);

            try {
                await createInteraction({
                    placeId: place.placeId,
                    actionType: INTERACTION_TYPES.REMOVE_SAVE,
                    metadata: { source, place },
                });
                invalidateSavedPlaces(uid);
                hydrateSavedPlaces(uid, { force: true, silent: true }).catch(
                    () => null,
                );
            } catch (err) {
                optimisticAddSavedPlace(place);
                Alert.alert("Unable to remove", getApiErrorMessage(err));
            }
        },
        [uid, optimisticAddSavedPlace, optimisticRemoveSavedPlace],
    );

    return {
        loading: loading && !hasCache,
        refreshing,
        error,
        saved,
        loadSaved,
        handleRefresh,
        handleDismiss,
    };
}
