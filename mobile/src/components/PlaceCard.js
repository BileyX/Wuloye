import { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAppTheme } from "../context/ThemeContext";
import AuthenticatedPlacePhoto from "./AuthenticatedPlacePhoto";
import { effectivePricingEnabled } from "../utils/pricingDisplay";
import { getPlaceVisualMeta } from "../utils/placeVisuals";

/**
 * Feed card — three quick actions: like · save · pass (social-style).
 * Share, directions, and deeper feedback live on PlaceDetailScreen.
 */
export default function PlaceCard({
    place,
    onPress,
    onPressIn,
    onLike,
    onSave,
    onDismiss,
    liked = false,
    saved = false,
}) {
    const hasActions =
        typeof onLike === "function" ||
        typeof onSave === "function" ||
        typeof onDismiss === "function";

    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(() => createStyles(palette, isDark), [palette, isDark]);

    const entrance = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.timing(entrance, {
            toValue: 1,
            duration: 320,
            useNativeDriver: true,
        }).start();
    }, [entrance]);

    const animatedStyle = {
        opacity: entrance,
        transform: [
            {
                translateY: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [10, 0],
                }),
            },
        ],
    };

    const showPricing  = effectivePricingEnabled(place);
    const priceTier    = (place?.priceLevel || "").toLowerCase();
    const priceTierMeta = (() => {
        switch (priceTier) {
            case "cheap":     return { label: "Budget",  color: palette.emerald   ?? "#3aa776" };
            case "mid":       return { label: "Mid",     color: palette.oceanBlue ?? "#0a6aa8" };
            case "expensive": return { label: "Premium", color: palette.dangerRed ?? "#c25a4a" };
            default:          return null;
        }
    })();
    const llmReason  = place?.reason || null;
    const overBudget = showPricing && place?.matches?.budget === false;

    // Derive numeric match score from "92% match" string
    const numericScore = useMemo(() => {
        const s = place?.score ?? "";
        const m = String(s).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }, [place?.score]);

    // Colour-code the match score
    const scoreColor = useMemo(() => {
        if (!numericScore) return palette.emerald;
        if (numericScore >= 85) return "#10B981";   // strong green
        if (numericScore >= 70) return "#3B82F6";   // blue
        return palette.textMuted;
    }, [numericScore, palette]);

    const budgetMatch    = place?.matches?.budget   === true || place?.budgetFit === true;
    const religionMatch  = place?.matches?.religion === true;
    const lifestyleMatch = place?.matches?.lifestyle === true;

    // Denomination badge (only for church-type places)
    const denomType = place?.denominationType ?? null;
    const denomLabel = (() => {
        if (!denomType || place?.type !== "church") return null;
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
            case "orthodox":   return "#B5651D"; // golden-brown
            case "protestant": return "#3B6FBF"; // blue
            case "catholic":   return "#7B2D8B"; // purple
            case "muslim":     return "#2E8B57";  // green
            default:           return null;
        }
    })();

    const heroImage   = place?.images?.[0] ?? null;
    const visualMeta  = useMemo(
        () => getPlaceVisualMeta(place?.type, isDark),
        [place?.type, isDark],
    );

    return (
        <Animated.View style={[styles.wrapper, animatedStyle]}>
            <Pressable onPress={onPress} onPressIn={onPressIn}>
                <LinearGradient
                    colors={gradients.card}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.card}
                >
                    <View style={styles.cardHero}>
                        <LinearGradient
                            colors={visualMeta.gradient}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={StyleSheet.absoluteFill}
                        />
                        {heroImage ? (
                            <AuthenticatedPlacePhoto
                                relativePath={heroImage}
                                style={styles.cardHeroImg}
                                fallbackIcon={visualMeta.icon}
                                fallbackTint={visualMeta.accent}
                            />
                        ) : (
                            <View style={styles.heroFallback}>
                                <Ionicons
                                    name={visualMeta.icon}
                                    size={36}
                                    color={visualMeta.accent}
                                />
                            </View>
                        )}
                    </View>
                    <View style={styles.cardInner}>
                        {/* ── Badge row: type + pricing + match score ── */}
                        <View style={styles.badgesRow}>
                            <View style={styles.badgesRowLeft}>
                                <View style={styles.typeBadge}>
                                    <Text style={styles.typeBadgeText}>
                                        {place?.type ?? "Cafe"}
                                    </Text>
                                </View>
                                {overBudget ? (
                                    <View style={[styles.priceTierBadge, { backgroundColor: "#ff4d4d1E", borderColor: "#ff4d4d55" }]}>
                                        <Ionicons name="alert-circle-outline" size={9} color="#e03030" />
                                        <Text style={[styles.priceTierBadgeText, { color: "#e03030" }]}>
                                            Above budget
                                        </Text>
                                    </View>
                                ) : showPricing && priceTierMeta ? (
                                    <View style={[styles.priceTierBadge, { backgroundColor: priceTierMeta.color + "1F", borderColor: priceTierMeta.color + "55" }]}>
                                        <Text style={[styles.priceTierBadgeText, { color: priceTierMeta.color }]}>
                                            {priceTierMeta.label}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>

                            {/* Score badge — colour-coded by confidence */}
                            <View style={[styles.scoreBadge, { backgroundColor: `${scoreColor}20`, borderColor: `${scoreColor}50` }]}>
                                {numericScore ? (
                                    <Text style={[styles.scoreText, { color: scoreColor }]}>
                                        {numericScore}% match
                                    </Text>
                                ) : (
                                    <Text style={[styles.scoreText, { color: scoreColor }]}>
                                        {place?.score ?? "Top pick"}
                                    </Text>
                                )}
                            </View>
                        </View>

                        <Text style={styles.title}>{place?.name ?? "Place name"}</Text>

                        {/* ── Denomination match chip (churches only) ── */}
                        {denomLabel ? (
                            <View style={[styles.denomChip, { backgroundColor: `${denomColor}15`, borderColor: `${denomColor}40` }]}>
                                <Ionicons name="shield-checkmark-outline" size={10} color={denomColor} />
                                <Text style={[styles.denomChipText, { color: denomColor }]}>
                                    {religionMatch ? `Matched to your ${denomLabel} preference` : denomLabel}
                                </Text>
                            </View>
                        ) : null}

                        <Text style={styles.description} numberOfLines={2}>
                            {place?.description ?? "Premium venue with modern atmosphere and strong community vibe."}
                        </Text>

                        {/* ── AI reason / insight ── */}
                        {llmReason ? (
                            <View style={styles.aiInsightRow}>
                                <Ionicons name="sparkles" size={10} color={palette.oceanBlue} />
                                <Text style={styles.aiInsightText} numberOfLines={2}>{llmReason}</Text>
                            </View>
                        ) : place?.aiInsight ? (
                            <View style={styles.aiInsightRow}>
                                <Ionicons name="flash" size={10} color={palette.oceanBlue} />
                                <Text style={styles.aiInsightText} numberOfLines={1}>{place.aiInsight}</Text>
                            </View>
                        ) : null}

                        {/* ── Match criteria chips ── */}
                        {(budgetMatch || religionMatch || lifestyleMatch) && (
                            <View style={styles.matchCriteriaRow}>
                                {budgetMatch && (
                                    <View style={[styles.matchCriteriaChip, { backgroundColor: "rgba(16,185,129,0.1)", borderColor: "rgba(16,185,129,0.35)" }]}>
                                        <Ionicons name="checkmark-circle" size={10} color="#059669" />
                                        <Text style={[styles.matchCriteriaText, { color: "#059669" }]}>Budget ✓</Text>
                                    </View>
                                )}
                                {religionMatch && (
                                    <View style={[styles.matchCriteriaChip, { backgroundColor: "rgba(139,92,246,0.1)", borderColor: "rgba(139,92,246,0.35)" }]}>
                                        <Ionicons name="checkmark-circle" size={10} color="#7C3AED" />
                                        <Text style={[styles.matchCriteriaText, { color: "#7C3AED" }]}>Faith ✓</Text>
                                    </View>
                                )}
                                {lifestyleMatch && (
                                    <View style={[styles.matchCriteriaChip, { backgroundColor: "rgba(249,115,22,0.1)", borderColor: "rgba(249,115,22,0.35)" }]}>
                                        <Ionicons name="flash" size={10} color="#EA580C" />
                                        <Text style={[styles.matchCriteriaText, { color: "#EA580C" }]}>Lifestyle ✓</Text>
                                    </View>
                                )}
                            </View>
                        )}

                        <View style={styles.footerRow}>
                            <Pressable
                                onPress={onPress}
                                style={styles.footerTapHint}
                                hitSlop={4}
                            >
                                <View style={styles.distanceRow}>
                                    <Ionicons name="location-outline" size={12} color={palette.textMuted} />
                                    <Text style={styles.distance}>{place?.distance ?? "Nearby"}</Text>
                                </View>
                                <Text style={styles.viewDetailHint}>View details</Text>
                            </Pressable>
                            {hasActions ? (
                                <View style={styles.feedActions}>
                                    {typeof onLike === "function" ? (
                                        <Pressable
                                            onPress={() => onLike()}
                                            hitSlop={10}
                                            style={[
                                                styles.feedActionBtn,
                                                liked && styles.feedActionBtnLiked,
                                            ]}
                                        >
                                            <Ionicons
                                                name={liked ? "heart" : "heart-outline"}
                                                size={18}
                                                color={liked ? "#EF4444" : palette.textSecondary}
                                            />
                                        </Pressable>
                                    ) : null}
                                    {typeof onSave === "function" ? (
                                        <Pressable
                                            onPress={() => onSave()}
                                            hitSlop={10}
                                            style={[
                                                styles.feedActionBtn,
                                                saved && styles.feedActionBtnSaved,
                                            ]}
                                        >
                                            <Ionicons
                                                name={saved ? "bookmark" : "bookmark-outline"}
                                                size={18}
                                                color={saved ? palette.deepBlue : palette.deepBlue}
                                            />
                                        </Pressable>
                                    ) : null}
                                    {typeof onDismiss === "function" ? (
                                        <Pressable
                                            onPress={() => onDismiss()}
                                            hitSlop={10}
                                            style={[styles.feedActionBtn, styles.feedActionBtnMuted]}
                                        >
                                            <Ionicons
                                                name="close"
                                                size={17}
                                                color={palette.textMuted}
                                            />
                                        </Pressable>
                                    ) : null}
                                </View>
                            ) : null}
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
            marginBottom: 14,
        },
        card: {
            borderRadius: 20,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            padding: 0,
            overflow: "hidden",
            shadowColor: "#2A94D7",
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.12,
            shadowRadius: 18,
            elevation: 5,
        },
        cardHero: {
            width: "100%",
            aspectRatio: 16 / 10,
            backgroundColor: "rgba(20,40,60,0.2)",
            overflow: "hidden",
        },
        cardHeroImg: {
            ...StyleSheet.absoluteFillObject,
        },
        heroFallback: {
            ...StyleSheet.absoluteFillObject,
            alignItems: "center",
            justifyContent: "center",
        },
        cardInner: {
            padding: 16,
        },
        badgesRow: {
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
        },
        badgesRowLeft: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
        },
        priceTierBadge: {
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 8,
            paddingVertical: 3,
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
        },
        priceTierBadgeText: {
            fontSize: 10,
            fontWeight: "800",
            letterSpacing: 0.3,
        },
        typeBadge: {
            backgroundColor: "rgba(31, 159, 234, 0.12)",
            borderColor: "rgba(15, 124, 199, 0.4)",
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 10,
            paddingVertical: 4,
        },
        typeBadgeText: {
            color: palette.deepBlue,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.3,
        },
        scoreBadge: {
            borderRadius: 999,
            borderWidth: 1,
            paddingHorizontal: 10,
            paddingVertical: 5,
        },
        scoreText: {
            fontSize: 11,
            fontWeight: "800",
        },
        title: {
            marginTop: 14,
            color: palette.textPrimary,
            fontSize: 22,
            fontWeight: "800",
        },
        description: {
            marginTop: 6,
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 19,
        },
        denomChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 7,
            paddingVertical: 3,
            alignSelf: "flex-start",
            marginBottom: 6,
        },
        denomChipText: {
            fontSize: 10,
            fontWeight: "700",
            letterSpacing: 0.2,
        },
        aiInsightRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            marginTop: 8,
            backgroundColor: "rgba(15, 124, 199, 0.08)",
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 4,
            alignSelf: "flex-start",
        },
        aiInsightText: {
            color: palette.oceanBlue,
            fontSize: 11,
            fontWeight: "600",
            flexShrink: 1,
        },
        matchCriteriaRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 8,
        },
        matchCriteriaChip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            borderWidth: 1,
        },
        matchCriteriaText: {
            fontSize: 10,
            fontWeight: "700",
        },
        footerRow: {
            marginTop: 14,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
        },
        footerTapHint: {
            flex: 1,
            gap: 2,
        },
        distanceRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
        },
        distance: {
            color: palette.textMuted,
            fontSize: 12,
            fontWeight: "600",
        },
        viewDetailHint: {
            color: palette.oceanBlue,
            fontSize: 11,
            fontWeight: "700",
            marginTop: 2,
        },
        feedActions: {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
        },
        feedActionBtn: {
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: palette.surfaceStrong,
            borderWidth: 1,
            borderColor: palette.borderSoft,
        },
        feedActionBtnMuted: {
            backgroundColor: isDark ? "rgba(30,45,60,0.5)" : "rgba(240,245,250,0.9)",
        },
        feedActionBtnLiked: {
            backgroundColor: isDark ? "rgba(239,68,68,0.15)" : "rgba(254,226,226,0.9)",
            borderColor: "rgba(239,68,68,0.35)",
        },
        feedActionBtnSaved: {
            backgroundColor: isDark ? "rgba(15,124,199,0.18)" : "rgba(219,242,255,0.95)",
            borderColor: "rgba(15,124,199,0.40)",
        },
    });
}
