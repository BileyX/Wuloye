/**
 * RecommendationFeedback — quick rating prompt at the bottom of PlaceDetailScreen.
 *
 * Maps each tap to a `feedback_*` interaction so the bandit and the preference
 * vector receive an explicit, high-signal training point per place:
 *
 *   Excellent     → feedback_excellent  (strong positive)
 *   Good          → feedback_good
 *   Neutral       → feedback_neutral    (no-op for the model)
 *   Poor          → feedback_poor       (strong negative)
 *   Not relevant  → feedback_not_relevant (strongest "stop showing me this")
 *
 * After a rating the UI shows a confirmation pill so the user can't double-submit.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { createInteraction } from "../api/interactionApi";
import { INTERACTION_TYPES } from "../utils/constants";
import { useAppTheme } from "../context/ThemeContext";

const OPTIONS = [
    {
        key:    "excellent",
        label:  "Excellent",
        icon:   "sparkles",
        color:  "#10B981",
        action: INTERACTION_TYPES.FEEDBACK_EXCELLENT,
    },
    {
        key:    "good",
        label:  "Good",
        icon:   "thumbs-up",
        color:  "#3B82F6",
        action: INTERACTION_TYPES.FEEDBACK_GOOD,
    },
    {
        key:    "neutral",
        label:  "Neutral",
        icon:   "remove-circle",
        color:  "#94A3B8",
        action: INTERACTION_TYPES.FEEDBACK_NEUTRAL,
    },
    {
        key:    "poor",
        label:  "Poor",
        icon:   "thumbs-down",
        color:  "#F59E0B",
        action: INTERACTION_TYPES.FEEDBACK_POOR,
    },
    {
        key:    "not_relevant",
        label:  "Not relevant",
        icon:   "close-circle",
        color:  "#EF4444",
        action: INTERACTION_TYPES.FEEDBACK_NOT_RELEVANT,
    },
];

export default function RecommendationFeedback({ place, onAfterRating }) {
    const { palette, isDark } = useAppTheme();
    const [selected, setSelected] = useState(null);
    const styles = createStyles(palette, isDark);

    function handleSelect(option) {
        if (selected) return; // single-shot per session
        const pid = place?.placeId ?? place?.id;
        if (!pid) return;
        setSelected(option.key);
        createInteraction({
            placeId:    pid,
            actionType: option.action,
            metadata: {
                source: "place_detail_feedback",
                place,
                rating: option.key,
            },
        }).catch(() => null);
        onAfterRating?.(option);
    }

    const chosen = OPTIONS.find((o) => o.key === selected) ?? null;

    return (
        <View style={styles.wrapper}>
            <Text style={styles.heading}>How was this recommendation?</Text>
            <Text style={styles.subheading}>
                Your rating shapes future suggestions across the app.
            </Text>

            {chosen ? (
                <View
                    style={[
                        styles.confirmPill,
                        {
                            backgroundColor: `${chosen.color}1A`,
                            borderColor:     `${chosen.color}55`,
                        },
                    ]}
                >
                    <Ionicons
                        name="checkmark-circle"
                        size={14}
                        color={chosen.color}
                    />
                    <Text style={[styles.confirmText, { color: chosen.color }]}>
                        Thanks — we'll use "{chosen.label}" to improve future recommendations.
                    </Text>
                </View>
            ) : (
                <View style={styles.row}>
                    {OPTIONS.map((option) => (
                        <Pressable
                            key={option.key}
                            onPress={() => handleSelect(option)}
                            style={({ pressed }) => [
                                styles.chip,
                                { borderColor: palette.borderSoft },
                                pressed && {
                                    backgroundColor: `${option.color}15`,
                                    borderColor:     `${option.color}55`,
                                },
                            ]}
                            hitSlop={6}
                        >
                            <Ionicons
                                name={option.icon}
                                size={13}
                                color={option.color}
                            />
                            <Text style={styles.chipLabel}>{option.label}</Text>
                        </Pressable>
                    ))}
                </View>
            )}
        </View>
    );
}

function createStyles(palette, isDark) {
    return StyleSheet.create({
        wrapper: {
            marginTop: 24,
            marginHorizontal: 16,
            padding: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderSoft,
            backgroundColor: isDark
                ? "rgba(255,255,255,0.04)"
                : "rgba(255,255,255,0.92)",
        },
        heading: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "700",
        },
        subheading: {
            marginTop: 4,
            marginBottom: 12,
            color: palette.textMuted,
            fontSize: 12,
            lineHeight: 17,
        },
        row: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
        },
        chip: {
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 999,
            borderWidth: 1,
            backgroundColor: isDark
                ? "rgba(255,255,255,0.03)"
                : "rgba(245,250,255,0.95)",
        },
        chipLabel: {
            color: palette.textSecondary,
            fontSize: 12,
            fontWeight: "600",
        },
        confirmPill: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 9,
            borderRadius: 12,
            borderWidth: 1,
        },
        confirmText: {
            flex: 1,
            fontSize: 12,
            fontWeight: "600",
        },
    });
}
