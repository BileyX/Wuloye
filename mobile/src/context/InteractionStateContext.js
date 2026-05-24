/**
 * InteractionStateContext — single source of truth for per-place interaction
 * state across the whole app.
 *
 * Why it exists:
 *   Before this provider, every screen kept its own `likedPlaceIds` / `savedPlaceIds`
 *   Sets in local React state. The Sets were initialised empty on mount and never
 *   hydrated from the server, so:
 *     - heart/bookmark icons reset on every screen mount and app restart
 *     - a place saved in HomeScreen looked unsaved in PlaceDetailScreen
 *     - dismissed/disliked places had no shared memory between feeds
 *
 *   The context owns:
 *     - liked / saved / disliked / dismissed / notInterested Sets, hydrated once
 *       from GET /interactions on first load
 *     - canonical mutation handlers (markLiked, markSaved, markDisliked, ...)
 *       that fire the API, update the Set optimistically, and bust the feed cache
 *       so the very next recommendation request sees the new state
 *
 * Screens import `useInteractionState()` and use:
 *     const { liked, saved, disliked, markLiked, markSaved, ... } = useInteractionState()
 */

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { InteractionManager } from "react-native";
import {
    createInteraction,
    getInteractions,
} from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { unwrapApiData } from "../utils/api";
import { clearFeedCache } from "../utils/feedCache";
import { slimPlaceMetadata } from "../utils/placeMetadata";
import { useAuth } from "./AuthContext";

const InteractionStateContext = createContext(null);

// Build the canonical per-place sets from the user's full interaction history.
// The replay is ordered oldest → newest so that the latest action wins; a save
// undoes an earlier dismiss, a dislike undoes an earlier like, etc.
function rebuildSetsFromInteractions(interactions) {
    const liked         = new Set();
    const saved         = new Set();
    const disliked      = new Set();
    const dismissed     = new Set();
    const notInterested = new Set();

    if (!Array.isArray(interactions) || interactions.length === 0) {
        return { liked, saved, disliked, dismissed, notInterested };
    }

    // Sort oldest → newest so the most recent action overrides earlier ones.
    const ordered = [...interactions].sort((a, b) => {
        const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ta - tb;
    });

    for (const ix of ordered) {
        const pid = ix?.placeId;
        if (!pid) continue;
        const action = ix?.actionType;

        switch (action) {
            case INTERACTION_TYPES.LIKE:
                liked.add(pid);
                disliked.delete(pid);
                break;
            case INTERACTION_TYPES.SAVE:
                saved.add(pid);
                dismissed.delete(pid);
                disliked.delete(pid);
                break;
            case INTERACTION_TYPES.REMOVE_SAVE:
                saved.delete(pid);
                break;
            case INTERACTION_TYPES.DISLIKE:
                disliked.add(pid);
                liked.delete(pid);
                saved.delete(pid);
                break;
            case INTERACTION_TYPES.DISMISS:
                dismissed.add(pid);
                saved.delete(pid);
                break;
            case INTERACTION_TYPES.NOT_INTERESTED:
                notInterested.add(pid);
                liked.delete(pid);
                saved.delete(pid);
                dismissed.add(pid);
                break;
            default:
                break;
        }
    }

    return { liked, saved, disliked, dismissed, notInterested };
}

