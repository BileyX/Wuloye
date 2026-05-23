import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import PlaceCard from "../components/PlaceCard";
import EmptyState from "../components/EmptyState";
import PlaceListSkeleton from "../components/PlaceListSkeleton";
import TopGreetingBanner from "../components/TopGreetingBanner";
import {
    createInteraction,
    createInteractionsBatch,
} from "../api/interactionApi";
import {
    getRecommendations,
    parseRecommendationsResponse,
} from "../api/recommendationApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { normalisePlace } from "../utils/recommendationPlaces";
import { getApiErrorMessage } from "../utils/api";
import {
    buildFeedCacheKey,
    getFeedCache,
    setFeedCache,
} from "../utils/feedCache";
import { useAppTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import { useNotifications } from "../context/NotificationContext";
import useLocation from "../hooks/useLocation";
import { prefetchPlaceDetails } from "../api/placeApi";
import {
    extractNavigationFromData,
    normalizeNavigateTarget,
} from "../services/notificationService";

/**
 * Greeting label: username (new onboarding v3) → legacy first name → fallback.
 * Username is now the primary identity field.
 */
function getGreetingName(profile) {
    const username = profile?.username?.trim();
    if (username) return username;
    const name = profile?.name?.trim();
    if (name) return name.split(/\s+/)[0];
    return "there";
}

function getGreetingMeta(date, name) {
    const hour = date.getHours();
    const firstName = name?.trim() || "there";

    if (hour >= 5 && hour < 12) {
        return {
            greeting: `Good morning, ${firstName}`,
            headline: "Start your day with places that match your vibe",
        };
    }

    if (hour >= 12 && hour < 17) {
        return {
            greeting: `Good afternoon, ${firstName}`,
            headline: "Take a refreshing break with a great nearby spot",
        };
    }

    if (hour >= 17 && hour < 22) {
        return {
            greeting: `Good evening, ${firstName}`,
            headline: "Unwind tonight with handpicked places for you",
        };
    }

    return {
        greeting: `Good night, ${firstName}`,
        headline: "Late hours, calm energy, and recommendations just for you",
    };
}

function notificationTypeLabel(type) {
    switch (type) {
        case "morning":
            return "Morning";
        case "afternoon":
            return "Midday";
        case "evening":
            return "Evening";
        case "dynamic":
            return "Smart pick";
        default:
            return "Update";
    }
}

function navigateFromNotificationPayload(navigation, data) {
    const raw = extractNavigationFromData(data);
    const target = normalizeNavigateTarget(raw) ?? raw;
    if (!target?.screen) return false;

    const tabScreens = [
        "Home",
        "Discover",
        "YourSchedule",
        "Events",
        "Profile",
    ];
    const parent =
        typeof navigation.getParent === "function"
            ? navigation.getParent()
            : null;
    const nav = parent ?? navigation;

    try {
        if (tabScreens.includes(target.screen)) {
            nav.navigate("MainTabs", {
                screen: target.screen,
                params: target.params ?? {},
            });
        } else {
            nav.navigate(target.screen, target.params ?? {});
        }
        return true;
    } catch {
        return false;
    }
}

function formatNotifTimeRelative(iso) {
    try {
        const d = new Date(iso);
        const now = Date.now();
        const diffMs = now - d.getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return "Just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
        });
    } catch {
        return "";
    }
}

