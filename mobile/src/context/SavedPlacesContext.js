/**
 * SavedPlacesContext — app-wide saved places list with instant cache + SWR.
 */

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import { useAuth } from "./AuthContext";
import {
    getSavedPlacesSnapshot,
    hydrateSavedPlaces,
    invalidateSavedPlaces,
    optimisticAddSavedPlace,
    optimisticRemoveSavedPlace,
    resetSavedPlacesStore,
    subscribeSavedPlaces,
} from "../store/savedPlacesStore";
import { getApiErrorMessage } from "../utils/api";

const SavedPlacesContext = createContext(null);

export function SavedPlacesProvider({ children }) {
    const { user, ready } = useAuth();
    const uid = user?.uid ?? null;

    const snapshot = useSyncExternalStore(
        subscribeSavedPlaces,
        getSavedPlacesSnapshot,
        getSavedPlacesSnapshot,
    );

    const [error, setError] = useState("");

    useEffect(() => {
        if (!ready) return;
        if (!uid) {
            resetSavedPlacesStore(null);
            setError("");
            return;
        }

        hydrateSavedPlaces(uid, { silent: true }).catch((err) => {
            if (__DEV__) {
                console.warn("[SavedPlaces] hydrate failed:", err?.message ?? err);
            }
        });
    }, [ready, uid]);

    const loadSaved = useCallback(
        async (opts = {}) => {
            if (!uid) return [];
            const force = opts.force === true;
            const silent = opts.silent === true;
            try {
                setError("");
                return await hydrateSavedPlaces(uid, { force, silent });
            } catch (err) {
                setError(getApiErrorMessage(err, "Unable to load saved places."));
                return snapshot.places;
            }
        },
        [uid, snapshot.places],
    );

    const handleRefresh = useCallback(async () => {
        if (!uid) return;
        try {
            setError("");
            await hydrateSavedPlaces(uid, { force: true, silent: true });
        } catch (err) {
            setError(getApiErrorMessage(err, "Unable to refresh saved places."));
        }
    }, [uid]);

    const value = useMemo(
        () => ({
            loading: snapshot.loading && snapshot.places.length === 0,
            refreshing: snapshot.loading && snapshot.places.length > 0,
            hasCache: snapshot.hasCache,
            error,
            saved: snapshot.places,
            loadSaved,
            handleRefresh,
            optimisticAddSavedPlace: (place) =>
                optimisticAddSavedPlace(uid, place),
            optimisticRemoveSavedPlace: (placeId) =>
                optimisticRemoveSavedPlace(uid, placeId),
            invalidate: () => invalidateSavedPlaces(uid),
        }),
        [
            snapshot.loading,
            snapshot.places,
            snapshot.hasCache,
            error,
            loadSaved,
            handleRefresh,
            uid,
        ],
    );

    return (
        <SavedPlacesContext.Provider value={value}>
            {children}
        </SavedPlacesContext.Provider>
    );
}

export function useSavedPlacesContext() {
    const ctx = useContext(SavedPlacesContext);
    if (!ctx) {
        throw new Error(
            "useSavedPlacesContext must be used within SavedPlacesProvider",
        );
    }
    return ctx;
}