export function InteractionStateProvider({ children }) {
    const { user, ready } = useAuth();

    const [liked,         setLiked]         = useState(() => new Set());
    const [saved,         setSaved]         = useState(() => new Set());
    const [disliked,      setDisliked]      = useState(() => new Set());
    const [dismissed,     setDismissed]     = useState(() => new Set());
    const [notInterested, setNotInterested] = useState(() => new Set());

    const [hydrated, setHydrated] = useState(false);
    const hydrationKeyRef = useRef(null);

    // ── Hydrate from GET /interactions once per signed-in user ───────────────

    const hydrate = useCallback(async () => {
        try {
            const envelope = await getInteractions();
            const interactions = unwrapApiData(envelope, []);
            const next = rebuildSetsFromInteractions(interactions);
            setLiked(next.liked);
            setSaved(next.saved);
            setDisliked(next.disliked);
            setDismissed(next.dismissed);
            setNotInterested(next.notInterested);
        } catch (err) {
            if (__DEV__) {
                console.warn("[InteractionState] hydrate failed:", err?.message ?? err);
            }
        } finally {
            setHydrated(true);
        }
    }, []);

    useEffect(() => {
        if (!ready) return;
        const uid = user?.uid ?? null;
        if (!uid) {
            // Signed out — wipe local state.
            setLiked(new Set());
            setSaved(new Set());
            setDisliked(new Set());
            setDismissed(new Set());
            setNotInterested(new Set());
            setHydrated(true);
            hydrationKeyRef.current = null;
            return;
        }
        if (hydrationKeyRef.current === uid) return;
        hydrationKeyRef.current = uid;
        setHydrated(false);
        hydrate();
    }, [ready, user?.uid, hydrate]);

    // ── Helpers ──────────────────────────────────────────────────────────────

    const bustFeedCaches = useCallback(() => {
        clearFeedCache();
    }, []);

    const scheduleAfterUI = useCallback((fn) => {
        InteractionManager.runAfterInteractions(() => {
            fn();
        });
    }, []);

    const fireInteraction = useCallback(async (placeId, actionType, metadata) => {
        if (!placeId) return;
        try {
            await createInteraction({
                placeId,
                actionType,
                metadata: metadata ?? null,
            });
        } catch (err) {
            if (__DEV__) {
                console.warn(
                    "[InteractionState] interaction failed:",
                    actionType,
                    err?.message ?? err,
                );
            }
        }
    }, []);

    const persistInteraction = useCallback(
        (placeId, actionType, metadata, bustCache = true) => {
            scheduleAfterUI(() => {
                fireInteraction(placeId, actionType, metadata);
                if (bustCache) bustFeedCaches();
            });
        },
        [bustFeedCaches, fireInteraction, scheduleAfterUI],
    );

    // ── Public mutation handlers ─────────────────────────────────────────────

    const markLiked = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setLiked((s) => mutSet(s, placeId, true));
            setDisliked((s) => mutSet(s, placeId, false));
            persistInteraction(placeId, INTERACTION_TYPES.LIKE, {
                source,
                place: slimPlaceMetadata(place),
            });
            return true;
        },
        [persistInteraction],
    );

    const markUnliked = useCallback(
        ({ placeId }) => {
            if (!placeId) return false;
            setLiked((s) => mutSet(s, placeId, false));
            // No "unlike" interaction type — the server treats absence as neutral.
            return true;
        },
        [],
    );

    const markSaved = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setSaved((s) => mutSet(s, placeId, true));
            setDismissed((s) => mutSet(s, placeId, false));
            setDisliked((s) => mutSet(s, placeId, false));
            persistInteraction(placeId, INTERACTION_TYPES.SAVE, {
                source,
                place: slimPlaceMetadata(place),
            });
            return true;
        },
        [persistInteraction],
    );

    const markRemoveSave = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setSaved((s) => mutSet(s, placeId, false));
            persistInteraction(placeId, INTERACTION_TYPES.REMOVE_SAVE, {
                source,
                place: slimPlaceMetadata(place),
            });
            return true;
        },
        [persistInteraction],
    );

    const markDisliked = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setDisliked((s) => mutSet(s, placeId, true));
            setLiked((s) => mutSet(s, placeId, false));
            setSaved((s) => mutSet(s, placeId, false));
            persistInteraction(placeId, INTERACTION_TYPES.DISLIKE, {
                source,
                place: slimPlaceMetadata(place),
            });
            return true;
        },
        [persistInteraction],
    );

    const markDismissed = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setDismissed((s) => mutSet(s, placeId, true));
            setSaved((s) => mutSet(s, placeId, false));
            // Soft signal — hide now; defer network + cache bust so the card animates first.
            persistInteraction(
                placeId,
                INTERACTION_TYPES.DISMISS,
                { source, place: slimPlaceMetadata(place) },
                false,
            );
            return true;
        },
        [persistInteraction],
    );

    const markNotInterested = useCallback(
        ({ placeId, place = null, source = "feed" }) => {
            if (!placeId) return false;
            setNotInterested((s) => mutSet(s, placeId, true));
            setLiked((s) => mutSet(s, placeId, false));
            setSaved((s) => mutSet(s, placeId, false));
            setDismissed((s) => mutSet(s, placeId, true));
            persistInteraction(placeId, INTERACTION_TYPES.NOT_INTERESTED, {
                source,
                place: slimPlaceMetadata(place),
            });
            return true;
        },
        [persistInteraction],
    );

    // ── Predicates ───────────────────────────────────────────────────────────

    const isLiked         = useCallback((pid) => liked.has(pid),         [liked]);
    const isSaved         = useCallback((pid) => saved.has(pid),         [saved]);
    const isDisliked      = useCallback((pid) => disliked.has(pid),      [disliked]);
    const isDismissed     = useCallback((pid) => dismissed.has(pid),     [dismissed]);
    const isNotInterested = useCallback((pid) => notInterested.has(pid), [notInterested]);

    const value = useMemo(
        () => ({
            hydrated,
            liked,
            saved,
            disliked,
            dismissed,
            notInterested,
            isLiked,
            isSaved,
            isDisliked,
            isDismissed,
            isNotInterested,
            markLiked,
            markUnliked,
            markSaved,
            markRemoveSave,
            markDisliked,
            markDismissed,
            markNotInterested,
            refresh: hydrate,
            bustFeedCaches,
        }),
        [
            hydrated,
            liked,
            saved,
            disliked,
            dismissed,
            notInterested,
            isLiked,
            isSaved,
            isDisliked,
            isDismissed,
            isNotInterested,
            markLiked,
            markUnliked,
            markSaved,
            markRemoveSave,
            markDisliked,
            markDismissed,
            markNotInterested,
            hydrate,
            bustFeedCaches,
        ],
    );

    return (
        <InteractionStateContext.Provider value={value}>
            {children}
        </InteractionStateContext.Provider>
    );
}

export function useInteractionState() {
    const ctx = useContext(InteractionStateContext);
    if (!ctx) {
        throw new Error(
            "useInteractionState must be used within InteractionStateProvider",
        );
    }
    return ctx;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mutSet(prev, value, present) {
    if (present === prev.has(value)) return prev;
    const next = new Set(prev);
    if (present) next.add(value);
    else next.delete(value);
    return next;
}
