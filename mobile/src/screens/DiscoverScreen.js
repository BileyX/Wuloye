import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Alert,
    Animated,
    FlatList,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useAppTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import { useInteractionState } from "../context/InteractionStateContext";
import { createInteraction, createInteractionsBatch } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { normalisePlace } from "../utils/recommendationPlaces";
import { removePlaceFromList } from "../utils/feedAnimations";
import {
    filterDiscoverItemsByCategory,
    filterReligiousPlacesByUserReligion,
} from "../utils/discoverCategory";
import { getApiErrorMessage } from "../utils/api";
import PlaceListSkeleton from "../components/PlaceListSkeleton";
import DiscoverCard from "../components/DiscoverCard";
import FloatingChatButton from "../components/FloatingChatButton";
import useLocation from "../hooks/useLocation";
import { useRecommendationsFeed } from "../hooks/useRecommendationsFeed";
import {
    buildFeedCacheKey,
    getFeedCache,
    setFeedCache,
} from "../utils/feedCache";
import {
    getRecommendations,
    parseRecommendationsResponse,
} from "../api/recommendationApi";
import { prefetchPlaceDetails } from "../api/placeApi";
import { prefetchEventById } from "../api/eventsApi";

function prefetchDiscoverDetail(place) {
    if (!place) return;
    if (place.category === "event" && place._eventForDetail?.id) {
        prefetchEventById(place._eventForDetail.id);
        return;
    }
    prefetchPlaceDetails(place.placeId ?? place.id);
}

// ─── Filter definitions (keys must match backend `discoverCategory` + `resolveDiscoverFilter`) ──

const FILTERS = [
    {
        key: "all",
        label: "All",
        iconLib: "Ionicons",
        icon: "apps-outline",
    },
    {
        key: "gym",
        label: "Gym",
        iconLib: "Ionicons",
        icon: "barbell-outline",
    },
    {
        key: "cafe",
        label: "Café",
        iconLib: "Ionicons",
        icon: "cafe-outline",
    },
    {
        key: "hotel",
        label: "Hotel",
        iconLib: "Ionicons",
        icon: "bed-outline",
    },
    {
        key: "sports",
        label: "Sports",
        iconLib: "Ionicons",
        icon: "basketball-outline",
    },
    {
        key: "event",
        label: "Events",
        iconLib: "Ionicons",
        icon: "calendar-outline",
    },
    {
        key: "church",
        label: "Church",
        iconLib: "MaterialCommunity",
        icon: "church",
    },
    {
        key: "workspace",
        label: "Workspace",
        iconLib: "Ionicons",
        icon: "briefcase-outline",
    },
];

function discoverApiFilter(selectedFilter) {
    return !selectedFilter || selectedFilter === "all"
        ? null
        : selectedFilter;
}

function FilterIcon({ lib, name, color, size }) {
    if (lib === "MaterialCommunity") {
        return <MaterialCommunityIcons name={name} color={color} size={size} />;
    }
    return <Ionicons name={name} color={color} size={size} />;
}

// ─── MapPlaceholder ───────────────────────────────────────────────────────────

