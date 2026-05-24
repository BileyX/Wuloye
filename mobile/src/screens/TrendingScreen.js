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
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useAppTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import apiClient from "../api/client";
import {
    createInteraction,
    createInteractionsBatch,
} from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { normalisePlace } from "../utils/recommendationPlaces";
import { getApiErrorMessage } from "../utils/api";
import Loader from "../components/Loader";
import DiscoverCard from "../components/DiscoverCard";
import { prefetchPlaceDetails } from "../api/placeApi";

const TRENDING_FETCH_RETRIES = 2;
const TRENDING_RETRY_DELAY_MS = 700;

async function fetchTrendingFeedWithRetry() {
    let lastErr;
    for (let attempt = 0; attempt <= TRENDING_FETCH_RETRIES; attempt++) {
        try {
            return await apiClient.get("/recommendations/trending-feed");
        } catch (err) {
            lastErr = err;
            const status = err?.response?.status;
            if (status === 401 || status === 403) throw err;
            if (attempt < TRENDING_FETCH_RETRIES) {
                await new Promise((r) => setTimeout(r, TRENDING_RETRY_DELAY_MS));
            }
        }
    }
    throw lastErr;
}

// ─── Rank badge (1st / 2nd / 3rd colours) ────────────────────────────────────

const RANK_COLORS = {
    1: { bg: "rgba(255,215,0,0.18)", border: "rgba(255,180,0,0.45)", text: "#D4A000" },
    2: { bg: "rgba(192,192,192,0.18)", border: "rgba(160,160,160,0.4)", text: "#909090" },
    3: { bg: "rgba(205,127,50,0.18)", border: "rgba(180,100,30,0.4)", text: "#B8741A" },
};

function RankBadge({ rank, palette }) {
    const colors = RANK_COLORS[rank] ?? {
        bg: "rgba(56,174,255,0.1)",
        border: "rgba(56,174,255,0.28)",
        text: palette.oceanBlue,
    };
    return (
        <View
            style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                backgroundColor: colors.bg,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 8,
                flexShrink: 0,
            }}
        >
            <Text
                style={{
                    color: colors.text,
                    fontSize: 12,
                    fontWeight: "900",
                }}
            >
                #{rank}
            </Text>
        </View>
    );
}

// ─── Trending card row (rank badge + DiscoverCard) ────────────────────────────

function TrendingRow({ item, rank, palette, onPress, onPressIn, onSave, onDismiss }) {
    return (
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <RankBadge rank={rank} palette={palette} />
            <View style={{ flex: 1 }}>
                <DiscoverCard
                    place={item}
                    onPress={onPress}
                    onPressIn={onPressIn}
                    onSave={onSave}
                    onDismiss={onDismiss}
                />
            </View>
        </View>
    );
}

// ─── Header banner ────────────────────────────────────────────────────────────