export default function HomeScreen({ navigation }) {
    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );
    const { profile, refreshProfile } = useAuth();

    const {
        inbox,
        inboxUnreadCount,
        refreshInbox,
        markAllInboxRead,
        markInboxEntryRead,
    } = useNotifications();

    const [notifPanelOpen, setNotifPanelOpen] = useState(false);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [places, setPlaces] = useState([]);
    const [refreshing, setRefreshing] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const [aiMeta, setAiMeta] = useState(null);
    const [likedPlaceIds, setLikedPlaceIds] = useState(() => new Set());
    const [savedPlaceIds, setSavedPlaceIds] = useState(() => new Set());
    const refreshTimerRef = useRef(null);
    /** After one attempt to read GPS (success or deny) — avoids a Firestore-only flash before coords arrive. */
    const [geoPrimed, setGeoPrimed] = useState(false);

    const { location: geoLocation, requestCurrentLocation } = useLocation();

    const recommendationParams = useMemo(() => {
        const lat = geoLocation?.coords?.latitude;
        const lng = geoLocation?.coords?.longitude;
        if (typeof lat === "number" && typeof lng === "number") {
            return { lat, lng, radius: 5 };
        }
        return {};
    }, [geoLocation]);

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

    useFocusEffect(
        useCallback(() => {
            refreshInbox();
        }, [refreshInbox]),
    );

    const homeCacheKey = useMemo(
        () =>
            buildFeedCacheKey({
                scope: "home",
                filter: "all",
                lat: geoLocation?.coords?.latitude ?? null,
                lng: geoLocation?.coords?.longitude ?? null,
            }),
        [geoLocation],
    );

    const fetchData = useCallback(async () => {
        const cached = getFeedCache(homeCacheKey);
        const hadCache = Boolean(cached?.places?.length);
        if (hadCache) {
            setPlaces(cached.places);
            setAiMeta(cached.aiMeta);
            setLoading(false);
            setError("");
        } else {
            setLoading(true);
            setError("");
        }

        try {
            const [, recommendationsEnvelope] = await Promise.all([
                refreshProfile(),
                getRecommendations(recommendationParams),
            ]);

            const { recommendations, meta } = parseRecommendationsResponse(
                recommendationsEnvelope,
            );
            const mapped = Array.isArray(recommendations)
                ? recommendations.map((item, index) =>
                      normalisePlace(item, index, meta),
                  )
                : [];

            setPlaces(mapped);
            setAiMeta(meta?.ai ?? null);
            setFeedCache(homeCacheKey, mapped, meta?.ai ?? null);

            if (mapped.length > 0) {
                const impressionItems = mapped.slice(0, 8).map((place) => ({
                    placeId: place.placeId,
                    actionType: INTERACTION_TYPES.VIEW,
                    metadata: {
                        source: "home_feed",
                        place,
                    },
                }));

                createInteractionsBatch(impressionItems).catch(() => null);
            }
        } catch (err) {
            if (!hadCache) {
                setError(
                    getApiErrorMessage(err, "Unable to load recommendations."),
                );
            }
        } finally {
            setLoading(false);
        }
    }, [recommendationParams, refreshProfile, homeCacheKey]);

    useEffect(() => {
        if (!geoPrimed) return;
        fetchData();
    }, [geoPrimed, fetchData]);

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(new Date());
        }, 60000);

        return () => clearInterval(timer);
    }, []);

    // Clear any pending refresh timer on unmount
    useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

    // Re-fetch recommendations 1.5 s after an interaction so the AI has time
    // to process the signal and return updated scores on the next request.
    const scheduleRefresh = useCallback(() => {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(async () => {
            try {
                const recommendationsEnvelope = await getRecommendations(
                    recommendationParams,
                );
                const { recommendations, meta } =
                    parseRecommendationsResponse(recommendationsEnvelope);
                const mapped = Array.isArray(recommendations)
                    ? recommendations.map((item, idx) =>
                          normalisePlace(item, idx, meta),
                      )
                    : [];
                setPlaces(mapped);
                setAiMeta(meta?.ai ?? null);
            } catch {
                // silent — keep existing list if refresh fails
            }
        }, 1500);
    }, [recommendationParams]);

    async function handleRefresh() {
        try {
            setRefreshing(true);
            await fetchData();
        } finally {
            setRefreshing(false);
        }
    }

    function handleOpenDetail(place) {
        createInteraction({
            placeId: place.placeId,
            actionType: INTERACTION_TYPES.CLICK,
            metadata: {
                source: "home_feed",
                place,
            },
        }).catch(() => null);

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
        // Optimistic: mark saved immediately in the Set, then sync in background
        setSavedPlaceIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });
        createInteraction({
            placeId: id,
            actionType: INTERACTION_TYPES.SAVE,
            metadata: { source: "home_feed" },
        }).catch(() => null);
        scheduleRefresh();
    }

    function handleDismiss(place) {
        const id = place.placeId ?? place.id;
        // Optimistic: remove from list instantly
        setPlaces((current) =>
            current.filter((item) => (item.placeId ?? item.id) !== id),
        );
        createInteraction({
            placeId: id,
            actionType: INTERACTION_TYPES.DISMISS,
            metadata: { source: "home_feed" },
        }).catch(() => null);
        scheduleRefresh();
    }

    function handleLike(place) {
        const id = place.placeId ?? place.id;
        const already = likedPlaceIds.has(id);
        setLikedPlaceIds((prev) => {
            const next = new Set(prev);
            if (already) next.delete(id);
            else next.add(id);
            return next;
        });
        if (!already) {
            createInteraction({
                placeId: id,
                actionType: INTERACTION_TYPES.LIKE,
                metadata: { source: "home_feed" },
            }).catch(() => null);
            scheduleRefresh();
        }
    }

    function openNotificationCenter() {
        setNotifPanelOpen(true);
        refreshInbox();
    }

    async function handleNotificationRowPress(item) {
        await markInboxEntryRead(item.id);
        setNotifPanelOpen(false);
        navigateFromNotificationPayload(navigation, item.data);
    }

    const data = useMemo(() => places, [places]);
    const greetingName = useMemo(
        () => getGreetingName(profile),
        [profile],
    );
    const greetingMeta = useMemo(
        () => getGreetingMeta(now, greetingName),
        [now, greetingName],
    );

    return (
        <SafeAreaView style={styles.safeArea}>
            <LinearGradient
                colors={gradients.appBackground}
                style={styles.screen}
            >
                <TopGreetingBanner
                    eyebrow="Personalized picks"
                    title={greetingMeta.greeting}
                    subtitle={greetingMeta.headline}
                    onAction={openNotificationCenter}
                    actionBadgeCount={inboxUnreadCount}
                />

                <Modal
                    visible={notifPanelOpen}
                    transparent
                    animationType="slide"
                    onRequestClose={() => setNotifPanelOpen(false)}
                >
                    <View style={styles.notifModalRoot}>
                        <Pressable
                            style={styles.notifModalBackdrop}
                            onPress={() => setNotifPanelOpen(false)}
                            accessibilityRole="button"
                            accessibilityLabel="Close notifications"
                        />
                        <View style={styles.notifModalSheet}>
                            <View style={styles.notifModalGrab} />
                            <View style={styles.notifModalHeader}>
                                <Text style={styles.notifModalTitle}>
                                    Notifications
                                </Text>
                                <View style={styles.notifModalHeaderRight}>
                                    {inbox.length > 0 && inboxUnreadCount > 0 ? (
                                        <Pressable
                                            onPress={() => markAllInboxRead()}
                                            hitSlop={8}
                                        >
                                            <Text style={styles.notifModalMarkAll}>
                                                Mark all read
                                            </Text>
                                        </Pressable>
                                    ) : null}
                                    <Pressable
                                        onPress={() => setNotifPanelOpen(false)}
                                        style={styles.notifModalClose}
                                        hitSlop={10}
                                    >
                                        <Ionicons
                                            name="close"
                                            size={22}
                                            color={palette.textSecondary}
                                        />
                                    </Pressable>
                                </View>
                            </View>
                            {inbox.length === 0 ? (
                                <View style={styles.notifEmpty}>
                                    <Ionicons
                                        name="notifications-off-outline"
                                        size={40}
                                        color={palette.textMuted}
                                    />
                                    <Text style={styles.notifEmptyTitle}>
                                        You're all caught up
                                    </Text>
                                    <Text style={styles.notifEmptySub}>
                                        Alerts from your AI assistant will show up here.
                                        Adjust times in Profile → Notifications.
                                    </Text>
                                </View>
                            ) : (
                                <FlatList
                                    data={inbox}
                                    keyExtractor={(item) => item.id}
                                    style={styles.notifList}
                                    contentContainerStyle={styles.notifListContent}
                                    renderItem={({ item }) => {
                                        const unread = !item.read;
                                        const t = item.data?.type;
                                        const iconColor = unread
                                            ? palette.iceWhite
                                            : palette.oceanBlue;
                                        return (
                                            <Pressable
                                                style={({ pressed }) => [
                                                    styles.notifRow,
                                                    pressed && { opacity: 0.92 },
                                                ]}
                                                onPress={() =>
                                                    handleNotificationRowPress(item)
                                                }
                                            >
                                                <View
                                                    style={[
                                                        styles.notifRowIcon,
                                                        unread &&
                                                            styles.notifRowIconUnread,
                                                    ]}
                                                >
                                                    <Ionicons
                                                        name="sparkles-outline"
                                                        size={18}
                                                        color={iconColor}
                                                    />
                                                </View>
                                                <View style={styles.notifRowBody}>
                                                    <View style={styles.notifRowMeta}>
                                                        <Text style={styles.notifRowKind}>
                                                            {notificationTypeLabel(t)}
                                                        </Text>
                                                        <Text style={styles.notifRowTime}>
                                                            {formatNotifTimeRelative(
                                                                item.receivedAt,
                                                            )}
                                                        </Text>
                                                    </View>
                                                    <Text
                                                        style={styles.notifRowTitle}
                                                        numberOfLines={1}
                                                    >
                                                        {item.title}
                                                    </Text>
                                                    <Text
                                                        style={styles.notifRowBodyText}
                                                        numberOfLines={2}
                                                    >
                                                        {item.body}
                                                    </Text>
                                                </View>
                                                {unread ? (
                                                    <View style={styles.notifUnreadDot} />
                                                ) : null}
                                                <Ionicons
                                                    name="chevron-forward"
                                                    size={18}
                                                    color={palette.textMuted}
                                                />
                                            </Pressable>
                                        );
                                    }}
                                />
                            )}
                        </View>
                    </View>
                </Modal>

                <View style={styles.filtersRow}>
                    {/* For You — active, stays on this screen */}
                    <LinearGradient
                        colors={gradients.primaryButtonMint}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.filterChipActiveWrap}
                    >
                        <Text style={styles.filterChipActive}>For You</Text>
                    </LinearGradient>

                    {/* Trending → navigate to TrendingScreen */}
                    <Pressable
                        onPress={() => navigation.navigate("Trending")}
                        hitSlop={6}
                    >
                        <Text style={styles.filterChip}>Trending</Text>
                    </Pressable>

                    {/* Nearby → switch to Discover tab in nearby mode */}
                    <Pressable
                        onPress={() => {
                            const parent =
                                typeof navigation.getParent === "function"
                                    ? navigation.getParent()
                                    : null;
                            if (parent?.navigate) {
                                parent.navigate("MainTabs", {
                                    screen: "Discover",
                                    params: { mode: "nearby" },
                                });
                            } else {
                                navigation.navigate("Discover", {
                                    mode: "nearby",
                                });
                            }
                        }}
                        hitSlop={6}
                    >
                        <Text style={styles.filterChip}>Nearby</Text>
                    </Pressable>
                </View>

                {aiMeta?.pyModelActive && aiMeta?.predictedType ? (
                    <View style={styles.aiStatusBar}>
                        <Text style={styles.aiStatusText}>
                            {`AI · Next predicted: ${aiMeta.predictedType.charAt(0).toUpperCase()}${aiMeta.predictedType.slice(1)}`}
                            {aiMeta.confidence > 0
                                ? ` · ${Math.round(aiMeta.confidence * 100)}% confidence`
                                : ""}
                        </Text>
                    </View>
                ) : null}

                {loading && data.length === 0 ? (
                    <PlaceListSkeleton variant="home" count={3} />
                ) : null}
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                {!loading && data.length === 0 ? (
                    <EmptyState
                        message="We're still learning your taste. Update your profile to improve recommendations."
                        ctaLabel="Update Profile"
                        onPress={() => navigation.navigate("Profile")}
                    />
                ) : (
                    <FlatList
                        data={data}
                        keyExtractor={(item) => String(item.id ?? item.placeId)}
                        showsVerticalScrollIndicator={false}
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        initialNumToRender={3}
                        maxToRenderPerBatch={4}
                        windowSize={6}
                        removeClippedSubviews
                        contentContainerStyle={styles.listContent}
                        renderItem={({ item }) => (
                            <PlaceCard
                                place={item}
                                onPress={() => handleOpenDetail(item)}
                                onPressIn={() =>
                                    prefetchPlaceDetails(item.placeId ?? item.id)
                                }
                                liked={likedPlaceIds.has(item.placeId ?? item.id)}
                                saved={savedPlaceIds.has(item.placeId ?? item.id)}
                                onLike={() => handleLike(item)}
                                onSave={() => handleSave(item)}
                                onDismiss={() => handleDismiss(item)}
                            />
                        )}
                    />
                )}
            </LinearGradient>
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
        errorText: {
            color: palette.danger,
            marginBottom: 10,
            fontSize: 12,
        },
        filtersRow: {
            flexDirection: "row",
            gap: 10,
            marginTop: 14,
            marginBottom: 12,
        },
        filterChipActiveWrap: {
            borderRadius: 999,
            overflow: "hidden",
        },
        filterChipActive: {
            color: palette.iceWhite,
            fontWeight: "800",
            fontSize: 11,
            textTransform: "uppercase",
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
        },
        filterChip: {
            color: palette.textSecondary,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            fontSize: 11,
            textTransform: "uppercase",
            fontWeight: "700",
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
        },
        listContent: {
            paddingBottom: 20,
        },
        aiStatusBar: {
            marginBottom: 10,
            backgroundColor: "rgba(15, 124, 199, 0.08)",
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderWidth: 1,
            borderColor: "rgba(15, 124, 199, 0.15)",
        },
        aiStatusText: {
            color: palette.oceanBlue,
            fontSize: 11,
            fontWeight: "600",
        },
        notifModalRoot: {
            flex: 1,
            justifyContent: "flex-end",
        },
        notifModalBackdrop: {
            ...StyleSheet.absoluteFillObject,
            backgroundColor: "rgba(6, 18, 32, 0.5)",
        },
        notifModalSheet: {
            backgroundColor: palette.surfaceStrong,
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            borderWidth: 1,
            borderColor: palette.borderSoft,
            maxHeight: "78%",
            paddingBottom: 8,
        },
        notifModalGrab: {
            alignSelf: "center",
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: isDark
                ? "rgba(141,208,255,0.35)"
                : "rgba(10,106,168,0.2)",
            marginTop: 10,
            marginBottom: 6,
        },
        notifModalHeader: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 18,
            paddingBottom: 10,
        },
        notifModalTitle: {
            fontSize: 20,
            fontWeight: "800",
            color: palette.textPrimary,
            letterSpacing: -0.3,
        },
        notifModalHeaderRight: {
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
        },
        notifModalMarkAll: {
            fontSize: 13,
            fontWeight: "700",
            color: palette.oceanBlue,
        },
        notifModalClose: {
            padding: 2,
        },
        notifEmpty: {
            paddingHorizontal: 28,
            paddingVertical: 36,
            alignItems: "center",
        },
        notifEmptyTitle: {
            marginTop: 12,
            fontSize: 17,
            fontWeight: "800",
            color: palette.textPrimary,
            textAlign: "center",
        },
        notifEmptySub: {
            marginTop: 8,
            fontSize: 13,
            lineHeight: 19,
            color: palette.textMuted,
            textAlign: "center",
        },
        notifList: {
            maxHeight: 480,
        },
        notifListContent: {
            paddingHorizontal: 14,
            paddingBottom: 28,
        },
        notifRow: {
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 12,
            paddingHorizontal: 12,
            marginBottom: 8,
            borderRadius: 16,
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.borderSoft,
            gap: 10,
        },
        notifRowIcon: {
            width: 40,
            height: 40,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isDark
                ? "rgba(56,174,255,0.16)"
                : "rgba(56,174,255,0.14)",
        },
        notifRowIconUnread: {
            backgroundColor: palette.mint,
        },
        notifRowBody: {
            flex: 1,
            minWidth: 0,
        },
        notifRowMeta: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 2,
        },
        notifRowKind: {
            fontSize: 10,
            fontWeight: "800",
            color: palette.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
        },
        notifRowTime: {
            fontSize: 11,
            color: palette.textMuted,
        },
        notifRowTitle: {
            fontSize: 15,
            fontWeight: "800",
            color: palette.textPrimary,
        },
        notifRowBodyText: {
            marginTop: 2,
            fontSize: 13,
            lineHeight: 18,
            color: palette.textSecondary,
        },
        notifUnreadDot: {
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: palette.oceanBlue,
        },
    });
}
