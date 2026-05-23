import { memo, useEffect, useMemo, useRef } from "react";
import {
    Animated,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAppTheme } from "../context/ThemeContext";
import AuthenticatedPlacePhoto from "./AuthenticatedPlacePhoto";
import { effectivePricingEnabled } from "../utils/pricingDisplay";
import { getPlaceVisualMeta } from "../utils/placeVisuals";

/**
 * Discover feed card — like · save · pass. Full actions on detail screen.
 */
function DiscoverCard({
    place,
    onPress,
    onPressIn,
    onLike,
    onSave,
    onDismiss,
    liked = false,
    saved = false,
}) {
    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );

    const entrance = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.timing(entrance, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
        }).start();
    }, [entrance]);

    const animStyle = {
        opacity: entrance,
        transform: [
            {
                translateY: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [12, 0],
                }),
            },
        ],
    };

    const typeLabel = place?.eventTopic
        ? `${String(place.eventTopic).charAt(0).toUpperCase()}${String(place.eventTopic).slice(1)}`
        : (place?.type ?? "Place");
    const nameLabel    = place?.name ?? "Recommended Place";
    const score        = place?.score ?? null;
    const distance     = place?.distance ?? "Nearby";
    const description  = place?.description ?? "";

    const showPricing = effectivePricingEnabled(place);

    // ── Price ──────────────────────────────────────────────────────────────
    const priceTier = (place?.priceLevel || "").toLowerCase();
    const priceMeta = (() => {
        switch (priceTier) {
            case "cheap":     return { icon: "cash-outline",    label: "Budget",  color: palette.emerald   ?? "#3aa776" };
            case "mid":       return { icon: "card-outline",    label: "Mid",     color: palette.oceanBlue ?? "#0a6aa8" };
            case "expensive": return { icon: "diamond-outline", label: "Premium", color: palette.dangerRed ?? "#c25a4a" };
            default:          return null;
        }
    })();

    // First entry from estimatedCost (e.g. "600–1500 ETB")
    const costText = (() => {
        const ec = place?.estimatedCost;
        if (ec && typeof ec === "object") {
            const first = Object.values(ec)[0];
            if (typeof first === "string") return first;
        }
        return null;
    })();

    // ── AI insight / LLM reason ────────────────────────────────────────────
    const llmReason = place?.reason ?? null;
    const aiInsight = llmReason ?? place?.aiInsight ?? null;

    // Denomination badge (church-type places only)
    const denomType = place?.denominationType ?? null;
    const religionMatch = place?.matches?.religion !== false;
    const denomLabel = (() => {
        if (!denomType || (place?.type || "").toLowerCase() !== "church") return null;
        switch (denomType) {
            case "orthodox":   return "Orthodox";
            case "protestant": return "Protestant";
            case "catholic":   return "Catholic";
            case "muslim":     return "Mosque";
            default:           return null;
        }
    })();
    const denomColor = (() => {
        switch (denomType) {
            case "orthodox":   return "#B5651D";
            case "protestant": return "#3B6FBF";
            case "catholic":   return "#7B2D8B";
            case "muslim":     return "#2E8B57";
            default:           return null;
        }
    })();

    const thumbPath = place?.images?.[0] ?? null;
    const visualMeta = useMemo(
        () => getPlaceVisualMeta(typeLabel, isDark),
        [typeLabel, isDark],
    );

    return (
        <Animated.View style={[styles.wrapper, animStyle]}>
            <Pressable onPress={onPress} onPressIn={onPressIn} style={styles.pressable}>
                <LinearGradient
                    colors={gradients.card}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.card}
                >
                    <View style={styles.thumbnail}>
                        <LinearGradient
                            colors={visualMeta.gradient}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={StyleSheet.absoluteFill}
                        />
                        {thumbPath ? (
                            <AuthenticatedPlacePhoto
                                relativePath={thumbPath}
                                style={styles.thumbnailImage}
                                fallbackIcon={visualMeta.icon}
                                fallbackTint={visualMeta.accent}
                            />
                        ) : (
                            <Ionicons
                                name={visualMeta.icon}
                                size={28}
                                color={visualMeta.accent}
                            />
                        )}
                        {score ? (
                            <View style={styles.scorePill}>
                                <Text style={styles.scoreText}>{score}</Text>
                            </View>
                        ) : null}
                    </View>

                    {/* ── Info ── */}
                    <View style={styles.info}>
                        {/* Type + denomination badges */}
                        <View style={styles.badgeRow}>
                            <View style={styles.typeBadge}>
                                <Text style={styles.typeBadgeText}>{typeLabel}</Text>
                            </View>
                            {denomLabel ? (
                                <View style={[styles.denomChip, { backgroundColor: `${denomColor}15`, borderColor: `${denomColor}40` }]}>
                                    <Ionicons name="shield-checkmark-outline" size={9} color={denomColor} />
                                    <Text style={[styles.denomChipText, { color: denomColor }]}>
                                        {religionMatch ? `Matched · ${denomLabel}` : denomLabel}
                                    </Text>
                                </View>
                            ) : null}
                        </View>

                        {/* Name */}
                        <Text style={styles.name} numberOfLines={1}>
                            {nameLabel}
                        </Text>

                        {/* Description */}
                        {description ? (
                            <Text
                                style={styles.description}
                                numberOfLines={1}
                            >
                                {description}
                            </Text>
                        ) : null}

                        {/* Price tier + cost row */}
                        {showPricing && priceMeta ? (
                            <View style={styles.priceRow}>
                                <View
                                    style={[
                                        styles.pricePill,
                                        {
                                            backgroundColor: priceMeta.color + "1E",
                                            borderColor:    priceMeta.color + "55",
                                        },
                                    ]}
                                >
                                    <Ionicons
                                        name={priceMeta.icon}
                                        size={9}
                                        color={priceMeta.color}
                                    />
                                    <Text
                                        style={[styles.priceLabel, { color: priceMeta.color }]}
                                    >
                                        {priceMeta.label}
                                    </Text>
                                </View>
                                {costText ? (
                                    <Text style={[styles.costText, { color: palette.textMuted }]}>
                                        {costText}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}

                        {/* Match criteria chips */}
                        {(place?.matches?.budget === true || place?.matches?.religion === true || place?.matches?.lifestyle === true) ? (
                            <View style={styles.matchChipsRow}>
                                {place.matches?.budget === true && (
                                    <View style={[styles.matchChip, { backgroundColor: "rgba(16,185,129,0.1)", borderColor: "rgba(16,185,129,0.4)" }]}>
                                        <Ionicons name="checkmark-circle" size={8} color="#059669" />
                                        <Text style={[styles.matchChipText, { color: "#059669" }]}>Budget</Text>
                                    </View>
                                )}
                                {place.matches?.religion === true && (
                                    <View style={[styles.matchChip, { backgroundColor: "rgba(139,92,246,0.1)", borderColor: "rgba(139,92,246,0.4)" }]}>
                                        <Ionicons name="checkmark-circle" size={8} color="#7C3AED" />
                                        <Text style={[styles.matchChipText, { color: "#7C3AED" }]}>Faith</Text>
                                    </View>
                                )}
                                {place.matches?.lifestyle === true && (
                                    <View style={[styles.matchChip, { backgroundColor: "rgba(249,115,22,0.1)", borderColor: "rgba(249,115,22,0.4)" }]}>
                                        <Ionicons name="flash" size={8} color="#EA580C" />
                                        <Text style={[styles.matchChipText, { color: "#EA580C" }]}>Lifestyle</Text>
                                    </View>
                                )}
                            </View>
                        ) : null}

                        {/* AI insight / LLM reason */}
                        {aiInsight ? (
                            <View style={styles.aiRow}>
                                <Ionicons
                                    name={llmReason ? "sparkles" : "flash"}
                                    size={9}
                                    color={palette.oceanBlue}
                                />
                                <Text
                                    style={styles.aiText}
                                    numberOfLines={2}
                                >
                                    {aiInsight}
                                </Text>
                            </View>
                        ) : null}

                        {/* Footer: distance + quick actions */}
                        <View style={styles.footer}>
                            <View style={styles.footerLeft}>
                                <View style={styles.distanceRow}>
                                    <Ionicons
                                        name="location-outline"
                                        size={11}
                                        color={palette.textMuted}
                                    />
                                    <Text style={styles.distanceText}>
                                        {distance}
                                    </Text>
                                </View>
                            </View>

                            {(typeof onLike === "function" ||
                                typeof onSave === "function" ||
                                typeof onDismiss === "function") && (
                                <View style={styles.feedActions}>
                                    {typeof onLike === "function" ? (
                                        <Pressable
                                            onPress={onLike}
                                            hitSlop={8}
                                            style={[
                                                styles.feedActionBtn,
                                                liked && styles.feedActionBtnLiked,
                                            ]}
                                        >
                                            <Ionicons
                                                name={liked ? "heart" : "heart-outline"}
                                                size={16}
                                                color={liked ? "#EF4444" : palette.textSecondary}
                                            />
                                        </Pressable>
                                    ) : null}
                                    {typeof onSave === "function" ? (
                                        <Pressable
                                            onPress={onSave}
                                            hitSlop={8}
                                            style={[
                                                styles.feedActionBtn,
                                                saved && styles.feedActionBtnSaved,
                                            ]}
                                        >
                                            <Ionicons
                                                name={saved ? "bookmark" : "bookmark-outline"}
                                                size={16}
                                                color={palette.deepBlue}
                                            />
                                        </Pressable>
                                    ) : null}
                                    {typeof onDismiss === "function" ? (
                                        <Pressable
                                            onPress={onDismiss}
                                            hitSlop={8}
                                            style={[
                                                styles.feedActionBtn,
                                                styles.feedActionBtnMuted,
                                            ]}
                                        >
                                            <Ionicons
                                                name="close"
                                                size={15}
                                                color={palette.textMuted}
                                            />
                                        </Pressable>
                                    ) : null}
                                </View>
                            )}
                        </View>
                    </View>
                </LinearGradient>
            </Pressable>
        </Animated.View>
    );
}

function createStyles(palette, isDark) {
    return StyleSheet.create({
        wrapper: {
            marginBottom: 12,
        },
        pressable: {},
        card: {
            borderRadius: 18,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            flexDirection: "row",
            overflow: "hidden",
            shadowColor: "#2A94D7",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: isDark ? 0.18 : 0.1,
            shadowRadius: 14,
            elevation: 4,
        },
        thumbnail: {
            width: 108,
            minHeight: 124,
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
            backgroundColor: isDark ? "rgba(20,40,60,0.5)" : "rgba(230,240,250,0.9)",
        },
        thumbnailImage: {
            ...StyleSheet.absoluteFillObject,
        },
        scorePill: {
            position: "absolute",
            bottom: 6,
            left: 4,
            right: 4,
            backgroundColor: "rgba(38,201,122,0.22)",
            borderRadius: 8,
            paddingHorizontal: 4,
            paddingVertical: 2,
            alignItems: "center",
        },
        scoreText: {
            color: palette.emerald,
            fontSize: 9,
            fontWeight: "800",
        },
        info: {
            flex: 1,
            padding: 12,
        },
        badgeRow: {
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 5,
            marginBottom: 4,
        },
        denomChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            borderWidth: 1,
            borderRadius: 9,
            paddingHorizontal: 6,
            paddingVertical: 2,
        },
        denomChipText: {
            fontSize: 9,
            fontWeight: "700",
            letterSpacing: 0.2,
        },
        typeBadge: {
            alignSelf: "flex-start",
            backgroundColor: "rgba(31,159,234,0.12)",
            borderColor: "rgba(15,124,199,0.4)",
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 7,
            paddingVertical: 2,
        },
        typeBadgeText: {
            color: palette.deepBlue,
            fontSize: 9,
            fontWeight: "700",
            letterSpacing: 0.3,
        },
        name: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "800",
            marginBottom: 2,
        },
        description: {
            color: palette.textSecondary,
            fontSize: 11,
            lineHeight: 16,
            marginBottom: 4,
        },
        priceRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
        },
        pricePill: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            borderWidth: 1,
            borderRadius: 6,
            paddingHorizontal: 5,
            paddingVertical: 2,
        },
        priceLabel: {
            fontSize: 9,
            fontWeight: "800",
            letterSpacing: 0.2,
        },
        costText: {
            fontSize: 9,
            fontWeight: "600",
        },
        matchChipsRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 4,
            marginBottom: 4,
        },
        matchChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 5,
            paddingVertical: 2,
        },
        matchChipText: {
            fontSize: 8,
            fontWeight: "700",
        },
        aiRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: "rgba(15,124,199,0.08)",
            borderRadius: 6,
            paddingHorizontal: 6,
            paddingVertical: 3,
            alignSelf: "flex-start",
            marginBottom: 6,
        },
        aiText: {
            color: palette.oceanBlue,
            fontSize: 10,
            fontWeight: "600",
            flexShrink: 1,
        },
        footer: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 6,
        },
        footerLeft: {
            flex: 1,
        },
        distanceRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
        },
        distanceText: {
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: "600",
        },
        feedActions: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
        },
        feedActionBtn: {
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isDark
                ? "rgba(22,44,70,0.9)"
                : "rgba(255,255,255,0.95)",
            borderWidth: 1,
            borderColor: palette.borderSoft,
        },
        feedActionBtnMuted: {
            opacity: 0.92,
        },
        feedActionBtnLiked: {
            backgroundColor: isDark
                ? "rgba(239,68,68,0.15)"
                : "rgba(254,226,226,0.95)",
            borderColor: "rgba(239,68,68,0.35)",
        },
        feedActionBtnSaved: {
            backgroundColor: isDark
                ? "rgba(15,124,199,0.18)"
                : "rgba(219,242,255,0.95)",
            borderColor: "rgba(15,124,199,0.40)",
        },
    });
}

export default memo(DiscoverCard);
