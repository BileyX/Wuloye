import { useCallback, useEffect, useRef, useState } from "react";
import {
    getRecommendations,
    parseRecommendationsResponse,
} from "../api/recommendationApi";
import { getApiErrorMessage } from "../utils/api";
import {
    buildFeedCacheKey,
    getFeedCache,
    setFeedCache,
} from "../utils/feedCache";

/**
 * Recommendation feed loader with stale-while-revalidate caching.
 *
 * @param {object} options
 * @param {(filter: string) => object} options.buildParams
 * @param {(recommendations: object[], meta: object|null, filter: string) => object[]} options.transformResults
 * @param {string} options.scope
 * @param {string} options.filter
 * @param {{ coords?: { latitude?: number, longitude?: number } }|null} options.geoLocation
 * @param {boolean} [options.geoPrimed=true]
 * @param {string|null} [options.religion]
 * @param {boolean} [options.enabled=true]
 */
export function useRecommendationsFeed({
    buildParams,
    transformResults,
    scope,
    filter,
    geoLocation,
    geoPrimed = true,
    religion = null,
    enabled = true,
}) {
    const [places, setPlaces] = useState([]);
    const [aiMeta, setAiMeta] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");

    const requestIdRef = useRef(0);
    const hasPlacesRef = useRef(false);

    const cacheKey = buildFeedCacheKey({
        scope,
        filter: filter ?? "all",
        lat: geoLocation?.coords?.latitude ?? null,
        lng: geoLocation?.coords?.longitude ?? null,
        religion,
    });

    const load = useCallback(
        async (opts = {}) => {
            const { showFullLoader = false } = opts;
            if (!enabled) return;

            const reqId = ++requestIdRef.current;

            const cached = getFeedCache(cacheKey);
            if (cached?.places?.length) {
                setPlaces(cached.places);
                setAiMeta(cached.aiMeta);
                hasPlacesRef.current = true;
                setLoading(false);
                setError("");
            } else if (showFullLoader && !hasPlacesRef.current) {
                setLoading(true);
            }

            try {
                setError("");
                const envelope = await getRecommendations(buildParams(filter));
                if (reqId !== requestIdRef.current) return;

                const { recommendations, meta } =
                    parseRecommendationsResponse(envelope);

                const raw = Array.isArray(recommendations) ? recommendations : [];
                const processed = transformResults(raw, meta, filter);

                setPlaces(processed);
                setAiMeta(meta?.ai ?? null);
                hasPlacesRef.current = processed.length > 0;
                setFeedCache(cacheKey, processed, meta?.ai ?? null);
            } catch (err) {
                if (reqId !== requestIdRef.current) return;
                if (!hasPlacesRef.current) {
                    setError(
                        getApiErrorMessage(err, "Unable to load recommendations."),
                    );
                }
            } finally {
                if (reqId === requestIdRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [enabled, cacheKey, buildParams, transformResults, filter],
    );

    useEffect(() => {
        if (!geoPrimed || !enabled) return;
        const cached = getFeedCache(cacheKey);
        load({ showFullLoader: !cached?.places?.length });
    }, [geoPrimed, enabled, cacheKey, load]);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        await load({ showFullLoader: false });
    }, [load]);

    return {
        places,
        setPlaces,
        aiMeta,
        loading,
        refreshing,
        setRefreshing,
        error,
        refresh,
        cacheKey,
    };
}
