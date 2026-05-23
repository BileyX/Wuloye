import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    ActivityIndicator,
    Animated,
    FlatList,
    Image,
    Linking,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useAppTheme } from "../context/ThemeContext";
import {
    getRecommendedEvents,
    getEvents,
    prefetchEventById,
    invalidateEventsListCache,
    invalidateRecoListCache,
} from "../api/eventsApi";
import { createInteraction } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { getApiErrorMessage } from "../utils/api";
import { auth } from "../config/firebase";
import {
    resolveEventThumbnailUri,
    eventPlaceholderGradientColors,
} from "../utils/eventMedia";

// ─── Category filter chips ────────────────────────────────────────────────────

const CATEGORIES = [
    { key: "all",       label: "All",       icon: "apps-outline" },
    { key: "music",     label: "Music",     icon: "musical-notes-outline" },
    { key: "sports",    label: "Sports",    icon: "football-outline" },
    { key: "tech",      label: "Tech",      icon: "laptop-outline" },
    { key: "business",  label: "Business",  icon: "briefcase-outline" },
    { key: "fitness",   label: "Fitness",   icon: "barbell-outline" },
    { key: "church",    label: "Church",    icon: "heart-outline" },
    { key: "food",      label: "Food",      icon: "restaurant-outline" },
    { key: "art",       label: "Art",       icon: "color-palette-outline" },
    { key: "social",    label: "Social",    icon: "people-outline" },
    { key: "education", label: "Education", icon: "book-outline" },
];

const CATEGORY_FALLBACK_ICONS = {
    music:     "musical-notes-outline",
    tech:      "laptop-outline",
    business:  "briefcase-outline",
    sports:    "football-outline",
    fitness:   "barbell-outline",
    church:    "heart-outline",
    food:      "restaurant-outline",
    art:       "color-palette-outline",
    social:    "people-outline",
    education: "book-outline",
    other:     "calendar-outline",
    sport:     "football-outline",
};

// ─── Feed pills (curated views on top of the same event list) ─────────────────

const FEEDS = [
    { key: "for_you",    label: "For You",    icon: "sparkles-outline" },
    { key: "free",       label: "Free",       icon: "pricetag-outline" },
    { key: "affordable", label: "Affordable", icon: "wallet-outline" },
    { key: "weekend",    label: "Weekend",    icon: "sunny-outline" },
    { key: "nearby",     label: "Nearby",     icon: "navigate-outline" },
    { key: "trending",   label: "Trending",   icon: "flame-outline" },
];

function isFreeEvent(event) {
    const tier  = String(event?.price_tier || event?.priceTier || "").toLowerCase();
    const price = String(event?.ticket_price || event?.ticketPrice || "").toLowerCase();
    if (price === "free" || price === "free entry" || price === "gratis") return true;
    if (event?.is_paid === false || event?.isPaid === false) {
        if (!price || price === "free") return true;
    }
    if (tier === "cheap" && (!price || price === "free")) return true;
    return false;
}

function isAffordableEvent(event) {
    // ETB ≤ 800 or free — suitable for mid/cheap budgets
    if (isFreeEvent(event)) return true;
    const price = String(event?.ticket_price || event?.ticketPrice || "");
    const m = price.match(/([\d][\d,.]*)/);
    if (m) {
        const val = parseFloat(m[1].replace(/,/g, ""));
        if (!isNaN(val) && val <= 800) return true;
    }
    const tier = String(event?.price_tier || event?.priceTier || "").toLowerCase();
    return tier === "cheap";
}

function isWeekendEvent(event) {
    if (!event?.date) return false;
    try {
        const d = new Date(event.date);
        const day = d.getDay();
        return day === 0 || day === 5 || day === 6; // Fri/Sat/Sun
    } catch {
        return false;
    }
}

