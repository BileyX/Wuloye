/**
 * ChatPlaceCard — compact place card rendered inside chat replies.
 */

import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../../context/ThemeContext";
import { toPlacePhotoAbsoluteUri } from "../AuthenticatedPlacePhoto";

function formatPrice(level) {
    if (!level) return "";
    const norm = String(level).toLowerCase();
    if (norm.includes("cheap") || norm === "low") return "$";
    if (norm.includes("expens") || norm === "high") return "$$$";
    if (norm.includes("mid") || norm === "medium") return "$$";
    return "";
}

export default function ChatPlaceCard({ place, onPress }) {
    const { palette, isDark } = useAppTheme();
    if (!place) return null;

    const photoUri = toPlacePhotoAbsoluteUri(place?.images?.[0]);
    const price = formatPrice(place.priceLevel || place.priceRange);
    const rating = place.rating ? Number(place.rating).toFixed(1) : null;
    const type = place.type || place.category;
    const distance = place.distanceKm
        ? `${Number(place.distanceKm).toFixed(1)} km`
        : place.distance;

    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                styles.card,
                {
                    backgroundColor: isDark
                        ? "rgba(16, 33, 58, 0.95)"
                        : "#FFFFFF",
                    borderColor: palette.borderSoft,
                    opacity: pressed ? 0.85 : 1,
                },
            ]}
        >
            {photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.thumb} />
            ) : (
                <View
                    style={[
                        styles.thumb,
                        styles.thumbPlaceholder,
                        { backgroundColor: palette.pageMid },
                    ]}
                >
                    <Ionicons name="location" size={18} color={palette.oceanBlue} />
                </View>
            )}

            <View style={styles.body}>
                <Text
                    numberOfLines={1}
                    style={[styles.name, { color: palette.textPrimary }]}
                >
                    {place.name || "Place"}
                </Text>
                <Text
                    numberOfLines={1}
                    style={[styles.meta, { color: palette.textSecondary }]}
                >
                    {[type, distance, price].filter(Boolean).join(" · ")}
                </Text>
                {rating ? (
                    <View style={styles.ratingRow}>
                        <Ionicons name="star" size={12} color="#F5B400" />
                        <Text
                            style={[styles.ratingText, { color: palette.textMuted }]}
                        >
                            {rating}
                            {place.userRatingsTotal
                                ? ` · ${place.userRatingsTotal}`
                                : ""}
                        </Text>
                    </View>
                ) : null}
            </View>

            <Ionicons
                name="chevron-forward"
                size={18}
                color={palette.textMuted}
                style={styles.chev}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    card: {
        flexDirection: "row",
        alignItems: "center",
        borderRadius: 14,
        borderWidth: 1,
        padding: 8,
        marginBottom: 8,
    },
    thumb: {
        width: 56,
        height: 56,
        borderRadius: 10,
        marginRight: 10,
    },
    thumbPlaceholder: {
        alignItems: "center",
        justifyContent: "center",
    },
    body: { flex: 1, minWidth: 0 },
    name: { fontSize: 14, fontWeight: "700" },
    meta: { fontSize: 12, marginTop: 2 },
    ratingRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        marginTop: 3,
    },
    ratingText: { fontSize: 11, fontWeight: "600" },
    chev: { marginLeft: 6 },
});