function TrendingBanner({ palette, isDark, count, gradients }) {
    return (
        <LinearGradient
            colors={
                isDark
                    ? [
                          "rgba(40,20,80,0.92)",
                          "rgba(30,15,65,0.94)",
                          "rgba(20,50,90,0.9)",
                      ]
                    : [
                          "rgba(255,200,80,0.9)",
                          "rgba(255,140,60,0.88)",
                          "rgba(77,182,255,0.82)",
                      ]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
                borderRadius: 18,
                padding: 16,
                marginBottom: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 14,
                borderWidth: 1,
                borderColor: isDark
                    ? "rgba(180,120,255,0.28)"
                    : "rgba(255,255,255,0.55)",
            }}
        >
            <View
                style={{
                    width: 46,
                    height: 46,
                    borderRadius: 23,
                    backgroundColor: isDark
                        ? "rgba(60,20,100,0.7)"
                        : "rgba(255,255,255,0.28)",
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: isDark
                        ? "rgba(180,120,255,0.4)"
                        : "rgba(255,255,255,0.55)",
                }}
            >
                <Ionicons
                    name="flame"
                    size={22}
                    color={isDark ? "#FF9040" : "#fff"}
                />
            </View>
            <View style={{ flex: 1 }}>
                <Text
                    style={{
                        color: palette.iceWhite,
                        fontWeight: "900",
                        fontSize: 16,
                    }}
                >
                    What's Hot Right Now
                </Text>
                <Text
                    style={{
                        color: "rgba(248,254,255,0.85)",
                        fontSize: 12,
                        marginTop: 3,
                        lineHeight: 17,
                    }}
                >
                    {count > 0
                        ? `${count} admin-curated pick${count !== 1 ? "s" : ""} personalized for you`
                        : "Loading curated trending picks…"}
                </Text>
            </View>
        </LinearGradient>
    );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function TrendingScreen({ navigation }) {
    const { palette, gradients, isDark } = useAppTheme();
    const { ready, user } = useAuth();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );

    const [places, setPlaces] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const hasLoadedRef = useRef(false);

    const refreshTimerRef = useRef(null);
    const headerAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.timing(headerAnim, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
        }).start();
    }, [headerAnim]);

    const fetchPlaces = useCallback(async ({ silent = false } = {}) => {
        if (!user) return;
        try {
            if (!silent) setLoading(true);
            setError("");

            const resp = await fetchTrendingFeedWithRetry();
            const adminItems = resp?.data?.data ?? [];
            const meta = resp?.data?.meta ?? null;

            const mapped = Array.isArray(adminItems)
                ? adminItems.map((item, idx) =>
                      normalisePlace(item, idx, meta),
                  )
                : [];

            setPlaces(mapped);
            hasLoadedRef.current = true;

            if (mapped.length > 0) {
                const impressions = mapped.slice(0, 6).map((p) => ({
                    placeId: p.placeId,
                    actionType: INTERACTION_TYPES.VIEW,
                    metadata: { source: "admin_trending_feed", place: p },
                }));
                createInteractionsBatch(impressions).catch(() => null);
            }
        } catch (err) {
            setError(getApiErrorMessage(err, "Unable to load trending picks."));
            if (!hasLoadedRef.current) setPlaces([]);
        } finally {
            if (!silent) setLoading(false);
        }
    }, [user]);

    // Wait for auth bootstrap, then load — refetch every time screen is focused.
    useFocusEffect(
        useCallback(() => {
            if (!ready || !user) return undefined;
            fetchPlaces({ silent: hasLoadedRef.current });
            return undefined;
        }, [ready, user, fetchPlaces]),
    );

    useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

    const scheduleRefresh = useCallback(() => {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
            fetchPlaces().catch(() => null);
        }, 1500);
    }, [fetchPlaces]);

    async function handleRefresh() {
        setRefreshing(true);
        try {
            await fetchPlaces();
        } finally {
            setRefreshing(false);
        }
    }

    function handleOpenDetail(place) {
        createInteraction({
            placeId: place.placeId,
            actionType: INTERACTION_TYPES.CLICK,
            metadata: { source: "admin_trending_feed", place },
        }).catch(() => null);

        if (place?.category === "event" && place?._eventForDetail) {
            navigation.navigate("EventDetail", { event: place._eventForDetail });
            return;
        }
        navigation.navigate("PlaceDetail", { place });
    }

    async function handleSave(place) {
        try {
            await createInteraction({
                placeId: place.placeId,
                actionType: INTERACTION_TYPES.SAVE,
                metadata: { source: "trending_feed", place },
            });
            Alert.alert(
                "Saved",
                "Place added to your saved list. View it anytime under Profile → Saved places.",
            );
            scheduleRefresh();
        } catch (err) {
            Alert.alert("Unable to save", getApiErrorMessage(err));
        }
    }

    async function handleDismiss(place) {
        try {
            await createInteraction({
                placeId: place.placeId,
                actionType: INTERACTION_TYPES.DISMISS,
                metadata: { source: "trending_feed", place },
            });
            setPlaces((curr) =>
                curr.filter((p) => p.placeId !== place.placeId),
            );
            scheduleRefresh();
        } catch (err) {
            Alert.alert("Unable to dismiss", getApiErrorMessage(err));
        }
    }

    return (
        <SafeAreaView style={styles.safeArea}>
            <LinearGradient
                colors={gradients.appBackground}
                style={styles.screen}
            >
                {/* Header */}
                <Animated.View
                    style={[
                        styles.header,
                        {
                            opacity: headerAnim,
                            transform: [
                                {
                                    translateY: headerAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [-10, 0],
                                    }),
                                },
                            ],
                        },
                    ]}
                >
                    <Pressable
                        onPress={() => navigation.goBack()}
                        hitSlop={10}
                        style={styles.backBtn}
                    >
                        <Ionicons
                            name="chevron-back"
                            size={20}
                            color={palette.textPrimary}
                        />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.eyebrow}>Admin curated</Text>
                        <Text style={styles.title}>Trending Now</Text>
                    </View>
                    <Pressable
                        onPress={handleRefresh}
                        hitSlop={8}
                        style={styles.refreshBtn}
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

                {loading && !refreshing && (!ready || !hasLoadedRef.current) ? (
                    <View style={{ paddingTop: 20 }}>
                        <Loader />
                    </View>
                ) : (
                    <FlatList
                        data={places}
                        keyExtractor={(item, index) =>
                            String(
                                item.trendingEntryId ??
                                    item.placeId ??
                                    item.id ??
                                    index,
                            )
                        }
                        showsVerticalScrollIndicator={false}
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        contentContainerStyle={styles.listContent}
                        ListHeaderComponent={() => (
                            <View>
                                <TrendingBanner
                                    palette={palette}
                                    isDark={isDark}
                                    count={places.length}
                                    gradients={gradients}
                                />
                                {error ? (
                                    <Text style={styles.errorText}>{error}</Text>
                                ) : null}
                                {places.length > 0 && (
                                    <Text style={styles.sectionLabel}>
                                        Trending Picks
                                    </Text>
                                )}
                            </View>
                        )}
                        ListEmptyComponent={
                            !loading ? (
                                <View style={styles.emptyWrap}>
                                    <Ionicons
                                        name="flame-outline"
                                        size={40}
                                        color={palette.textMuted}
                                        style={{ marginBottom: 12 }}
                                    />
                                    <Text style={styles.emptyTitle}>
                                        No trending picks yet
                                    </Text>
                                    <Text style={styles.emptySub}>
                                        Our team is curating what's hot. Check back soon — or explore For You on the home screen.
                                    </Text>
                                </View>
                            ) : null
                        }
                        renderItem={({ item, index }) => (
                            <TrendingRow
                                item={item}
                                rank={index + 1}
                                palette={palette}
                                onPress={() => handleOpenDetail(item)}
                                onPressIn={() =>
                                    prefetchPlaceDetails(item.placeId ?? item.id)
                                }
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
        safeArea: { flex: 1, backgroundColor: palette.pageTop },
        screen: { flex: 1, paddingHorizontal: 16 },
        header: {
            flexDirection: "row",
            alignItems: "center",
            marginTop: 8,
            marginBottom: 14,
            gap: 10,
        },
        backBtn: {
            width: 36,
            height: 36,
            borderRadius: 12,
            backgroundColor: isDark
                ? "rgba(18,38,62,0.8)"
                : "rgba(255,255,255,0.8)",
            borderWidth: 1,
            borderColor: palette.borderStrong,
            alignItems: "center",
            justifyContent: "center",
        },
        eyebrow: {
            color: "#FF9040",
            fontSize: 10,
            fontWeight: "800",
            letterSpacing: 1,
            textTransform: "uppercase",
        },
        title: {
            color: palette.textPrimary,
            fontSize: 24,
            fontWeight: "900",
            marginTop: 1,
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
        listContent: { paddingBottom: 110 },
        sectionLabel: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "800",
            marginBottom: 12,
        },
        errorText: {
            color: palette.danger,
            fontSize: 12,
            marginBottom: 10,
        },
        emptyWrap: {
            alignItems: "center",
            paddingVertical: 36,
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
            fontSize: 17,
            fontWeight: "800",
        },
        emptySub: {
            color: palette.textSecondary,
            textAlign: "center",
            lineHeight: 20,
            marginTop: 8,
            fontSize: 13,
        },
    });
}