function MapPlaceholder({ palette, isDark, count }) {
    return (
        <View
            style={{
                height: 168,
                borderRadius: 20,
                overflow: "hidden",
                marginBottom: 20,
                borderWidth: 1,
                borderColor: palette.borderStrong,
            }}
        >
            <LinearGradient
                colors={
                    isDark
                        ? ["#0C2040", "#0E2D50", "#0B3428"]
                        : ["#C8EEFF", "#D8F5E8", "#E6F8F2"]
                }
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
                {/* Grid lines decoration */}
                <View
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        opacity: 0.18,
                    }}
                >
                    {[20, 60, 100, 140].map((y) => (
                        <View
                            key={y}
                            style={{
                                position: "absolute",
                                top: y,
                                left: 0,
                                right: 0,
                                height: 1,
                                backgroundColor: palette.oceanBlue,
                            }}
                        />
                    ))}
                    {[60, 130, 200, 270, 340].map((x) => (
                        <View
                            key={x}
                            style={{
                                position: "absolute",
                                left: x,
                                top: 0,
                                bottom: 0,
                                width: 1,
                                backgroundColor: palette.oceanBlue,
                            }}
                        />
                    ))}
                </View>

                <View
                    style={{
                        width: 52,
                        height: 52,
                        borderRadius: 26,
                        backgroundColor: "rgba(255,255,255,0.18)",
                        borderWidth: 2,
                        borderColor: palette.oceanBlue,
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 8,
                    }}
                >
                    <Ionicons
                        name="location"
                        size={24}
                        color={palette.oceanBlue}
                    />
                </View>
                <Text
                    style={{
                        color: palette.textPrimary,
                        fontWeight: "800",
                        fontSize: 15,
                    }}
                >
                    Map View
                </Text>
                <Text
                    style={{
                        color: palette.textSecondary,
                        fontSize: 12,
                        marginTop: 2,
                    }}
                >
                    {count > 0
                        ? `${count} place${count !== 1 ? "s" : ""} nearby`
                        : "Searching nearby…"}
                </Text>

                {/* Location button */}
                <View
                    style={{
                        position: "absolute",
                        top: 12,
                        right: 12,
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        backgroundColor: isDark
                            ? "rgba(18,38,62,0.9)"
                            : "rgba(255,255,255,0.9)",
                        borderWidth: 1,
                        borderColor: palette.borderStrong,
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <Ionicons
                        name="navigate"
                        size={16}
                        color={palette.oceanBlue}
                    />
                </View>
            </LinearGradient>
        </View>
    );
}

// ─── AI Banner ────────────────────────────────────────────────────────────────

function AIBanner({ palette, isDark, count, filter }) {
    const filterLabel =
        filter
            ? FILTERS.find((f) => f.key === filter)?.label ?? filter
            : "your preferences";
    return (
        <LinearGradient
            colors={
                isDark
                    ? ["rgba(20,62,102,0.9)", "rgba(12,50,80,0.92)", "rgba(10,50,35,0.9)"]
                    : [
                          "rgba(141,219,255,0.82)",
                          "rgba(77,182,255,0.78)",
                          "rgba(74,210,152,0.76)",
                      ]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
                borderRadius: 16,
                padding: 14,
                marginBottom: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderWidth: 1,
                borderColor: isDark
                    ? "rgba(130,205,255,0.28)"
                    : "rgba(255,255,255,0.6)",
            }}
        >
            <View
                style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: isDark
                        ? "rgba(30,80,130,0.7)"
                        : "rgba(255,255,255,0.3)",
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: isDark
                        ? "rgba(130,205,255,0.4)"
                        : "rgba(255,255,255,0.6)",
                }}
            >
                <Ionicons
                    name="star"
                    size={18}
                    color={palette.iceWhite}
                />
            </View>
            <View style={{ flex: 1 }}>
                <Text
                    style={{
                        color: palette.iceWhite,
                        fontWeight: "800",
                        fontSize: 14,
                    }}
                >
                    AI Recommendation
                </Text>
                <Text
                    style={{
                        color: "rgba(248,254,255,0.88)",
                        fontSize: 12,
                        marginTop: 2,
                        lineHeight: 17,
                    }}
                >
                    {count > 0
                        ? `Found ${count} place${count !== 1 ? "s" : ""} that fit${count === 1 ? "s" : ""} ${filterLabel}`
                        : `Searching places that match ${filterLabel}…`}
                </Text>
            </View>
        </LinearGradient>
    );
}

// ─── Nearby Banner ────────────────────────────────────────────────────────────