function eventDistanceKm(event, userLoc) {
    const coords = event?.coordinates;
    if (!userLoc || !coords?.lat || !coords?.lng) return null;
    const R = 6371;
    const dLat = ((coords.lat - userLoc.lat) * Math.PI) / 180;
    const dLng = ((coords.lng - userLoc.lng) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((userLoc.lat * Math.PI) / 180) *
            Math.cos((coords.lat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Date formatter ───────────────────────────────────────────────────────────

function formatEventDate(isoDate) {
    if (!isoDate) return "";
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString("en-ET", {
            weekday: "short",
            month:   "short",
            day:     "numeric",
            year:    "numeric",
        });
    } catch {
        return isoDate.slice(0, 10);
    }
}

// ─── Event Card ───────────────────────────────────────────────────────────────

function EventSkeletonCard({ palette, isDark }) {
    const surface = isDark ? "rgba(14,28,50,0.55)" : "rgba(255,255,255,0.78)";
    const block = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    return (
        <View
            style={[
                styles.card,
                {
                    backgroundColor: surface,
                    borderColor: palette.borderSoft,
                },
            ]}
        >
            <View style={[styles.cardImage, { backgroundColor: block }]} />
            <View style={styles.cardBody}>
                <View style={{ height: 14, width: "75%", backgroundColor: block, borderRadius: 6 }} />
                <View style={{ height: 10, width: "50%", backgroundColor: block, borderRadius: 6, marginTop: 10 }} />
                <View style={{ height: 10, width: "40%", backgroundColor: block, borderRadius: 6, marginTop: 6 }} />
            </View>
        </View>
    );
}

// ─── Source label helpers ─────────────────────────────────────────────────────

const SOURCE_META = {
    chapa_events:    { label: "Chapa Events",    color: "#F59E0B" },
    eventbrite:      { label: "Eventbrite",      color: "#F05537" },
    meetup:          { label: "Meetup",           color: "#ED1C40" },
    alladdisevents:  { label: "AllAddisEvents",   color: "#2563EB" },
    whatsupaddis:    { label: "WhatsUpAddis",     color: "#7C3AED" },
    british_council: { label: "British Council",  color: "#012169" },
    icc_addis:       { label: "ICC Addis",        color: "#1D4ED8" },
};

function getSourceMeta(event) {
    const src = String(event?.source || "").toLowerCase();
    for (const [key, meta] of Object.entries(SOURCE_META)) {
        if (src.includes(key)) return meta;
    }
    if (src.startsWith("eth_local_")) {
        return { label: "Local", color: "#059669" };
    }
    if (src.startsWith("eth_rss_") || src.startsWith("rss_feed")) {
        return { label: "News", color: "#64748B" };
    }
    if (src.startsWith("telegram_")) {
        return { label: "Telegram", color: "#229ED9" };
    }
    return null;
}

/** Higher = show first. Matches backend SOURCE_TRUST_SCORE. */
function sourceTrustScore(event) {
    const s = String(event?.source || "").toLowerCase();
    if (s.includes("chapa")) return 105;
    if (s.includes("eventbrite")) return 100;
    if (s.startsWith("meetup")) return 92;
    if (s.includes("eth_local")) return 95;
    if (s.includes("eth_rss")) return 90;
    if (s.includes("alladdis") || s.includes("whatsup")) return 88;
    if (s.startsWith("telegram_")) return 55;
    return 45;
}

function sortByTrustThenDate(list) {
    return [...list].sort((a, b) => {
        const t = sourceTrustScore(b) - sourceTrustScore(a);
        if (t !== 0) return t;
        const ad = a.date || a.created_at || "";
        const bd = b.date || b.created_at || "";
        return String(ad).localeCompare(String(bd));
    });
}

function openBookingUrl(event) {
    const url = event?.booking_url || event?.source_url;
    if (url) Linking.openURL(url).catch(() => {});
}

function hasBookingUrl(event) {
    return Boolean(event?.booking_url || event?.source_url);
}

function priceBadgeMeta(event) {
    const price = String(event?.ticket_price || event?.ticketPrice || "").trim();
    const tier = String(event?.price_tier || event?.priceTier || "").toLowerCase();
    const isPaid = Boolean(event?.is_paid ?? event?.isPaid);
    if (price.toLowerCase() === "free" || (!isPaid && tier === "cheap" && !price)) {
        return { label: "Free", bg: "#10B98122", fg: "#0F9B6E" };
    }
    if (price) return { label: price, bg: "rgba(0,0,0,0.45)", fg: "#fff" };
    if (tier === "expensive") return { label: "Premium", bg: "#F59E0B22", fg: "#B45309" };
    if (tier === "mid") return { label: "Mid", bg: "rgba(0,0,0,0.45)", fg: "#fff" };
    return null;
}

function EventCard({ event, onPress, onPressIn, palette, isDark }) {
    const resolvedUri = useMemo(() => resolveEventThumbnailUri(event), [event]);

    // Fallback chain: https → http → gradient placeholder
    const rawTrim = typeof event?.image === "string" ? event.image.trim() : "";
    const httpFallback = rawTrim.startsWith("http://") ? rawTrim : "";

    const [imgState, setImgState] = useState("loading"); // loading | ok | http | failed

    useEffect(() => {
        setImgState(resolvedUri ? "loading" : "failed");
    }, [event?.id, resolvedUri]);

    const displayUri =
        imgState === "http" && httpFallback
            ? httpFallback
            : resolvedUri;
    const showRemote = Boolean(displayUri && imgState !== "failed");

    const onImageLoad  = useCallback(() => setImgState("ok"),    []);
    const onImageError = useCallback(() => {
        if (imgState === "loading" && httpFallback && httpFallback !== resolvedUri) {
            setImgState("http");
        } else {
            setImgState("failed");
        }
    }, [imgState, httpFallback, resolvedUri]);

    const isChapa = String(event?.source || "").toLowerCase().includes("chapa");
    const cardBg  = isDark ? "rgba(14,28,50,0.94)" : "rgba(255,255,255,0.92)";
    const [g0, g1] = eventPlaceholderGradientColors(event);
    const catIcon = CATEGORY_FALLBACK_ICONS[event.category] || CATEGORY_FALLBACK_ICONS.other;
    const sourceMeta = getSourceMeta(event);
    const priceMeta  = priceBadgeMeta(event);

    return (
        <Pressable
            onPressIn={() => onPressIn?.(event)}
            onPress={() => onPress(event)}
            style={({ pressed }) => [
                styles.card,
                {
                    backgroundColor: cardBg,
                    borderColor: isChapa
                        ? "#F59E0B55"
                        : palette.borderSoft,
                    borderWidth: isChapa ? 1.5 : 1,
                    opacity: pressed ? 0.88 : 1,
                    transform: [{ scale: pressed ? 0.975 : 1 }],
                },
            ]}
        >
            {/* ── Image ─────────────────────────────────────────────────────── */}
            <View style={styles.cardImage}>
                {showRemote ? (
                    <Image
                        source={{ uri: displayUri }}
                        style={StyleSheet.absoluteFillObject}
                        resizeMode="cover"
                        onLoad={onImageLoad}
                        onError={onImageError}
                    />
                ) : null}

                {/* Gradient placeholder always rendered behind image */}
                <LinearGradient
                    colors={[g0, g1]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[StyleSheet.absoluteFillObject, showRemote && imgState === "ok" ? { opacity: 0 } : {}]}
                >
                    <View style={styles.cardImageIconWrap}>
                        <Ionicons name={catIcon} size={44} color="rgba(255,255,255,0.80)" />
                    </View>
                </LinearGradient>

                {/* Bottom scrim so category badge stays readable over photos */}
                <LinearGradient
                    colors={["transparent", "rgba(0,0,0,0.55)"]}
                    style={styles.cardImageScrim}
                    pointerEvents="none"
                />

                {/* Category badge — bottom-left over scrim */}
                <View style={styles.categoryBadgeOverlay}>
                    <View style={[styles.categoryBadge, { backgroundColor: palette.oceanBlue + "DD" }]}>
                        <Ionicons name={catIcon} size={10} color="#fff" style={{ marginRight: 3 }} />
                        <Text style={styles.categoryBadgeText}>
                            {(event.category || "other").toUpperCase()}
                        </Text>
                    </View>
                </View>

                {/* Price badge — top-right */}
                {priceMeta && (
                    <View style={[styles.priceBadge, { backgroundColor: priceMeta.bg }]}>
                        <Text style={[styles.priceBadgeText, { color: priceMeta.fg }]} numberOfLines={1}>
                            {priceMeta.label}
                        </Text>
                    </View>
                )}
            </View>

            {/* ── Details ───────────────────────────────────────────────────── */}
            <View style={styles.cardBody}>
                <Text style={[styles.cardTitle, { color: palette.textPrimary }]} numberOfLines={2}>
                    {event.title}
                </Text>

                <View style={styles.cardMeta}>
                    <Ionicons name="calendar-outline" size={13} color={palette.textMuted} />
                    <Text style={[styles.cardMetaText, { color: palette.textMuted }]}>
                        {"  "}{formatEventDate(event.date)}
                    </Text>
                </View>

                <View style={[styles.cardMeta, { marginTop: 3 }]}>
                    <Ionicons name="location-outline" size={13} color={palette.textMuted} />
                    <Text
                        style={[styles.cardMetaText, { color: palette.textMuted }]}
                        numberOfLines={1}
                    >
                        {"  "}{event.location || "Ethiopia"}
                    </Text>
                </View>

                {/* AI explanation row */}
                {!!event?.explain && (
                    <View
                        style={[
                            styles.reasonRow,
                            {
                                backgroundColor: isDark
                                    ? "rgba(96,165,250,0.12)"
                                    : "rgba(37,99,235,0.07)",
                            },
                        ]}
                    >
                        <Ionicons
                            name="sparkles-outline"
                            size={11}
                            color={isDark ? "#93C5FD" : "#1D4ED8"}
                        />
                        <Text
                            style={[styles.reasonText, { color: isDark ? "#BFDBFE" : "#1E3A8A" }]}
                            numberOfLines={2}
                        >
                            {"  "}{event.explain}
                        </Text>
                    </View>
                )}

                {/* Source badge + Book button */}
                <View style={styles.cardFooter}>
                    {sourceMeta ? (
                        <View style={[styles.sourceBadge, { backgroundColor: sourceMeta.color + "22" }]}>
                            <View style={[styles.sourceDot, { backgroundColor: sourceMeta.color }]} />
                            <Text style={[styles.sourceBadgeText, { color: sourceMeta.color }]}>
                                {sourceMeta.label}
                            </Text>
                        </View>
                    ) : <View />}

                    {hasBookingUrl(event) && (
                        <Pressable
                            onPress={(e) => { e.stopPropagation?.(); openBookingUrl(event); }}
                            style={[
                                styles.bookBtn,
                                {
                                    backgroundColor: isChapa
                                        ? "#F59E0B18"
                                        : palette.oceanBlue + "14",
                                    borderColor: isChapa
                                        ? "#F59E0B"
                                        : palette.oceanBlue,
                                },
                            ]}
                            hitSlop={8}
                        >
                            <Ionicons
                                name="ticket-outline"
                                size={12}
                                color={isChapa ? "#F59E0B" : palette.oceanBlue}
                            />
                            <Text
                                style={[
                                    styles.bookBtnText,
                                    { color: isChapa ? "#F59E0B" : palette.oceanBlue },
                                ]}
                            >
                                {isChapa ? "Book on Chapa" : "Book"}
                            </Text>
                        </Pressable>
                    )}
                </View>
            </View>
        </Pressable>
    );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function EventsScreen({ navigation }) {
    const { palette, gradients, isDark } = useAppTheme();
    const styles2 = useMemo(() => createStyles(palette, isDark), [palette, isDark]);

    // `recoEvents`  — personalized AI list (~15 events) used for "For You" feed
    // `allEvents`   — broad unfiltered pool (~100 events) used for category chips + other feeds
    const [recoEvents, setRecoEvents]  = useState([]);
    const [allEvents,  setAllEvents]   = useState([]);
    const [loading, setLoading]        = useState(true);
    const [refreshing, setRefreshing]  = useState(false);
    const [error, setError]            = useState(null);
    const [activeCategory, setActiveCategory] = useState("all");
    const [activeFeed, setActiveFeed]         = useState("for_you");
    const [userLocation, setUserLocation]     = useState(null);
    const [cityName, setCityName]             = useState(null);

    const fadeAnim = useRef(new Animated.Value(0)).current;

    // ── Get user location ──────────────────────────────────────────────────────

    useEffect(() => {
        (async () => {
            try {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== "granted") return;
                const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                setUserLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });

                // Reverse-geocode to get city name
                const [place] = await Location.reverseGeocodeAsync({
                    latitude: loc.coords.latitude,
                    longitude: loc.coords.longitude,
                });
                if (place) {
                    setCityName(place.city || place.subregion || place.region || null);
                }
            } catch {
                // Location permission denied or failed — proceed without location
            }
        })();
    }, []);

    // ── Fetch events ───────────────────────────────────────────────────────────

    const fetchEvents = useCallback(async (isRefresh = false) => {
        if (!isRefresh) setLoading(true);
        setError(null);

        const locationParams = userLocation
            ? { lat: userLocation.lat, lng: userLocation.lng }
            : {};

        try {
            // Always fetch the broad unfiltered pool — this powers category chips
            // and feed filters with a large, diverse set of events.
            const allResult = await getEvents({
                limit: 100,
                refresh: isRefresh ? "1" : undefined,
                ...locationParams,
            });
            const broadList = allResult?.events || [];
            setAllEvents(sortByTrustThenDate(broadList));

            // Separately fetch personalized recommendations for the "For You" tab.
            if (auth.currentUser) {
                try {
                    const recoResult = await getRecommendedEvents();
                    const recoList = recoResult?.events || [];
                    // Merge: show reco events first, then pad with broad events not already included.
                    if (recoList.length >= 3) {
                        const recoIds = new Set(recoList.map((e) => e.id));
                        const extra = broadList.filter((e) => !recoIds.has(e.id)).slice(0, 15);
                        setRecoEvents(sortByTrustThenDate([...recoList, ...extra]));
                    } else {
                        setRecoEvents(sortByTrustThenDate(broadList));
                    }
                } catch {
                    setRecoEvents(sortByTrustThenDate(broadList));
                }
            } else {
                setRecoEvents(sortByTrustThenDate(broadList));
            }

            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 350,
                useNativeDriver: true,
            }).start();
        } catch (err) {
            setError(getApiErrorMessage(err));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [fadeAnim, userLocation]);

    useEffect(() => {
        fetchEvents();
    }, [fetchEvents]);

    const onRefresh = useCallback(() => {
        // Bust both mobile-side caches so fresh data is fetched from the backend.
        invalidateEventsListCache();
        invalidateRecoListCache();
        setRefreshing(true);
        fetchEvents(true);
    }, [fetchEvents]);

    // ── Filtered events ────────────────────────────────────────────────────────

    const displayed = useMemo(() => {
        // "For You" feed uses the personalized reco pool.
        // All other feeds + category chips use the full broad pool (100 events)
        // so they always have enough events to filter through.
        const basePool = activeFeed === "for_you" && activeCategory === "all"
            ? recoEvents
            : allEvents;

        // Strict category filter — each chip maps to a closed set of category values.
        // Tech conferences must NOT appear in music; church events must NOT appear in social.
        const CATEGORY_ALIASES = {
            all:       null,  // no filter
            music:     ["music"],
            sports:    ["sports"],
            fitness:   ["fitness"],
            tech:      ["tech"],
            business:  ["business"],
            church:    ["church"],
            food:      ["food"],
            art:       ["art"],
            social:    ["social"],
            education: ["education"],
            other:     ["other"],
        };
        const allowed = CATEGORY_ALIASES[activeCategory] ?? null;
        let list = allowed === null
            ? basePool
            : basePool.filter((e) => {
                const cat = String(e.category || "other").toLowerCase();
                return allowed.includes(cat);
            });

        switch (activeFeed) {
            case "free":
                list = list.filter(isFreeEvent);
                break;
            case "affordable":
                list = list.filter(isAffordableEvent);
                break;
            case "weekend":
                list = list.filter(isWeekendEvent);
                break;
            case "nearby":
                if (userLocation) {
                    list = list
                        .map((e) => ({ e, d: eventDistanceKm(e, userLocation) }))
                        .filter((x) => x.d != null && x.d <= 60)
                        .sort((a, b) => a.d - b.d)
                        .map((x) => x.e);
                }
                break;
            case "trending":
                list = [...list].sort((a, b) => {
                    const sa = typeof a?.score === "number" ? a.score : 0;
                    const sb = typeof b?.score === "number" ? b.score : 0;
                    if (Math.abs(sb - sa) > 0.01) return sb - sa;
                    // Tiebreak: trusted sources surface first
                    const trust = sourceTrustScore(b) - sourceTrustScore(a);
                    if (trust !== 0) return trust;
                    return new Date(a.date) - new Date(b.date);
                });
                break;
            case "for_you":
            default:
                break;
        }

        // Chapa / Eventbrite / Meetup always surface before Telegram in every feed.
        if (activeFeed !== "trending") {
            list = sortByTrustThenDate(list);
        }
        return list;
    }, [recoEvents, allEvents, activeCategory, activeFeed, userLocation]);

    // ── Handlers ───────────────────────────────────────────────────────────────

    const handleCardPress = useCallback((event) => {
        if (event?.id && auth.currentUser) {
            createInteraction({
                placeId: event.id,
                actionType: INTERACTION_TYPES.OPEN_EVENT,
                metadata: { category: event.category || "other", source: event.source || "" },
            }).catch(() => {});
        }
        navigation.navigate("EventDetail", { event });
    }, [navigation]);

    const canGoBack = navigation.canGoBack();

    // ── Header text ────────────────────────────────────────────────────────────

    const headerTitle = "Events for You";
    const headerSub = cityName
        ? `Happening near ${cityName}`
        : "Events happening near you";

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <LinearGradient
            colors={gradients.appBackground}
            style={{ flex: 1 }}
        >
            <SafeAreaView style={{ flex: 1 }} edges={["top"]}>

                {/* Header */}
                <View style={styles2.header}>
                    <View style={styles2.headerTopRow}>
                        {canGoBack ? (
                            <Pressable
                                onPress={() => navigation.goBack()}
                                hitSlop={12}
                                style={styles2.headerBackBtn}
                                accessibilityRole="button"
                                accessibilityLabel="Go back"
                            >
                                <Ionicons name="arrow-back" size={22} color={palette.textPrimary} />
                            </Pressable>
                        ) : null}
                        <View style={styles2.headerTextCol}>
                            <Text style={[styles2.headerTitle, { color: palette.textPrimary }]}>
                                {headerTitle}
                            </Text>
                            <Text style={[styles2.headerSub, { color: palette.textMuted }]}>
                                {headerSub}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* Feed pills */}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles2.chipsRow}
                    style={styles2.feedScroll}
                >
                    {FEEDS.map((feed) => {
                        const active = activeFeed === feed.key;
                        const muted = feed.key === "nearby" && !userLocation;
                        return (
                            <Pressable
                                key={feed.key}
                                disabled={muted}
                                onPress={() => setActiveFeed(feed.key)}
                                style={[
                                    styles2.feedChip,
                                    {
                                        backgroundColor: active
                                            ? palette.oceanBlue
                                            : muted
                                                ? palette.surface
                                                : palette.surface,
                                        borderColor: active ? palette.oceanBlue : palette.borderSoft,
                                        opacity: muted ? 0.55 : 1,
                                    },
                                ]}
                            >
                                <Ionicons
                                    name={feed.icon}
                                    size={14}
                                    color={active ? "#fff" : palette.textSecondary}
                                />
                                <Text
                                    style={[
                                        styles2.feedChipText,
                                        { color: active ? "#fff" : palette.textSecondary },
                                    ]}
                                >
                                    {feed.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>

                {/* Category chips */}
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles2.chipsRow}
                    style={styles2.chipsScroll}
                >
                    {CATEGORIES.map((cat) => {
                        const active = activeCategory === cat.key;
                        return (
                            <Pressable
                                key={cat.key}
                                onPress={() => setActiveCategory(cat.key)}
                                style={[
                                    styles2.chip,
                                    {
                                        backgroundColor: active ? palette.oceanBlue : palette.surface,
                                        borderColor: active ? palette.oceanBlue : palette.borderSoft,
                                    },
                                ]}
                            >
                                <Ionicons
                                    name={cat.icon}
                                    size={14}
                                    color={active ? "#fff" : palette.textSecondary}
                                />
                                <Text
                                    style={[
                                        styles2.chipText,
                                        { color: active ? "#fff" : palette.textSecondary },
                                    ]}
                                >
                                    {cat.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>

                {/* Content */}
                {loading && !refreshing ? (
                    <FlatList
                        data={[0, 1, 2, 3]}
                        keyExtractor={(item) => `sk-${item}`}
                        renderItem={() => (
                            <EventSkeletonCard palette={palette} isDark={isDark} />
                        )}
                        contentContainerStyle={styles2.list}
                        showsVerticalScrollIndicator={false}
                    />
                ) : error ? (
                    <View style={styles2.centerContainer}>
                        <Ionicons name="cloud-offline-outline" size={48} color={palette.textMuted} />
                        <Text style={[styles2.errorTitle, { color: palette.textPrimary }]}>
                            Could not load events
                        </Text>
                        <Text style={[styles2.errorSub, { color: palette.textMuted }]}>
                            {error}
                        </Text>
                        <Pressable onPress={() => fetchEvents()} style={styles2.retryBtn}>
                            <LinearGradient
                                colors={gradients.primaryButtonMint}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles2.retryBtnGrad}
                            >
                                <Text style={styles2.retryBtnText}>Retry</Text>
                            </LinearGradient>
                        </Pressable>
                    </View>
                ) : (
                    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
                        <FlatList
                            data={displayed}
                            keyExtractor={(item) => item.id || item.title}
                            renderItem={({ item }) => (
                                <EventCard
                                    event={item}
                                    onPress={handleCardPress}
                                    onPressIn={(e) => prefetchEventById(e?.id)}
                                    palette={palette}
                                    isDark={isDark}
                                />
                            )}
                            contentContainerStyle={styles2.list}
                            showsVerticalScrollIndicator={false}
                            refreshControl={
                                <RefreshControl
                                    refreshing={refreshing}
                                    onRefresh={onRefresh}
                                    tintColor={palette.oceanBlue}
                                />
                            }
                            ListEmptyComponent={
                                <View style={styles2.centerContainer}>
                                    <Ionicons
                                        name="calendar-outline"
                                        size={52}
                                        color={palette.textMuted}
                                    />
                                    <Text style={[styles2.emptyTitle, { color: palette.textPrimary }]}>
                                        No events found
                                    </Text>
                                    <Text style={[styles2.emptySub, { color: palette.textMuted }]}>
                                        {activeCategory !== "all"
                                            ? `No ${activeCategory} events right now`
                                            : "New events are scraped daily — check back soon"}
                                    </Text>
                                </View>
                            }
                        />
                    </Animated.View>
                )}
            </SafeAreaView>
        </LinearGradient>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    card: {
        borderRadius: 18,
        borderWidth: 1,
        overflow: "hidden",
        marginBottom: 16,
        // Subtle shadow for depth
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.10,
        shadowRadius: 8,
        elevation: 3,
    },
    cardImage: {
        width: "100%",
        height: 195,
        backgroundColor: "rgba(0,0,0,0.12)",
    },
    cardImageIconWrap: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    cardImageScrim: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 56,
    },
    // Category badge is now inside image at bottom-left
    categoryBadgeOverlay: {
        position: "absolute",
        bottom: 10,
        left: 12,
        flexDirection: "row",
        alignItems: "center",
    },
    categoryBadge: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 20,
    },
    categoryBadgeText: {
        color: "#fff",
        fontSize: 9,
        fontWeight: "800",
        letterSpacing: 0.6,
    },
    cardBody: {
        padding: 14,
    },
    cardTitle: {
        fontSize: 15,
        fontWeight: "700",
        lineHeight: 21,
        marginBottom: 8,
    },
    cardMeta: {
        flexDirection: "row",
        alignItems: "center",
    },
    cardMetaText: {
        fontSize: 12,
        flex: 1,
        lineHeight: 17,
    },
    priceBadge: {
        position: "absolute",
        top: 12,
        right: 12,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 20,
        maxWidth: 145,
    },
    priceBadgeText: {
        fontSize: 11,
        fontWeight: "700",
    },
    reasonRow: {
        flexDirection: "row",
        alignItems: "flex-start",
        marginTop: 10,
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: 10,
    },
    reasonText: {
        fontSize: 11,
        fontWeight: "600",
        flex: 1,
        lineHeight: 15,
    },
    cardFooter: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 11,
    },
    sourceBadge: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 20,
        gap: 4,
    },
    sourceDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    sourceBadgeText: {
        fontSize: 10,
        fontWeight: "700",
    },
    bookBtn: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 11,
        paddingVertical: 5,
        borderRadius: 14,
        borderWidth: 1.2,
    },
    bookBtnText: {
        fontSize: 11,
        fontWeight: "700",
    },
});

function createStyles(palette, isDark) {
    return StyleSheet.create({
        header: {
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 10,
        },
        headerTopRow: {
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 6,
        },
        headerBackBtn: {
            marginTop: 4,
            paddingVertical: 2,
            paddingRight: 4,
        },
        headerTextCol: {
            flex: 1,
            minWidth: 0,
        },
        headerTitle: {
            fontSize: 26,
            fontWeight: "800",
        },
        headerSub: {
            fontSize: 13,
            marginTop: 2,
        },
        feedScroll: {
            maxHeight: 48,
            marginBottom: 4,
        },
        chipsScroll: {
            maxHeight: 46,
            marginBottom: 8,
        },
        chipsRow: {
            paddingHorizontal: 16,
            gap: 8,
            alignItems: "center",
        },
        chip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 20,
            borderWidth: 1,
        },
        chipText: {
            fontSize: 12,
            fontWeight: "600",
        },
        feedChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 22,
            borderWidth: 1,
        },
        feedChipText: {
            fontSize: 13,
            fontWeight: "700",
        },
        list: {
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 110,
        },
        centerContainer: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 32,
            gap: 10,
            marginTop: 40,
        },
        loadingText: {
            fontSize: 14,
            marginTop: 8,
        },
        errorTitle: {
            fontSize: 18,
            fontWeight: "700",
            textAlign: "center",
        },
        errorSub: {
            fontSize: 13,
            textAlign: "center",
            lineHeight: 18,
        },
        retryBtn: {
            marginTop: 12,
            borderRadius: 12,
            overflow: "hidden",
            height: 44,
            width: 140,
        },
        retryBtnGrad: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
        },
        retryBtnText: {
            color: "#fff",
            fontWeight: "700",
            fontSize: 14,
        },
        emptyTitle: {
            fontSize: 18,
            fontWeight: "700",
            textAlign: "center",
            marginTop: 8,
        },
        emptySub: {
            fontSize: 13,
            textAlign: "center",
            lineHeight: 18,
        },
    });
}
