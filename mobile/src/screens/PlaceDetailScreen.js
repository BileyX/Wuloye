import {
    Alert,
    Animated,
    Dimensions,
    Image,
    Linking,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { Marker } from "react-native-maps";
import { createInteraction } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { enrichPlaceLocation } from "../utils/placeLocation";
import { effectivePricingEnabled } from "../utils/pricingDisplay";
import { useAppTheme } from "../context/ThemeContext";
import AuthenticatedPlacePhoto, {
    toPlacePhotoAbsoluteUri,
} from "../components/AuthenticatedPlacePhoto";
import { fetchPlaceDetails } from "../api/placeApi";
import PlaceInteractionBar from "../components/PlaceInteractionBar";
import { usePlaceInteractions } from "../hooks/usePlaceInteractions";
import { getDenominationDisplay } from "../utils/denominationDisplay";

const { width: SCREEN_W } = Dimensions.get("window");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashString(s) {
    const str = String(s ?? "");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
}

/** True when we should call GET /places/:id (backend resolves Google + Firestore). */
function shouldFetchPlaceDetails(placeId) {
    if (typeof placeId !== "string" || placeId.length < 4) return false;
    const id = placeId.trim();
    if (id.startsWith("evt_")) return false;
    if (/^(?:Recommended )?place-\d+$/i.test(id)) return false;
    return true;
}

function openMapsExternal(lat, lng, label) {
    const q = encodeURIComponent(`${lat},${lng} (${label})`);
    Linking.openURL(
        `https://www.google.com/maps/search/?api=1&query=${q}`,
    ).catch(() => null);
}

// ─── Mock data generators (deterministic by place id) ─────────────────────────

const AMENITY_SETS = {
    gym: ["Free WiFi", "Parking", "Air Conditioned", "Lockers", "Showers"],
    cafe: ["Free WiFi", "Outdoor Seating", "Power Outlets", "Takeaway"],
    church: ["Parking", "Wheelchair Access", "Children's Area", "Prayer Hall"],
    events: ["Sound System", "Stage", "Bar", "VIP Area", "Parking"],
    workspace: ["Free WiFi", "Standing Desks", "Meeting Rooms", "Coffee Bar", "Printing"],
    default: ["Free WiFi", "Parking", "Air Conditioned"],
};

function getAmenities(type = "") {
    const t = type.toLowerCase();
    if (t.includes("gym") || t.includes("fitness")) return AMENITY_SETS.gym;
    if (t.includes("cafe") || t.includes("coffee")) return AMENITY_SETS.cafe;
    if (t.includes("church") || t.includes("worship")) return AMENITY_SETS.church;
    if (t.includes("event") || t.includes("music")) return AMENITY_SETS.events;
    if (t.includes("workspace") || t.includes("office")) return AMENITY_SETS.workspace;
    return AMENITY_SETS.default;
}

function getSlideGradients(type = "", isDark) {
    const t = type.toLowerCase();
    if (t.includes("gym") || t.includes("fitness")) {
        return isDark
            ? [["#0b2540", "#0e3050"], ["#0a2035", "#0c2a45"], ["#0c2840", "#0f3055"]]
            : [["#b8d9f5", "#c5eae0"], ["#a8cef0", "#b8e6d8"], ["#c0d8f8", "#cceee6"]];
    }
    if (t.includes("cafe") || t.includes("coffee")) {
        return isDark
            ? [["#2a150a", "#301a0c"], ["#251008", "#2d1709"], ["#2e1810", "#341e12"]]
            : [["#ffe0c0", "#fff3e0"], ["#ffd8b0", "#ffedcc"], ["#ffe8c8", "#fff5e6"]];
    }
    if (t.includes("church")) {
        return isDark
            ? [["#161428", "#1c1836"], ["#14122a", "#1a1632"], ["#181630", "#1e1a38"]]
            : [["#e8e0ff", "#f0eaff"], ["#ddd5ff", "#e8e2ff"], ["#ece6ff", "#f4f0ff"]];
    }
    if (t.includes("event") || t.includes("music")) {
        return isDark
            ? [["#20102a", "#2a1436"], ["#1c0e26", "#241230"], ["#221228", "#2c1634"]]
            : [["#ffd8f0", "#f5d0ff"], ["#ffcce8", "#eec8ff"], ["#ffe0f5", "#f8d8ff"]];
    }
    return isDark
        ? [["#0c1f38", "#0e2845"], ["#0a1c35", "#0c2440"], ["#0e2040", "#102848"]]
        : [["#c8eeff", "#d5f5e8"], ["#beebff", "#caf2e4"], ["#cef0ff", "#d8f8ee"]];
}

function getTypeIcon(type = "") {
    const t = type.toLowerCase();
    if (t.includes("gym") || t.includes("fitness")) return "barbell";
    if (t.includes("cafe") || t.includes("coffee")) return "cafe";
    if (t.includes("church") || t.includes("worship")) return "business";
    if (t.includes("event") || t.includes("music")) return "musical-notes";
    if (t.includes("workspace") || t.includes("office")) return "briefcase";
    return "location";
}

// ── Price helpers (use real AI-classified priceLevel + estimatedCost) ────────

function _firstNumberFromRange(rangeText) {
    if (typeof rangeText !== "string") return null;
    const m = rangeText.match(/\d[\d,]*/);
    if (!m) return null;
    const n = parseInt(m[0].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * Returns the "from X ETB" string for the bottom bar (only when pricing applies).
 * Uses estimatedCost bands first, then tier-based typical entry points.
 */
function getPriceLabel(place) {
    if (!effectivePricingEnabled(place)) return null;
    const cost = place?.estimatedCost;
    if (cost && typeof cost === "object") {
        const numbers = Object.values(cost)
            .map(_firstNumberFromRange)
            .filter((n) => typeof n === "number");
        if (numbers.length > 0) {
            const min = Math.min(...numbers);
            return `${min} ETB`;
        }
    }

    const tier = (place?.priceLevel || "").toLowerCase();
    if (tier === "cheap") return "150 ETB";
    if (tier === "mid") return "600 ETB";
    if (tier === "expensive") return "3500 ETB";

    return null;
}

function getPriceTierLabel(tier) {
    switch ((tier || "").toLowerCase()) {
        case "cheap":     return "Budget-friendly";
        case "mid":       return "Mid-range";
        case "expensive": return "Premium";
        default:          return null;
    }
}

function getPriceTierAccent(tier, palette) {
    switch ((tier || "").toLowerCase()) {
        case "cheap":     return palette.successGreen ?? "#3aa776";
        case "mid":       return palette.oceanBlue    ?? "#0a6aa8";
        case "expensive": return palette.dangerRed    ?? "#c25a4a";
        default:          return palette.textMuted    ?? "#888";
    }
}

function getCtaLabel(type = "") {
    const t = type.toLowerCase();
    if (t.includes("gym") || t.includes("fitness")) return "Book Membership";
    if (t.includes("cafe") || t.includes("coffee")) return "Get Directions";
    if (t.includes("church")) return "Visit Now";
    if (t.includes("event")) return "Get Ticket";
    if (t.includes("workspace")) return "Book a Desk";
    return "Save Place";
}

// ─── Stars ────────────────────────────────────────────────────────────────────

function Stars({ rating, size = 14 }) {
    return (
        <View style={{ flexDirection: "row", gap: 2 }}>
            {[1, 2, 3, 4, 5].map((i) => (
                <Ionicons
                    key={i}
                    name={i <= rating ? "star" : "star-outline"}
                    size={size}
                    color="#F5A623"
                />
            ))}
        </View>
    );
}

// ─── Image Carousel ───────────────────────────────────────────────────────────

function ImageCarousel({ place, isDark, onBack, onSave, isSaved }) {
    const scrollRef = useRef(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const slideGradients = useMemo(
        () => getSlideGradients(place?.type ?? "", isDark),
        [place?.type, isDark],
    );
    const typeIcon = getTypeIcon(place?.type ?? "");
    const photoPaths =
        Array.isArray(place?.images) && place.images.length > 0
            ? place.images
            : null;
    const slideCount = photoPaths ? photoPaths.length : slideGradients.length;

    const handleScroll = useCallback((e) => {
        const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
        setActiveIndex(idx);
    }, []);

    const renderPhotoSlide = (path, idx) => (
        <View
            key={`${path}-${idx}`}
            style={[carouselStyles.slide, { width: SCREEN_W }]}
        >
            <AuthenticatedPlacePhoto
                relativePath={path}
                style={StyleSheet.absoluteFillObject}
            />
            <LinearGradient
                colors={[
                    "rgba(0,0,0,0.42)",
                    "transparent",
                    "rgba(0,0,0,0.5)",
                ]}
                locations={[0, 0.42, 1]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={StyleSheet.absoluteFillObject}
                pointerEvents="none"
            />
            <View style={carouselStyles.iconWrap}>
                <Ionicons
                    name={typeIcon}
                    size={52}
                    color="rgba(255,255,255,0.55)"
                />
            </View>
            <View style={carouselStyles.slideLabel}>
                <Text
                    style={{
                        color: "rgba(255,255,255,0.75)",
                        fontSize: 10,
                        fontWeight: "700",
                    }}
                >
                    {idx + 1} / {slideCount}
                </Text>
            </View>
        </View>
    );

    const renderGradientSlide = (colors, idx) => (
        <LinearGradient
            key={idx}
            colors={colors}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[carouselStyles.slide, { width: SCREEN_W }]}
        >
            <View style={carouselStyles.grid} pointerEvents="none">
                {[60, 130, 200].map((x) => (
                    <View
                        key={x}
                        style={[
                            carouselStyles.gridLine,
                            { left: x, top: 0, bottom: 0, width: 1 },
                        ]}
                    />
                ))}
                {[60, 130, 200].map((y) => (
                    <View
                        key={y}
                        style={[
                            carouselStyles.gridLine,
                            { top: y, left: 0, right: 0, height: 1 },
                        ]}
                    />
                ))}
            </View>

            <View style={carouselStyles.iconWrap}>
                <Ionicons
                    name={typeIcon}
                    size={52}
                    color={
                        isDark
                            ? "rgba(140,210,255,0.5)"
                            : "rgba(30,110,190,0.35)"
                    }
                />
            </View>

            <View style={carouselStyles.slideLabel}>
                <Text
                    style={{
                        color: isDark
                            ? "rgba(200,235,255,0.6)"
                            : "rgba(20,80,140,0.5)",
                        fontSize: 10,
                        fontWeight: "700",
                    }}
                >
                    {idx + 1} / {slideCount}
                </Text>
            </View>
        </LinearGradient>
    );

    return (
        <View style={carouselStyles.container}>
            <ScrollView
                ref={scrollRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={handleScroll}
                scrollEventThrottle={16}
            >
                {photoPaths
                    ? photoPaths.map((path, idx) => renderPhotoSlide(path, idx))
                    : slideGradients.map((colors, idx) =>
                          renderGradientSlide(colors, idx),
                      )}
            </ScrollView>

            {/* Dots */}
            <View style={carouselStyles.dots}>
                {Array.from({ length: slideCount }).map((_, i) => (
                    <View
                        key={i}
                        style={[
                            carouselStyles.dot,
                            i === activeIndex && carouselStyles.dotActive,
                        ]}
                    />
                ))}
            </View>

            {/* Back button */}
            <Pressable
                onPress={onBack}
                hitSlop={12}
                style={carouselStyles.backBtn}
            >
                <Ionicons name="chevron-back" size={20} color="#fff" />
            </Pressable>

            {/* Save/heart button */}
            <Pressable
                onPress={onSave}
                hitSlop={12}
                style={[
                    carouselStyles.heartBtn,
                    isSaved && { backgroundColor: "rgba(207,62,85,0.85)" },
                ]}
            >
                <Ionicons
                    name={isSaved ? "bookmark" : "bookmark-outline"}
                    size={19}
                    color="#fff"
                />
            </Pressable>
        </View>
    );
}

const carouselStyles = StyleSheet.create({
    container: { height: 260, width: "100%", position: "relative" },
    slide: {
        height: 260,
        alignItems: "center",
        justifyContent: "center",
    },
    grid: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        opacity: 0.14,
    },
    gridLine: {
        position: "absolute",
        backgroundColor: "#38AEFF",
    },
    iconWrap: {
        width: 90,
        height: 90,
        borderRadius: 45,
        backgroundColor: "rgba(255,255,255,0.08)",
        alignItems: "center",
        justifyContent: "center",
    },
    slideLabel: {
        position: "absolute",
        top: 12,
        right: 12,
    },
    dots: {
        position: "absolute",
        bottom: 14,
        left: 0,
        right: 0,
        flexDirection: "row",
        justifyContent: "center",
        gap: 6,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: "rgba(255,255,255,0.4)",
    },
    dotActive: {
        width: 18,
        backgroundColor: "rgba(255,255,255,0.92)",
    },
    backBtn: {
        position: "absolute",
        top: 16,
        left: 16,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: "rgba(10,30,55,0.48)",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.2)",
    },
    heartBtn: {
        position: "absolute",
        top: 16,
        right: 16,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: "rgba(10,30,55,0.48)",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.2)",
    },
});

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

const TABS = ["Overview", "Reviews", "Map"];

function TabBar({ active, onChange, palette, isDark }) {
    return (
        <View
            style={[
                tabStyles.wrap,
                {
                    backgroundColor: isDark
                        ? "rgba(18,35,60,0.9)"
                        : "rgba(235,245,255,0.9)",
                    borderColor: isDark
                        ? "rgba(100,180,255,0.18)"
                        : "rgba(10,106,168,0.12)",
                },
            ]}
        >
            {TABS.map((tab) => {
                const isActive = active === tab;
                return (
                    <Pressable
                        key={tab}
                        onPress={() => onChange(tab)}
                        style={[
                            tabStyles.tab,
                            isActive && {
                                backgroundColor: isDark ? "rgba(22,44,72,0.95)" : "#fff",
                                borderColor: isDark
                                    ? "rgba(100,180,255,0.3)"
                                    : "rgba(10,106,168,0.2)",
                                shadowColor: "#000",
                                shadowOffset: { width: 0, height: 2 },
                                shadowOpacity: 0.08,
                                shadowRadius: 6,
                                elevation: 3,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                tabStyles.tabText,
                                {
                                    color: isActive
                                        ? palette.textPrimary
                                        : palette.textMuted,
                                    fontWeight: isActive ? "800" : "600",
                                },
                            ]}
                        >
                            {tab}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const tabStyles = StyleSheet.create({
    wrap: {
        flexDirection: "row",
        borderRadius: 16,
        borderWidth: 1,
        padding: 4,
        gap: 2,
    },
    tab: {
        flex: 1,
        paddingVertical: 9,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "transparent",
    },
    tabText: {
        fontSize: 13,
    },
});

// ─── Match Score Banner ───────────────────────────────────────────────────────

function MatchScoreBanner({ place, palette, isDark, styles }) {
    const numericScore = useMemo(() => {
        const s = place?.score ?? "";
        const m = String(s).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }, [place?.score]);

    if (!numericScore) return null;

    const color =
        numericScore >= 85 ? "#10B981" :
        numericScore >= 70 ? "#3B82F6" :
        "#6366F1";

    const budgetMatch   = place?.matches?.budget === true   || place?.budgetFit === true;
    const religionMatch = place?.matches?.religion === true;
    const hasDistance   = Boolean(place?.distance);

    const { label: denomLabel, color: denomColor } = getDenominationDisplay(place);

    return (
        <View style={[
            styles.matchBanner,
            {
                backgroundColor: isDark ? `${color}18` : `${color}12`,
                borderColor: `${color}40`,
            },
        ]}>
            {/* Score ring */}
            <View style={[styles.matchRing, { borderColor: `${color}60`, backgroundColor: `${color}18` }]}>
                <Text style={[styles.matchRingNum, { color }]}>{numericScore}</Text>
                <Text style={[styles.matchRingPct, { color }]}>%</Text>
            </View>

            {/* Label + chips */}
            <View style={{ flex: 1 }}>
                <Text style={[styles.matchBannerLabel, { color: palette.textPrimary }]}>
                    AI match score
                </Text>
                <View style={styles.matchBannerChips}>
                    {budgetMatch && (
                        <View style={[styles.matchChip, { backgroundColor: "rgba(16,185,129,0.12)", borderColor: "rgba(16,185,129,0.35)" }]}>
                            <Ionicons name="checkmark-circle" size={10} color="#059669" />
                            <Text style={[styles.matchChipText, { color: "#059669" }]}>Budget</Text>
                        </View>
                    )}
                    {denomLabel ? (
                        <View style={[styles.matchChip, { backgroundColor: `${denomColor}15`, borderColor: `${denomColor}40` }]}>
                            <Ionicons name="shield-checkmark-outline" size={10} color={denomColor} />
                            <Text style={[styles.matchChipText, { color: denomColor }]}>
                                {religionMatch ? `Matched · ${denomLabel}` : denomLabel}
                            </Text>
                        </View>
                    ) : religionMatch ? (
                        <View style={[styles.matchChip, { backgroundColor: "rgba(139,92,246,0.12)", borderColor: "rgba(139,92,246,0.35)" }]}>
                            <Ionicons name="checkmark-circle" size={10} color="#7C3AED" />
                            <Text style={[styles.matchChipText, { color: "#7C3AED" }]}>Faith</Text>
                        </View>
                    ) : null}
                    {hasDistance && (
                        <View style={[styles.matchChip, { backgroundColor: "rgba(59,130,246,0.12)", borderColor: "rgba(59,130,246,0.35)" }]}>
                            <Ionicons name="location-outline" size={10} color="#2563EB" />
                            <Text style={[styles.matchChipText, { color: "#2563EB" }]}>Near you</Text>
                        </View>
                    )}
                </View>
            </View>
        </View>
    );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ place, palette, isDark, styles }) {
    const amenities = useMemo(() => getAmenities(place?.type ?? ""), [place?.type]);
    const contactPhone = useMemo(() => {
        const h = hashString(place?.placeId ?? "x");
        return `+251 9${10 + (h % 80)} ${100 + (h % 900)} ${1000 + (h % 9000)}`.replace(/\s/g, " ");
    }, [place?.placeId]);

    const showPricing       = effectivePricingEnabled(place);
    const reason            = place?.reason || place?.aiInsight || null;
    const priceTier         = place?.priceLevel || null;
    const priceTierLabel    = getPriceTierLabel(priceTier);
    const priceTierAccent   = getPriceTierAccent(priceTier, palette);
    const estimatedCost     = (place?.estimatedCost && typeof place.estimatedCost === "object")
        ? Object.entries(place.estimatedCost)
        : [];
    const budgetMatch       = showPricing ? (place?.matches?.budget ?? true) : true;

    return (
        <View style={styles.tabContent}>

            {/* ── AI Match Score Banner (top of overview) ── */}
            <MatchScoreBanner place={place} palette={palette} isDark={isDark} styles={styles} />

            {/* ── AI Summary / Why we recommend ── */}
            {reason ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>AI summary</Text>
                    <View
                        style={[
                            styles.reasonCard,
                            {
                                backgroundColor: isDark
                                    ? "rgba(20,55,95,0.6)"
                                    : "rgba(220,242,255,0.7)",
                                borderColor: isDark
                                    ? "rgba(100,180,255,0.22)"
                                    : "rgba(10,106,168,0.18)",
                            },
                        ]}
                    >
                        <Ionicons
                            name="sparkles"
                            size={16}
                            color={palette.oceanBlue}
                            style={{ marginRight: 8, marginTop: 1 }}
                        />
                        <Text style={[styles.reasonText, { color: palette.textPrimary }]}>
                            {reason}
                        </Text>
                    </View>
                </View>
            ) : null}

            {/* Price range — only when consumer spending is relevant */}
            {showPricing && (priceTierLabel || estimatedCost.length > 0) ? (
            <View style={styles.section}>
                <View style={styles.priceHeaderRow}>
                    <Text style={styles.sectionTitle}>Price range</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        {!budgetMatch ? (
                            <View style={[styles.priceTierPill, { backgroundColor: "#ff4d4d22", borderColor: "#ff4d4d55" }]}>
                                <Text style={[styles.priceTierPillText, { color: "#e03030" }]}>
                                    Above budget
                                </Text>
                            </View>
                        ) : null}
                        {priceTierLabel ? (
                            <View
                                style={[
                                    styles.priceTierPill,
                                    { backgroundColor: priceTierAccent + "22", borderColor: priceTierAccent + "55" },
                                ]}
                            >
                                <Text style={[styles.priceTierPillText, { color: priceTierAccent }]}>
                                    {priceTierLabel}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                </View>
                {estimatedCost.length > 0 ? (
                    <View style={styles.priceRangeList}>
                        {estimatedCost.map(([item, range]) => (
                            <View key={item} style={styles.priceRangeRow}>
                                <Text style={[styles.priceRangeItem, { color: palette.textSecondary }]}>
                                    {item.charAt(0).toUpperCase() + item.slice(1)}
                                </Text>
                                <Text style={[styles.priceRangeValue, { color: palette.textPrimary }]}>
                                    {range}
                                </Text>
                            </View>
                        ))}
                    </View>
                ) : (
                    <Text style={[styles.bodyText, { color: palette.textMuted }]}>
                        {priceTierLabel
                            ? `Estimated ${priceTierLabel.toLowerCase()} pricing based on similar places in Addis Ababa.`
                            : null}
                    </Text>
                )}
            </View>
            ) : null}

            {/* About */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>About</Text>
                <Text style={styles.bodyText}>
                    {place?.description ??
                        `A premium facility offering top-notch services and amenities. Perfect for your daily routine and lifestyle needs.`}
                </Text>
            </View>

            {/* Amenities */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Amenities</Text>
                <View style={styles.chipRow}>
                    {amenities.map((a) => (
                        <View
                            key={a}
                            style={[
                                styles.chip,
                                {
                                    backgroundColor: isDark
                                        ? "rgba(20,45,75,0.8)"
                                        : "rgba(255,255,255,0.9)",
                                    borderColor: isDark
                                        ? "rgba(100,180,255,0.22)"
                                        : "rgba(10,106,168,0.16)",
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.chipText,
                                    { color: palette.textSecondary },
                                ]}
                            >
                                {a}
                            </Text>
                        </View>
                    ))}
                </View>
            </View>

            {/* Contact */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Contact</Text>
                <Pressable
                    style={styles.contactRow}
                    onPress={() =>
                        Linking.openURL(`tel:${contactPhone}`).catch(() => null)
                    }
                >
                    <View
                        style={[
                            styles.contactIconBox,
                            { backgroundColor: isDark ? "rgba(20,55,95,0.8)" : "rgba(220,242,255,0.9)" },
                        ]}
                    >
                        <Ionicons
                            name="call-outline"
                            size={16}
                            color={palette.oceanBlue}
                        />
                    </View>
                    <Text style={[styles.contactText, { color: palette.textPrimary }]}>
                        {contactPhone}
                    </Text>
                    <Ionicons
                        name="chevron-forward"
                        size={14}
                        color={palette.textMuted}
                    />
                </Pressable>

                <View
                    style={[styles.contactRow, { marginTop: 8 }]}
                >
                    <View
                        style={[
                            styles.contactIconBox,
                            { backgroundColor: isDark ? "rgba(20,55,95,0.8)" : "rgba(220,242,255,0.9)" },
                        ]}
                    >
                        <Ionicons
                            name="time-outline"
                            size={16}
                            color={palette.oceanBlue}
                        />
                    </View>
                    <Text style={[styles.contactText, { color: palette.textSecondary }]}>
                        {place?.hoursDisplay ?? "Mon–Sun · 9:00 — 22:00"}
                    </Text>
                </View>

                <View
                    style={[styles.contactRow, { marginTop: 8 }]}
                >
                    <View
                        style={[
                            styles.contactIconBox,
                            { backgroundColor: isDark ? "rgba(20,55,95,0.8)" : "rgba(220,242,255,0.9)" },
                        ]}
                    >
                        <Ionicons
                            name="location-outline"
                            size={16}
                            color={palette.oceanBlue}
                        />
                    </View>
                    <Text
                        style={[
                            styles.contactText,
                            { color: palette.textSecondary, flex: 1 },
                        ]}
                        numberOfLines={1}
                    >
                        {place?.addressLine ?? "Addis Ababa, Ethiopia"}
                    </Text>
                </View>
            </View>
        </View>
    );
}

// ─── Reviews Tab (Google Maps data only — no mock reviews) ───────────────────

function ReviewsTab({ place, palette, isDark, styles, detailLoading }) {
    const reviews = useMemo(() => {
        const raw = place?.reviews;
        return Array.isArray(raw) ? raw : [];
    }, [place?.reviews]);

    const isEvent = Boolean(place?.isEvent);
    const placeIdStr = String(place?.placeId ?? place?.id ?? "");

    const totalOnGoogle =
        typeof place?.userRatingsTotal === "number" ? place.userRatingsTotal : null;

    const aggregateRating = useMemo(() => {
        const r = place?.rating;
        if (typeof r === "number" && r > 0) return r.toFixed(1);
        if (reviews.length === 0) return null;
        const sum = reviews.reduce((s, x) => s + (Number(x.rating) || 0), 0);
        return (sum / reviews.length).toFixed(1);
    }, [place?.rating, reviews]);

    const reviewCountLabel = useMemo(() => {
        if (totalOnGoogle != null && totalOnGoogle > 0) {
            return `${totalOnGoogle} review${totalOnGoogle !== 1 ? "s" : ""} on Google Maps`;
        }
        if (reviews.length > 0) {
            return `${reviews.length} review${reviews.length !== 1 ? "s" : ""} shown`;
        }
        return "0 reviews";
    }, [totalOnGoogle, reviews.length]);

    const starsRounded = aggregateRating
        ? Math.min(5, Math.max(0, Math.round(Number(aggregateRating))))
        : 0;

    const emptyMessage = useMemo(() => {
        if (isEvent) {
            return "No reviews for this event in the app yet. Check the organiser's page for feedback.";
        }
        if (totalOnGoogle != null && totalOnGoogle > 0) {
            return "This place has reviews on Google Maps, but review text is not shown here. Open Google Maps to read them.";
        }
        return "No reviews for this listing yet.";
    }, [isEvent, totalOnGoogle]);

    return (
        <View style={styles.tabContent}>
            {/* Summary */}
            <View
                style={[
                    styles.reviewSummary,
                    {
                        backgroundColor: isDark
                            ? "rgba(18,40,70,0.8)"
                            : "rgba(255,255,255,0.9)",
                        borderColor: isDark
                            ? "rgba(100,180,255,0.18)"
                            : "rgba(10,106,168,0.12)",
                    },
                ]}
            >
                <View style={styles.ratingBig}>
                    <Text style={[styles.ratingBigNum, { color: palette.textPrimary }]}>
                        {aggregateRating ?? "—"}
                    </Text>
                    <Stars rating={starsRounded} size={16} />
                    <Text
                        style={[styles.ratingCount, { color: palette.textMuted }]}
                    >
                        {reviewCountLabel}
                    </Text>
                </View>
            </View>

            {detailLoading ? (
                <Text
                    style={[
                        styles.reviewEmptyHint,
                        { color: palette.textMuted, marginTop: 16 },
                    ]}
                >
                    Loading reviews…
                </Text>
            ) : null}

            {!detailLoading && reviews.length === 0 ? (
                <View
                    style={[
                        styles.reviewEmptyWrap,
                        {
                            backgroundColor: isDark
                                ? "rgba(16,35,60,0.72)"
                                : "rgba(255,255,255,0.88)",
                            borderColor: isDark
                                ? "rgba(80,160,255,0.14)"
                                : "rgba(10,106,168,0.1)",
                        },
                    ]}
                >
                    <Ionicons
                        name="chatbubbles-outline"
                        size={28}
                        color={palette.textMuted}
                        style={{ marginBottom: 8 }}
                    />
                    <Text
                        style={[
                            styles.reviewEmptyTitle,
                            { color: palette.textSecondary },
                        ]}
                    >
                        {emptyMessage}
                    </Text>
                </View>
            ) : null}

            {!detailLoading
                ? reviews.map((review) => (
                      <View
                          key={review.id}
                          style={[
                              styles.reviewCard,
                              {
                                  backgroundColor: isDark
                                      ? "rgba(16,35,60,0.8)"
                                      : "rgba(255,255,255,0.92)",
                                  borderColor: isDark
                                      ? "rgba(80,160,255,0.16)"
                                      : "rgba(10,106,168,0.1)",
                              },
                          ]}
                      >
                          <View style={styles.reviewHeader}>
                              <View style={styles.reviewAvatar}>
                                  <Text style={styles.reviewAvatarText}>
                                      {(review.name || "?").charAt(0)}
                                  </Text>
                              </View>
                              <View style={{ flex: 1 }}>
                                  <View style={styles.reviewNameRow}>
                                      <Text
                                          style={[
                                              styles.reviewName,
                                              { color: palette.textPrimary },
                                          ]}
                                      >
                                          {review.name || "User"}
                                      </Text>
                                      <Text
                                          style={[
                                              styles.reviewTime,
                                              { color: palette.textMuted },
                                          ]}
                                      >
                                          {review.timeAgo || ""}
                                      </Text>
                                  </View>
                                  <Stars
                                      rating={Math.min(
                                          5,
                                          Math.max(
                                              0,
                                              Math.round(
                                                  Number(review.rating) || 0,
                                              ),
                                          ),
                                      )}
                                      size={13}
                                  />
                              </View>
                          </View>
                          <Text
                              style={[
                                  styles.reviewComment,
                                  { color: palette.textSecondary },
                              ]}
                          >
                              {review.comment?.trim()
                                  ? review.comment
                                  : "(No written review)"}
                          </Text>
                      </View>
                  ))
                : null}
        </View>
    );
}

// ─── Map Tab ──────────────────────────────────────────────────────────────────

function MapTab({ place, palette, isDark, styles }) {
    const lat = place?.latitude;
    const lng = place?.longitude;
    const hasCoords = typeof lat === "number" && typeof lng === "number";

    if (!hasCoords) {
        return (
            <View style={styles.tabContent}>
                <View
                    style={[
                        styles.mapNoCoords,
                        {
                            backgroundColor: isDark
                                ? "rgba(18,35,58,0.8)"
                                : "rgba(235,250,255,0.9)",
                            borderColor: palette.borderSoft,
                        },
                    ]}
                >
                    <Ionicons
                        name="location-outline"
                        size={36}
                        color={palette.textMuted}
                    />
                    <Text
                        style={[
                            styles.mapNoCoordsText,
                            { color: palette.textMuted },
                        ]}
                    >
                        Location not available
                    </Text>
                </View>
            </View>
        );
    }

    const region = {
        latitude: lat,
        longitude: lng,
        latitudeDelta: 0.015,
        longitudeDelta: 0.015,
    };

    return (
        <View style={styles.tabContent}>
            {Platform.OS === "web" ? (
                <Pressable
                    style={styles.mapShell}
                    onPress={() => openMapsExternal(lat, lng, place.name)}
                >
                    <LinearGradient
                        colors={
                            isDark
                                ? ["#0C2040", "#0e2d50", "#0B3428"]
                                : ["#C8EEFF", "#D8F5E8", "#E6F8F2"]
                        }
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.mapFallback}
                    >
                        <Ionicons
                            name="location"
                            size={32}
                            color={palette.oceanBlue}
                        />
                        <Text
                            style={[
                                styles.mapFallbackTitle,
                                { color: palette.textPrimary },
                            ]}
                        >
                            Map Location
                        </Text>
                        <Text
                            style={[
                                styles.mapFallbackSub,
                                { color: palette.textSecondary },
                            ]}
                        >
                            {place?.distance ?? "Nearby"}
                        </Text>
                        <View style={styles.mapOpenRow}>
                            <Ionicons
                                name="open-outline"
                                size={13}
                                color={palette.oceanBlue}
                            />
                            <Text
                                style={[
                                    styles.mapOpenText,
                                    { color: palette.oceanBlue },
                                ]}
                            >
                                Open in Maps
                            </Text>
                        </View>
                    </LinearGradient>
                </Pressable>
            ) : (
                <Pressable
                    style={styles.mapShell}
                    onPress={() => openMapsExternal(lat, lng, place.name)}
                >
                    <MapView
                        style={StyleSheet.absoluteFillObject}
                        initialRegion={region}
                        scrollEnabled={false}
                        rotateEnabled={false}
                        pitchEnabled={false}
                        zoomEnabled={false}
                    >
                        <Marker
                            coordinate={{ latitude: lat, longitude: lng }}
                            title={place?.name}
                            description={place?.addressLine}
                        />
                    </MapView>
                    <View
                        style={[
                            styles.mapOpenHint,
                            { backgroundColor: isDark ? "rgba(12,28,50,0.9)" : "rgba(255,255,255,0.92)" },
                        ]}
                    >
                        <Ionicons
                            name="open-outline"
                            size={12}
                            color={palette.deepBlue}
                        />
                        <Text
                            style={[
                                styles.mapOpenHintText,
                                { color: palette.deepBlue },
                            ]}
                        >
                            Open in Maps
                        </Text>
                    </View>
                </Pressable>
            )}

            {/* Address */}
            <View
                style={[
                    styles.addressCard,
                    {
                        backgroundColor: isDark
                            ? "rgba(16,35,58,0.8)"
                            : "rgba(255,255,255,0.9)",
                        borderColor: palette.borderSoft,
                    },
                ]}
            >
                <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                    <Ionicons
                        name="location-outline"
                        size={18}
                        color={palette.oceanBlue}
                    />
                    <Text
                        style={[
                            styles.addressText,
                            { color: palette.textPrimary },
                        ]}
                    >
                        {place?.addressLine ?? "Addis Ababa, Ethiopia"}
                    </Text>
                </View>
                <Text
                    style={[styles.coordsText, { color: palette.textMuted }]}
                >
                    {`${lat.toFixed(5)}, ${lng.toFixed(5)}`}
                </Text>
            </View>
        </View>
    );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function PlaceDetailScreen({ navigation, route }) {
    const { palette, gradients, isDark } = useAppTheme();
    const insets = useSafeAreaInsets();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );

    const raw = route?.params?.place;
    const placeId = raw?.placeId ?? raw?.id;

    const shouldFetchDetails = shouldFetchPlaceDetails(
        typeof placeId === "string" ? placeId : "",
    );

    const [detailPatch, setDetailPatch] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);

    useEffect(() => {
        const first =
            (Array.isArray(raw?.images) && raw.images[0]) ||
            (typeof raw?.image === "string" ? raw.image : null);
        const uri = toPlacePhotoAbsoluteUri(first);
        if (uri) Image.prefetch(uri).catch(() => null);
    }, [raw?.placeId, raw?.id, raw?.image]);

    useEffect(() => {
        setDetailPatch(null);
        if (!placeId || !shouldFetchDetails) {
            setDetailLoading(false);
            return;
        }
        let cancelled = false;
        setDetailLoading(true);
        fetchPlaceDetails(String(placeId))
            .then((d) => {
                if (!cancelled && d && typeof d === "object") setDetailPatch(d);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setDetailLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [placeId, shouldFetchDetails]);

    const place = useMemo(() => {
        const merged = { ...(raw ?? {}), ...detailPatch };
        return enrichPlaceLocation(merged, 0);
    }, [raw, detailPatch]);

    const [activeTab, setActiveTab] = useState("Overview");
    const [isSaved, setIsSaved] = useState(false);
    const [isLiked, setIsLiked] = useState(false);
    const [isDisliked, setIsDisliked] = useState(false);
    const saveAnim = useRef(new Animated.Value(1)).current;
    const openedAtRef = useRef(Date.now());

    const bottomPad = Math.max(insets.bottom, 12) + 8;

    const interactions = usePlaceInteractions(place, {
        source: "place_detail",
        onAfterNegative: () => navigation.goBack(),
    });

    // Log view on open; long view when leaving after 5+ seconds
    useEffect(() => {
        const pid = place?.placeId ?? place?.id;
        if (!pid) return undefined;
        openedAtRef.current = Date.now();
        createInteraction({
            placeId: pid,
            actionType: INTERACTION_TYPES.VIEW,
            metadata: { source: "place_detail" },
        }).catch(() => null);
        return () => {
            const secs = (Date.now() - openedAtRef.current) / 1000;
            if (secs >= 5) {
                createInteraction({
                    placeId: pid,
                    actionType: INTERACTION_TYPES.VIEW_LONG,
                    metadata: {
                        source: "place_detail",
                        durationSec: Math.round(secs),
                    },
                }).catch(() => null);
            }
        };
    }, [place?.placeId, place?.id]);

    function bounceSaveIcon() {
        Animated.sequence([
            Animated.spring(saveAnim, {
                toValue: 1.25,
                useNativeDriver: true,
                friction: 4,
            }),
            Animated.spring(saveAnim, {
                toValue: 1,
                useNativeDriver: true,
                friction: 6,
            }),
        ]).start();
    }

    async function handleSave() {
        const next = await interactions.handleSave(isSaved);
        setIsSaved(next);
        bounceSaveIcon();
        if (next) {
            Alert.alert(
                "Saved",
                "Find this place anytime under Profile → Saved places.",
            );
        }
    }

    async function handleCarouselSave() {
        await handleSave();
    }

    async function handleLike() {
        if (isLiked) return;
        setIsLiked(true);
        setIsDisliked(false);
        await interactions.handleLike();
    }

    async function handleDislike() {
        if (isDisliked) {
            navigation.goBack();
            return;
        }
        setIsDisliked(true);
        setIsLiked(false);
        await interactions.handleDislike();
    }

    async function handleShare() {
        await interactions.handleShare();
    }

    async function handleDirections() {
        await interactions.handleDirections();
    }

    async function handleNotInterested() {
        setIsDisliked(true);
        await interactions.handleNotInterested();
    }

    async function handleBottomDismiss() {
        await interactions.handleDismiss();
    }

    // Parse numeric score for star display
    const numericScore = useMemo(() => {
        const s = place?.score ?? "";
        const m = String(s).match(/(\d+)/);
        if (m) return parseInt(m[1], 10);
        return null;
    }, [place?.score]);

    const ratingDisplay = numericScore ? (numericScore / 20).toFixed(1) : null;

    const showPricing = useMemo(
        () => effectivePricingEnabled(place),
        [place],
    );

    const priceLabelFooter = useMemo(() => getPriceLabel(place), [place]);

    const { label: denomLabel, color: denomColor } = useMemo(
        () => getDenominationDisplay(place),
        [place],
    );

    return (
        <SafeAreaView
            style={[styles.safeArea, { backgroundColor: palette.pageTop }]}
            edges={["top"]}
        >
            <ScrollView
                showsVerticalScrollIndicator={false}
                stickyHeaderIndices={[2]}
                contentContainerStyle={{ paddingBottom: bottomPad + 80 }}
                bounces
            >
                {/* 1. Image Carousel — idx 0 */}
                <ImageCarousel
                    place={place}
                    isDark={isDark}
                    onBack={() => navigation.goBack()}
                    onSave={handleCarouselSave}
                    isSaved={isSaved}
                />

                {/* 2. Place header + info cards — idx 1 */}
                <View style={styles.headerSection}>
                    <LinearGradient
                        colors={gradients.appBackground}
                        style={StyleSheet.absoluteFillObject}
                    />

                    {/* Name row */}
                    <View style={styles.nameRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.placeName}>
                                {place?.name ?? "Place"}
                            </Text>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <Text style={styles.placeType}>
                                    {place?.type ?? "Spot"}
                                </Text>
                                {denomLabel ? (
                                    <View style={{
                                        flexDirection: "row", alignItems: "center", gap: 3,
                                        backgroundColor: `${denomColor}15`,
                                        borderWidth: 1, borderColor: `${denomColor}40`,
                                        borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2,
                                    }}>
                                        <Ionicons name="shield-checkmark-outline" size={10} color={denomColor} />
                                        <Text style={{ color: denomColor, fontSize: 10, fontWeight: "700" }}>
                                            {denomLabel}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                        </View>
                        {ratingDisplay ? (
                            <View style={styles.ratingBadge}>
                                <Ionicons name="star" size={13} color="#F5A623" />
                                <Text style={styles.ratingBadgeText}>
                                    {ratingDisplay}
                                </Text>
                            </View>
                        ) : null}
                    </View>

                    {/* Info cards: Distance + Hours */}
                    <View style={styles.infoCardsRow}>
                        <View
                            style={[
                                styles.infoCard,
                                {
                                    backgroundColor: isDark
                                        ? "rgba(18,38,62,0.85)"
                                        : "rgba(255,255,255,0.92)",
                                    borderColor: palette.borderSoft,
                                },
                            ]}
                        >
                            <View style={styles.infoCardTop}>
                                <Ionicons
                                    name="location-outline"
                                    size={14}
                                    color={palette.textMuted}
                                />
                                <Text
                                    style={[
                                        styles.infoCardLabel,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Distance
                                </Text>
                            </View>
                            <Text
                                style={[
                                    styles.infoCardValue,
                                    { color: palette.textPrimary },
                                ]}
                            >
                                {place?.distance ?? "Nearby"}
                            </Text>
                        </View>

                        <View
                            style={[
                                styles.infoCard,
                                {
                                    backgroundColor: isDark
                                        ? "rgba(18,38,62,0.85)"
                                        : "rgba(255,255,255,0.92)",
                                    borderColor: palette.borderSoft,
                                },
                            ]}
                        >
                            <View style={styles.infoCardTop}>
                                <Ionicons
                                    name="time-outline"
                                    size={14}
                                    color={palette.textMuted}
                                />
                                <Text
                                    style={[
                                        styles.infoCardLabel,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Hours
                                </Text>
                            </View>
                            <Text
                                style={[
                                    styles.infoCardValue,
                                    { color: palette.textPrimary },
                                ]}
                            >
                                {place?.isOpen === false
                                    ? "Closed"
                                    : place?.hoursDisplay?.toLowerCase().includes("24")
                                      ? "Open 24/7"
                                      : "Open Now"}
                            </Text>
                        </View>
                    </View>

                    <PlaceInteractionBar
                        liked={isLiked}
                        disliked={isDisliked}
                        saved={isSaved}
                        onLike={handleLike}
                        onDislike={handleDislike}
                        onSave={handleSave}
                        onShare={handleShare}
                        onDirections={handleDirections}
                        onNotInterested={handleNotInterested}
                    />
                </View>

                {/* 3. Tab bar — idx 2 (sticky) */}
                <View
                    style={[
                        styles.stickyTabWrap,
                        {
                            backgroundColor: isDark
                                ? palette.pageTop
                                : palette.pageTop,
                        },
                    ]}
                >
                    <TabBar
                        active={activeTab}
                        onChange={setActiveTab}
                        palette={palette}
                        isDark={isDark}
                    />
                </View>

                {/* 4. Tab content — idx 3 */}
                <View
                    style={[
                        styles.tabContentWrap,
                        {
                            backgroundColor: isDark
                                ? "rgba(6,10,20,0.0)"
                                : "rgba(235,248,255,0.0)",
                        },
                    ]}
                >
                    {activeTab === "Overview" && (
                        <OverviewTab
                            place={place}
                            palette={palette}
                            isDark={isDark}
                            styles={styles}
                        />
                    )}
                    {activeTab === "Reviews" && (
                        <ReviewsTab
                            place={place}
                            palette={palette}
                            isDark={isDark}
                            styles={styles}
                            detailLoading={detailLoading}
                        />
                    )}
                    {activeTab === "Map" && (
                        <MapTab
                            place={place}
                            palette={palette}
                            isDark={isDark}
                            styles={styles}
                        />
                    )}
                </View>
            </ScrollView>

            {/* Sticky bottom bar */}
            <View
                style={[
                    styles.bottomBar,
                    {
                        paddingBottom: bottomPad,
                        backgroundColor: isDark
                            ? "rgba(6,10,20,0.96)"
                            : "rgba(248,253,255,0.97)",
                        borderTopColor: palette.borderSoft,
                    },
                ]}
            >
                {showPricing && priceLabelFooter ? (
                    <View style={styles.priceWrapBottom}>
                        <Text style={[styles.priceFrom, { color: palette.textMuted }]}>
                            {place?.priceLevel
                                ? `${getPriceTierLabel(place.priceLevel) || "Price"} · from`
                                : "Est. from"}
                        </Text>
                        <Text style={[styles.priceValue, { color: palette.textPrimary }]}>
                            {priceLabelFooter}
                        </Text>
                    </View>
                ) : (
                    <View style={styles.priceWrapBottom} />
                )}

                <Pressable
                    onPress={handleDirections}
                    style={styles.ctaBtnWrap}
                >
                    <LinearGradient
                        colors={gradients.primaryButton}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.ctaBtn}
                    >
                        <Ionicons
                            name="navigate"
                            size={18}
                            color={palette.iceWhite}
                            style={{ marginRight: 6 }}
                        />
                        <Text style={styles.ctaBtnText}>Get directions</Text>
                    </LinearGradient>
                </Pressable>

                <Pressable
                    onPress={handleBottomDismiss}
                    hitSlop={8}
                    style={styles.bottomDismissBtn}
                >
                    <Ionicons name="close" size={20} color={palette.textMuted} />
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function createStyles(palette, isDark) {
    return StyleSheet.create({
        safeArea: { flex: 1 },

        // Header section
        headerSection: {
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 12,
            overflow: "hidden",
        },
        nameRow: {
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 14,
        },
        placeName: {
            color: palette.textPrimary,
            fontSize: 22,
            fontWeight: "900",
            lineHeight: 28,
        },
        placeType: {
            color: palette.oceanBlue,
            fontSize: 13,
            fontWeight: "700",
            marginTop: 3,
        },
        ratingBadge: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: isDark
                ? "rgba(40,30,10,0.9)"
                : "rgba(255,246,220,0.95)",
            borderWidth: 1,
            borderColor: isDark
                ? "rgba(245,166,35,0.35)"
                : "rgba(245,166,35,0.4)",
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginTop: 4,
        },
        ratingBadgeText: {
            color: "#F5A623",
            fontWeight: "800",
            fontSize: 13,
        },
        infoCardsRow: {
            flexDirection: "row",
            gap: 10,
        },
        infoCard: {
            flex: 1,
            borderRadius: 14,
            borderWidth: 1,
            padding: 12,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 6,
            elevation: 2,
        },
        infoCardTop: {
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            marginBottom: 8,
        },
        infoCardLabel: {
            fontSize: 12,
            fontWeight: "600",
        },
        infoCardValue: {
            fontSize: 16,
            fontWeight: "800",
        },

        // Sticky tab bar wrap
        stickyTabWrap: {
            paddingHorizontal: 16,
            paddingVertical: 8,
        },

        // Tab content wrapper
        tabContentWrap: {
            paddingHorizontal: 16,
        },
        tabContent: {
            paddingTop: 4,
        },

        // Shared section
        section: {
            marginTop: 16,
        },
        sectionTitle: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "800",
            marginBottom: 10,
        },
        bodyText: {
            color: palette.textSecondary,
            fontSize: 14,
            lineHeight: 22,
        },

        // Amenity chips
        chipRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
        },
        chip: {
            borderRadius: 999,
            borderWidth: 1,
            paddingHorizontal: 12,
            paddingVertical: 6,
        },
        chipText: {
            fontSize: 12,
            fontWeight: "600",
        },

        // Contact
        contactRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
        },
        contactIconBox: {
            width: 34,
            height: 34,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
        },
        contactText: {
            fontSize: 14,
            fontWeight: "600",
            flex: 1,
        },

        // Reviews
        reviewSummary: {
            borderRadius: 16,
            borderWidth: 1,
            padding: 14,
            marginTop: 8,
            alignItems: "center",
        },
        ratingBig: {
            alignItems: "center",
            gap: 6,
        },
        ratingBigNum: {
            fontSize: 36,
            fontWeight: "900",
        },
        ratingCount: {
            fontSize: 12,
            fontWeight: "600",
        },
        reviewCard: {
            borderRadius: 16,
            borderWidth: 1,
            padding: 14,
            marginTop: 10,
        },
        reviewHeader: {
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 10,
            marginBottom: 10,
        },
        reviewAvatar: {
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: "rgba(56,174,255,0.2)",
            alignItems: "center",
            justifyContent: "center",
        },
        reviewAvatarText: {
            color: palette.oceanBlue,
            fontWeight: "800",
            fontSize: 14,
        },
        reviewNameRow: {
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: 4,
        },
        reviewName: {
            fontWeight: "700",
            fontSize: 13,
        },
        reviewTime: {
            fontSize: 11,
        },
        reviewComment: {
            fontSize: 13,
            lineHeight: 20,
        },
        reviewEmptyWrap: {
            marginTop: 14,
            padding: 18,
            borderRadius: 16,
            borderWidth: 1,
            alignItems: "center",
        },
        reviewEmptyTitle: {
            fontSize: 14,
            lineHeight: 21,
            textAlign: "center",
            fontWeight: "600",
        },
        reviewEmptyHint: {
            fontSize: 13,
            lineHeight: 19,
            textAlign: "center",
        },

        // Map
        mapShell: {
            height: 220,
            borderRadius: 18,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: palette.borderStrong,
            marginTop: 8,
            backgroundColor: palette.surface,
        },
        mapFallback: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
        },
        mapFallbackTitle: {
            fontSize: 16,
            fontWeight: "800",
        },
        mapFallbackSub: {
            fontSize: 12,
            fontWeight: "600",
        },
        mapOpenRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            marginTop: 4,
        },
        mapOpenText: {
            fontSize: 12,
            fontWeight: "700",
        },
        mapOpenHint: {
            position: "absolute",
            bottom: 10,
            right: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: palette.borderSoft,
        },
        mapOpenHintText: {
            fontSize: 11,
            fontWeight: "800",
        },
        mapNoCoords: {
            height: 180,
            borderRadius: 18,
            borderWidth: 1,
            marginTop: 8,
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
        },
        mapNoCoordsText: {
            fontSize: 13,
            fontWeight: "600",
        },
        addressCard: {
            borderRadius: 14,
            borderWidth: 1,
            padding: 12,
            marginTop: 10,
        },
        addressText: {
            flex: 1,
            fontSize: 14,
            fontWeight: "600",
            lineHeight: 20,
        },
        coordsText: {
            fontSize: 10,
            marginTop: 6,
            marginLeft: 28,
        },

        // Bottom bar
        bottomBar: {
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            paddingTop: 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
        },
        priceWrapBottom: {
            minWidth: 72,
            gap: 1,
        },
        bottomDismissBtn: {
            width: 44,
            height: 44,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: palette.borderSoft,
            backgroundColor: isDark
                ? "rgba(20,42,70,0.8)"
                : "rgba(255,255,255,0.9)",
        },
        priceWrap: {
            gap: 1,
        },
        priceFrom: {
            fontSize: 11,
            fontWeight: "600",
        },
        priceValue: {
            fontSize: 15,
            fontWeight: "900",
        },
        // ── Match score banner ────────────────────────────────────────────
        matchBanner: {
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            marginTop: 16,
            padding: 14,
            borderRadius: 16,
            borderWidth: 1,
        },
        matchRing: {
            width: 56,
            height: 56,
            borderRadius: 28,
            borderWidth: 2,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
        },
        matchRingNum:   { fontSize: 20, fontWeight: "900" },
        matchRingPct:   { fontSize: 11, fontWeight: "700", alignSelf: "flex-end", marginBottom: 2 },
        matchBannerLabel: { fontSize: 13, fontWeight: "800", marginBottom: 6 },
        matchBannerChips: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
        matchChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            borderWidth: 1,
        },
        matchChipText: { fontSize: 10, fontWeight: "700" },

        // ── Why we recommend ──────────────────────────────────────────────
        reasonCard: {
            flexDirection: "row",
            alignItems: "flex-start",
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderWidth: 1,
            borderRadius: 12,
        },
        reasonText: {
            flex: 1,
            fontSize: 13,
            lineHeight: 19,
            fontWeight: "500",
        },
        // ── Price range ───────────────────────────────────────────────────
        priceHeaderRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
        },
        priceTierPill: {
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            borderWidth: 1,
        },
        priceTierPillText: {
            fontSize: 11,
            fontWeight: "800",
            letterSpacing: 0.3,
        },
        priceRangeList: {
            gap: 6,
        },
        priceRangeRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 4,
        },
        priceRangeItem: {
            fontSize: 13,
            fontWeight: "600",
        },
        priceRangeValue: {
            fontSize: 13,
            fontWeight: "800",
        },
        ctaBtnWrap: {
            flex: 1,
            borderRadius: 14,
            overflow: "hidden",
        },
        ctaBtn: {
            height: 46,
            borderRadius: 14,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            shadowColor: "#2EA9FF",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.28,
            shadowRadius: 12,
            elevation: 6,
        },
        ctaBtnText: {
            color: palette.iceWhite,
            fontSize: 14,
            fontWeight: "800",
        },
    });
}