function NearbyBanner({ palette, isDark, count }) {
    return (
        <LinearGradient
            colors={
                isDark
                    ? ["rgba(10,40,80,0.92)", "rgba(8,30,60,0.94)", "rgba(10,50,40,0.9)"]
                    : [
                          "rgba(77,182,255,0.82)",
                          "rgba(74,210,152,0.78)",
                          "rgba(141,219,255,0.76)",
                      ]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
                borderRadius: 16,
                padding: 14,
                marginBottom: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderWidth: 1,
                borderColor: isDark
                    ? "rgba(100,200,255,0.26)"
                    : "rgba(255,255,255,0.6)",
            }}
        >
            <View
                style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: isDark
                        ? "rgba(20,60,110,0.7)"
                        : "rgba(255,255,255,0.3)",
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: isDark
                        ? "rgba(100,200,255,0.4)"
                        : "rgba(255,255,255,0.6)",
                }}
            >
                <Ionicons name="navigate" size={18} color={palette.iceWhite} />
            </View>
            <View style={{ flex: 1 }}>
                <Text
                    style={{
                        color: palette.iceWhite,
                        fontWeight: "800",
                        fontSize: 14,
                    }}
                >
                    Places Near You
                </Text>
                <Text
                    style={{
                        color: "rgba(248,254,255,0.88)",
                        fontSize: 12,
                        marginTop: 2,
                        lineHeight: 17,
                    }}
                >
                    {count > 0
                        ? `${count} place${count !== 1 ? "s" : ""} sorted by proximity`
                        : "Finding places close to you…"}
                </Text>
            </View>
        </LinearGradient>
    );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function DiscoverScreen({ navigation, route }) {
    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(() => createStyles(palette, isDark), [palette, isDark]);
    const { profile } = useAuth();

    // Detect nearby mode from route params (e.g. from HomeScreen "Nearby" chip)
    const routeMode = route?.params?.mode ?? null;
    const isNearbyMode = routeMode === "nearby";

    const [selectedFilter, setSelectedFilter] = useState("all");
    // v18: liked/saved/disliked now live in the shared interaction store
    // (single source of truth across every screen + app restart).
    const {
        liked: likedPlaceIds,
        saved: savedPlaceIds,
        disliked: dislikedPlaceIds,
        dismissed: dismissedPlaceIds,
        markLiked,
        markSaved,
        markRemoveSave,
        markDisliked,
        markDismissed,
    } = useInteractionState();

    const headerAnim = useRef(new Animated.Value(0)).current;
    const { location: geoLocation, requestCurrentLocation } = useLocation();
    const [geoPrimed, setGeoPrimed] = useState(false);

    const userReligion = profile?.religion ?? null;

    // Strip places the user has disliked or dismissed so they never resurface
    // after a server re-fetch (same logic as HomeScreen.filterNegative).
    const filterNegative = useCallback(
        (list) => {
            if (!Array.isArray(list) || (dislikedPlaceIds.size === 0 && dismissedPlaceIds.size === 0)) {
                return list;
            }
            return list.filter((p) => {
                const id = p.placeId ?? p.id;
                return !dislikedPlaceIds.has(id) && !dismissedPlaceIds.has(id);
            });
        },
        [dislikedPlaceIds, dismissedPlaceIds],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await requestCurrentLocation();
            if (!cancelled) setGeoPrimed(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [requestCurrentLocation]);

    // Header entrance animation
    useEffect(() => {
        Animated.timing(headerAnim, {
            toValue: 1,
            duration: 420,
            useNativeDriver: true,
        }).start();
    }, [headerAnim]);

    const buildParams = useCallback(
        (selected) => {
            const filter = discoverApiFilter(selected);
            const params = {};
            if (isNearbyMode) params.mode = "nearby";
            if (filter) {
                params.category = filter;
                params.type = filter;
                params.fast = "true";
            }
            const lat = geoLocation?.coords?.latitude;
            const lng = geoLocation?.coords?.longitude;
            if (typeof lat === "number" && typeof lng === "number") {
                params.lat = lat;
                params.lng = lng;
                params.radius = isNearbyMode ? 8 : 5;
            }
            return params;
        },
        [isNearbyMode, geoLocation],
    );

    const transformResults = useCallback(
        (recommendations, meta, filter) => {
            const mapped = recommendations.map((item, idx) =>
                normalisePlace(item, idx, meta),
            );
            const apiFilterKey = discoverApiFilter(filter);
            const categoryFiltered = filterDiscoverItemsByCategory(
                mapped,
                apiFilterKey,
            );
            if (apiFilterKey === "church" && userReligion) {
                return filterReligiousPlacesByUserReligion(
                    categoryFiltered,
                    userReligion,
                );
            }
            return categoryFiltered;
        },
        [userReligion],
    );

    const {
        places,
        setPlaces,
        aiMeta,
        loading,
        refreshing,
        setRefreshing,
        error,
        refresh,
    } = useRecommendationsFeed({
        buildParams,
        transformResults,
        scope: isNearbyMode ? "nearby" : "discover",
        filter: selectedFilter,
        geoLocation,
        geoPrimed,
        religion: userReligion,
        enabled: geoPrimed,
        filterNegative,
    });

    const lastImpressionRef = useRef("");
    useEffect(() => {
        if (!places.length) return;
        const sig = `${selectedFilter}:${places.map((p) => p.placeId).join(",")}`;
        if (lastImpressionRef.current === sig) return;
        lastImpressionRef.current = sig;
        const impressions = places.slice(0, 6).map((p) => ({
            placeId: p.placeId,
            actionType: INTERACTION_TYPES.VIEW,
            metadata: {
                source: isNearbyMode ? "nearby_feed" : "discover_feed",
                filter: selectedFilter,
                place: p,
            },
        }));
        createInteractionsBatch(impressions).catch(() => null);
    }, [places, selectedFilter, isNearbyMode]);

    async function handleRefresh() {
        setRefreshing(true);
        try {
            await refresh();
        } finally {
            setRefreshing(false);
        }
    }

    const showSkeleton = loading && !refreshing && places.length === 0;
    const showList = !showSkeleton;

    // Warm common Discover chips in the background after the first load.
    useEffect(() => {
        if (!geoPrimed) return;
        const warmKeys = ["church", "cafe", "gym", "hotel"];
        const timer = setTimeout(() => {
            warmKeys.forEach((chip) => {
                if (chip === selectedFilter) return;
                const key = buildFeedCacheKey({
                    scope: isNearbyMode ? "nearby" : "discover",
                    filter: chip,
                    lat: geoLocation?.coords?.latitude ?? null,
                    lng: geoLocation?.coords?.longitude ?? null,
                    religion: userReligion,
                });
                if (getFeedCache(key)?.places?.length) return;
                getRecommendations(buildParams(chip))
                    .then((envelope) => {
                        const { recommendations, meta } =
                            parseRecommendationsResponse(envelope);
                        const raw = Array.isArray(recommendations)
                            ? recommendations
                            : [];
                        const processed = transformResults(raw, meta, chip);
                        setFeedCache(key, processed, meta?.ai ?? null);
                    })
                    .catch(() => null);
            });
        }, 1200);
        return () => clearTimeout(timer);
    }, [
        geoPrimed,
        geoLocation,
        isNearbyMode,
        userReligion,
        buildParams,
        transformResults,
        selectedFilter,
    ]);

    function handleFilterPress(key) {
        if (key === "all") {
            setSelectedFilter("all");
            return;
        }
        setSelectedFilter((prev) => (prev === key ? "all" : key));
    }

    function handleOpenDetail(place) {
        createInteraction({
            placeId: place.placeId,
            actionType: INTERACTION_TYPES.CLICK,
            metadata: { source: "discover_feed", filter: selectedFilter, place },
        }).catch(() => null);

        if (place?.category === "event" && place?._eventForDetail) {
            const parentNav =
                typeof navigation.getParent === "function"
                    ? navigation.getParent()
                    : null;
            const target = parentNav?.navigate
                ? parentNav
                : navigation;
            target.navigate("EventDetail", {
                event: place._eventForDetail,
            });
            return;
        }

        const parent =
            typeof navigation.getParent === "function"
                ? navigation.getParent()
                : null;
        if (parent?.navigate) {
            parent.navigate("PlaceDetail", { place });
            return;
        }
        navigation.navigate("PlaceDetail", { place });
    }

    function handleSave(place) {
        const id = place.placeId ?? place.id;
        const already = savedPlaceIds.has(id);
        const meta = { source: "discover_feed", filter: selectedFilter };
        if (already) {
            markRemoveSave({ placeId: id, place, ...meta });
        } else {
            markSaved({ placeId: id, place, ...meta });
        }
    }

    function handleDismiss(place) {
        const id = place.placeId ?? place.id;
        removePlaceFromList(setPlaces, id);
        markDismissed({
            placeId: id,
            place,
            source: "discover_feed",
            filter: selectedFilter,
        });
    }

    function handleLike(place) {
        const id = place.placeId ?? place.id;
        if (likedPlaceIds.has(id)) return;
        markLiked({
            placeId: id,
            place,
            source: "discover_feed",
            filter: selectedFilter,
        });
    }

    function handleDislike(place) {
        const id = place.placeId ?? place.id;
        if (dislikedPlaceIds.has(id)) return;

        const name = place?.name?.trim() || "This place";
        const typeHint = place?.type
            ? `${place.type.replace(/_/g, " ")} places`
            : "similar places";

        Alert.alert(
            "Not for me",
            `${name} and ${typeHint} like it won't be recommended again.`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Don't recommend",
                    style: "destructive",
                    onPress: () => {
                        removePlaceFromList(setPlaces, id);
                        markDisliked({
                            placeId: id,
                            place,
                            source: "discover_feed",
                            filter: selectedFilter,
                        });
                    },
                },
            ],
        );
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    const sectionLabel =
        selectedFilter && selectedFilter !== "all"
            ? `${FILTERS.find((f) => f.key === selectedFilter)?.label ?? selectedFilter} Near You`
            : isNearbyMode
              ? "Places Near You"
              : "Near You";

    const aiBannerFilter = discoverApiFilter(selectedFilter);

    return (
        <SafeAreaView style={styles.safeArea}>
            <LinearGradient
                colors={gradients.appBackground}
                style={styles.screen}
            >
                {/* ── Header ── */}
                <Animated.View
                    style={[
                        styles.header,
                        {
                            opacity: headerAnim,
                            transform: [
                                {
                                    translateY: headerAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [-12, 0],
                                    }),
                                },
                            ],
                        },
                    ]}
                >
                    <View>
                        <Text style={styles.eyebrow}>
                            {isNearbyMode ? "Location-based" : "AI-Powered"}
                        </Text>
                        <Text style={styles.headerTitle}>
                            {isNearbyMode ? "Near You" : "Discover Nearby"}
                        </Text>
                    </View>
                    <Pressable
                        onPress={handleRefresh}
                        style={styles.refreshBtn}
                        hitSlop={8}
                    >
                        <LinearGradient
                            colors={gradients.navActivePill}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.refreshBtnGrad}
                        >
                            <Ionicons
                                name="refresh"
                                size={16}
                                color={palette.iceWhite}
                            />
                        </LinearGradient>
                    </Pressable>
                </Animated.View>

                {/* ── Filter Chips ── */}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.filterRow}
                    style={styles.filterScroll}
                >
                    {FILTERS.map((f) => {
                        const isActive = selectedFilter === f.key;
                        return (
                            <Pressable
                                key={f.key}
                                onPress={() => handleFilterPress(f.key)}
                                style={styles.filterPillWrap}
                            >
                                {isActive ? (
                                    <LinearGradient
                                        colors={gradients.navActivePill}
                                        start={{ x: 0, y: 0 }}
                                        end={{ x: 1, y: 1 }}
                                        style={styles.filterPillActive}
                                    >
                                        <FilterIcon
                                            lib={f.iconLib}
                                            name={f.icon}
                                            color={palette.iceWhite}
                                            size={14}
                                        />
                                        <Text style={styles.filterLabelActive}>
                                            {f.label}
                                        </Text>
                                    </LinearGradient>
                                ) : (
                                    <View style={styles.filterPill}>
                                        <FilterIcon
                                            lib={f.iconLib}
                                            name={f.icon}
                                            color={palette.textSecondary}
                                            size={14}
                                        />
                                        <Text style={styles.filterLabel}>
                                            {f.label}
                                        </Text>
                                    </View>
                                )}
                            </Pressable>
                        );
                    })}
                </ScrollView>

                {selectedFilter === "event" ? (
                    <Pressable
                        onPress={() => {
                            const parent =
                                typeof navigation.getParent === "function"
                                    ? navigation.getParent()
                                    : null;
                            parent?.navigate?.("Events");
                        }}
                        style={[
                            styles.eventsCalendarStrip,
                            {
                                borderColor: palette.borderStrong,
                                backgroundColor: isDark
                                    ? "rgba(18,38,62,0.78)"
                                    : "rgba(255,255,255,0.85)",
                            },
                        ]}
                    >
                        <Ionicons
                            name="calendar-outline"
                            size={20}
                            color={palette.oceanBlue}
                        />
                        <Text style={styles.eventsCalendarText}>
                            Browse full event calendar
                        </Text>
                        <Ionicons
                            name="chevron-forward"
                            size={18}
                            color={palette.textMuted}
                        />
                    </Pressable>
                ) : null}

                {/* ── Content ── */}
                {showSkeleton ? (
                    <View style={styles.loaderWrap}>
                        <PlaceListSkeleton variant="discover" count={4} />
                    </View>
                ) : null}
                {showList ? (
                    <FlatList
                        data={places}
                        keyExtractor={(item) => String(item.id ?? item.placeId)}
                        showsVerticalScrollIndicator={false}
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        initialNumToRender={4}
                        maxToRenderPerBatch={6}
                        windowSize={7}
                        removeClippedSubviews
                        contentContainerStyle={styles.listContent}
                        ListHeaderComponent={() => (
                            <View>
                                <MapPlaceholder
                                    palette={palette}
                                    isDark={isDark}
                                    count={places.length}
                                />

                                {!error && places.length > 0 && (
                                    isNearbyMode ? (
                                        <NearbyBanner
                                            palette={palette}
                                            isDark={isDark}
                                            count={places.length}
                                        />
                                    ) : (
                                        <AIBanner
                                            palette={palette}
                                            isDark={isDark}
                                            count={places.length}
                                            filter={aiBannerFilter}
                                        />
                                    )
                                )}

                                {aiMeta?.pyModelActive && aiMeta?.predictedType ? (
                                    <View style={styles.aiStatusBar}>
                                        <Ionicons
                                            name="analytics"
                                            size={11}
                                            color={palette.oceanBlue}
                                            style={{ marginRight: 5 }}
                                        />
                                        <Text style={styles.aiStatusText}>
                                            {`AI · Next predicted: ${aiMeta.predictedType.charAt(0).toUpperCase()}${aiMeta.predictedType.slice(1)}`}
                                            {aiMeta.confidence > 0
                                                ? ` · ${Math.round(aiMeta.confidence * 100)}% confidence`
                                                : ""}
                                        </Text>
                                    </View>
                                ) : null}

                                {error ? (
                                    <Text style={styles.errorText}>{error}</Text>
                                ) : null}

                                <Text style={styles.sectionLabel}>
                                    {sectionLabel}
                                </Text>
                            </View>
                        )}
                        ListEmptyComponent={
                            !loading && geoPrimed ? (
                                <View style={styles.emptyWrap}>
                                    <Ionicons
                                        name="search-outline"
                                        size={40}
                                        color={palette.textMuted}
                                        style={{ marginBottom: 12 }}
                                    />
                                    <Text style={styles.emptyTitle}>
                                        No places found
                                    </Text>
                                    <Text style={styles.emptySubtitle}>
                                        {selectedFilter && selectedFilter !== "all"
                                            ? `No ${FILTERS.find((f) => f.key === selectedFilter)?.label ?? selectedFilter} recommendations yet. Try another filter or update your profile.`
                                            : "We're still learning your taste. Update your profile to improve recommendations."}
                                    </Text>
                                </View>
                            ) : null
                        }
                        renderItem={({ item }) => (
                            <DiscoverCard
                                place={item}
                                onPress={() => handleOpenDetail(item)}
                                onPressIn={() => prefetchDiscoverDetail(item)}
                                liked={likedPlaceIds.has(item.placeId ?? item.id)}
                                saved={savedPlaceIds.has(item.placeId ?? item.id)}
                                disliked={dislikedPlaceIds.has(item.placeId ?? item.id)}
                                onLike={() => handleLike(item)}
                                onSave={() => handleSave(item)}
                                onDislike={() => handleDislike(item)}
                                onDismiss={() => handleDismiss(item)}
                            />
                        )}
                    />
                ) : null}
            </LinearGradient>
            <FloatingChatButton bottom={110} right={18} />
        </SafeAreaView>
    );
}

