/**
 * savedPlacesStore.js — shared saved-places cache with stale-while-revalidate.
 *
 * Memory cache for instant UI + AsyncStorage for cold starts. Dedupes in-flight
 * network requests so multiple screens mounting at once share one fetch.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "react-native";
import { getSavedPlaces as fetchSavedPlacesFromApi } from "../api/placeApi";
import { getInteractions } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { unwrapApiData } from "../utils/api";
import { enrichPlaceLocation } from "../utils/placeLocation";
import { asSavedPlace } from "../utils/savedPlaceHelpers";
import { toPlacePhotoAbsoluteUri } from "../components/AuthenticatedPlacePhoto";

const STORAGE_PREFIX = "@wuloye/saved_places/v1/";
const MEMORY_TTL_MS = 3 * 60 * 1000;
const STALE_OK_MS = 10 * 60 * 1000;

/** @type {{ uid: string|null, places: object[], fetchedAt: number, hydrating: boolean }} */
let state = {
    uid: null,
    places: [],
    fetchedAt: 0,
    hydrating: false,
};

/** Cached snapshot — must keep stable reference until state changes (React 19 useSyncExternalStore). */
let snapshot = buildSnapshot();

function buildSnapshot() {
    return {
        places: state.places,
        loading: state.hydrating,
        hasCache: state.places.length > 0 || isUsable(state.fetchedAt),
        uid: state.uid,
    };
}

function refreshSnapshot() {
    snapshot = buildSnapshot();
}

/** @type {Promise<object[]>|null} */
let inFlight = null;

/** @type {Set<() => void>} */
const listeners = new Set();

function notify() {
    refreshSnapshot();
    listeners.forEach((fn) => fn());
}

function storageKey(uid) {
    return `${STORAGE_PREFIX}${uid}`;
}

function normalizePlaces(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((p, idx) =>
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
}

function prefetchSavedPlaceImages(places) {
    if (!Array.isArray(places) || places.length === 0) return;
    places.slice(0, 10).forEach((place) => {
        const uri = toPlacePhotoAbsoluteUri(place?.images?.[0]);
        if (uri) Image.prefetch(uri).catch(() => null);
    });
}

async function loadFromDisk(uid) {
    try {
        const raw = await AsyncStorage.getItem(storageKey(uid));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.places)) return null;
        return {
            places: normalizePlaces(parsed.places),
            fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
        };
    } catch {
        return null;
    }
}

async function persistToDisk(uid, places) {
    try {
        await AsyncStorage.setItem(
            storageKey(uid),
            JSON.stringify({ places, fetchedAt: Date.now() }),
        );
    } catch {
        // Non-fatal — memory cache still works this session.
    }
}

async function fetchFromLegacyInteractions() {
    const envelope = await getInteractions();
    const interactions = unwrapApiData(envelope, []);
    const ordered = Array.isArray(interactions) ? interactions : [];
    const savedByPlace = new Map();

    ordered.forEach((interaction, index) => {
        const pid = interaction?.placeId;
        if (!pid) return;

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

    return Array.from(savedByPlace.values());
}

async function fetchFromNetwork() {
    const fromServer = await fetchSavedPlacesFromApi();
    if (Array.isArray(fromServer)) {
        return normalizePlaces(fromServer);
    }
    return fetchFromLegacyInteractions();
}

function isFresh(fetchedAt) {
    return fetchedAt > 0 && Date.now() - fetchedAt < MEMORY_TTL_MS;
}

function isUsable(fetchedAt) {
    return fetchedAt > 0 && Date.now() - fetchedAt < STALE_OK_MS;
}

/**
 * @returns {{ places: object[], loading: boolean, hasCache: boolean, uid: string|null }}
 */
export function getSavedPlacesSnapshot() {
    return snapshot;
}

/** @param {() => void} listener */
export function subscribeSavedPlaces(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Hydrate from disk then optionally refresh from network (SWR).
 *
 * @param {string} uid
 * @param {{ force?: boolean, silent?: boolean }} [opts]
 */
export async function hydrateSavedPlaces(uid, opts = {}) {
    const force = opts.force === true;
    const silent = opts.silent !== false;

    if (!uid) {
        state = { uid: null, places: [], fetchedAt: 0, hydrating: false };
        notify();
        return state.places;
    }

    if (state.uid !== uid) {
        state = { uid, places: [], fetchedAt: 0, hydrating: true };
        notify();

        const disk = await loadFromDisk(uid);
        if (disk?.places?.length) {
            state = {
                uid,
                places: disk.places,
                fetchedAt: disk.fetchedAt,
                hydrating: !silent,
            };
            notify();
            prefetchSavedPlaceImages(disk.places);
        }
    }

    const shouldFetch = force || !isFresh(state.fetchedAt);
    if (!shouldFetch) {
        state = { ...state, hydrating: false };
        notify();
        return state.places;
    }

    if (inFlight) {
        if (!silent && state.places.length === 0) {
            state = { ...state, hydrating: true };
            notify();
        }
        try {
            const places = await inFlight;
            if (state.uid === uid) {
                state = {
                    uid,
                    places,
                    fetchedAt: Date.now(),
                    hydrating: false,
                };
                notify();
            }
            return places;
        } catch {
            state = { ...state, hydrating: false };
            notify();
            return state.places;
        }
    }

    if (!silent && state.places.length === 0) {
        state = { ...state, hydrating: true };
        notify();
    }

    inFlight = (async () => {
        try {
            const places = await fetchFromNetwork();
            if (state.uid === uid) {
                state = {
                    uid,
                    places,
                    fetchedAt: Date.now(),
                    hydrating: false,
                };
                persistToDisk(uid, places);
                prefetchSavedPlaceImages(places);
                notify();
            }
            return places;
        } finally {
            inFlight = null;
        }
    })();

    try {
        return await inFlight;
    } catch (err) {
        state = { ...state, hydrating: false };
        notify();
        throw err;
    }
}

/** @param {string|null} uid */
export function resetSavedPlacesStore(uid = null) {
    state = {
        uid,
        places: [],
        fetchedAt: 0,
        hydrating: false,
    };
    inFlight = null;
    notify();
}

/** @param {string} uid @param {object} place */
export function optimisticAddSavedPlace(uid, place) {
    if (!uid || !place?.placeId) return;
    if (state.uid !== uid) return;

    const pid = place.placeId ?? place.id;
    const next = normalizePlaces([
        place,
        ...state.places.filter((p) => (p.placeId ?? p.id) !== pid),
    ]);
    state = { ...state, places: next, fetchedAt: Date.now() };
    persistToDisk(uid, next);
    notify();
}

/** @param {string} uid @param {string} placeId */
export function optimisticRemoveSavedPlace(uid, placeId) {
    if (!uid || !placeId || state.uid !== uid) return;
    const next = state.places.filter(
        (p) => (p.placeId ?? p.id) !== placeId,
    );
    state = { ...state, places: next, fetchedAt: Date.now() };
    persistToDisk(uid, next);
    notify();
}

/** @param {string} uid */
export function invalidateSavedPlaces(uid) {
    if (!uid) return;
    state = { ...state, fetchedAt: 0 };
    AsyncStorage.removeItem(storageKey(uid)).catch(() => null);
    notify();
}