function createStyles(palette, isDark) {
    return StyleSheet.create({
        safeArea: {
            flex: 1,
            backgroundColor: palette.pageTop,
        },
        screen: {
            flex: 1,
            paddingHorizontal: 16,
        },
        header: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 8,
            marginBottom: 12,
        },
        eyebrow: {
            color: palette.oceanBlue,
            fontSize: 11,
            fontWeight: "800",
            letterSpacing: 1,
            textTransform: "uppercase",
        },
        headerTitle: {
            color: palette.textPrimary,
            fontSize: 26,
            fontWeight: "900",
            marginTop: 2,
        },
        refreshBtn: {
            width: 36,
            height: 36,
            borderRadius: 18,
            overflow: "hidden",
        },
        refreshBtnGrad: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
        },
        filterScroll: {
            flexGrow: 0,
            marginBottom: 12,
        },
        eventsCalendarStrip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 14,
            borderWidth: 1,
            marginBottom: 16,
        },
        eventsCalendarText: {
            flex: 1,
            color: palette.textPrimary,
            fontSize: 14,
            fontWeight: "700",
        },
        filterRow: {
            paddingRight: 16,
            gap: 8,
            flexDirection: "row",
            alignItems: "center",
        },
        filterPillWrap: {},
        filterPill: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(18,38,62,0.7)"
                : "rgba(255,255,255,0.72)",
        },
        filterPillActive: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 8,
        },
        filterLabel: {
            color: palette.textSecondary,
            fontSize: 13,
            fontWeight: "600",
        },
        filterLabelActive: {
            color: palette.iceWhite,
            fontSize: 13,
            fontWeight: "700",
        },
        loaderWrap: {
            flex: 1,
            paddingTop: 20,
        },
        listContent: {
            paddingBottom: 110,
        },
        sectionLabel: {
            color: palette.textPrimary,
            fontSize: 16,
            fontWeight: "800",
            marginBottom: 12,
        },
        aiStatusBar: {
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: isDark
                ? "rgba(14,40,70,0.8)"
                : "rgba(224,245,255,0.9)",
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 6,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: isDark
                ? "rgba(56,174,255,0.28)"
                : "rgba(56,174,255,0.22)",
        },
        aiStatusText: {
            color: palette.oceanBlue,
            fontSize: 11,
            fontWeight: "600",
        },
        errorText: {
            color: palette.danger,
            marginBottom: 10,
            fontSize: 12,
        },
        emptyWrap: {
            alignItems: "center",
            paddingVertical: 32,
            paddingHorizontal: 24,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(18,35,58,0.72)"
                : "rgba(255,255,255,0.74)",
        },
        emptyTitle: {
            color: palette.textPrimary,
            fontSize: 18,
            fontWeight: "800",
        },
        emptySubtitle: {
            color: palette.textSecondary,
            textAlign: "center",
            lineHeight: 20,
            marginTop: 8,
            fontSize: 13,
        },
    });
}
