import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useAppTheme } from "../context/ThemeContext";

function ShimmerBlock({ style, shimmer, baseColor, highlightColor }) {
    const translateX = shimmer.interpolate({
        inputRange: [0, 1],
        outputRange: [-120, 120],
    });

    return (
        <View style={[styles.block, { backgroundColor: baseColor }, style]}>
            <Animated.View
                style={[
                    StyleSheet.absoluteFill,
                    { transform: [{ translateX }] },
                ]}
            >
                <LinearGradient
                    colors={["transparent", highlightColor, "transparent"]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFill}
                />
            </Animated.View>
        </View>
    );
}

function DiscoverRowSkeleton({ shimmer, palette, isDark }) {
    const base = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    const hi = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";

    return (
        <View style={[styles.row, { borderColor: palette.cardBorder ?? "rgba(0,0,0,0.06)" }]}>
            <ShimmerBlock
                style={styles.thumb}
                shimmer={shimmer}
                baseColor={base}
                highlightColor={hi}
            />
            <View style={styles.rowBody}>
                <ShimmerBlock style={styles.lineSm} shimmer={shimmer} baseColor={base} highlightColor={hi} />
                <ShimmerBlock style={styles.lineLg} shimmer={shimmer} baseColor={base} highlightColor={hi} />
                <ShimmerBlock style={styles.lineMd} shimmer={shimmer} baseColor={base} highlightColor={hi} />
            </View>
        </View>
    );
}

function HomeCardSkeleton({ shimmer, palette, isDark }) {
    const base = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    const hi = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";

    return (
        <View style={[styles.homeCard, { borderColor: palette.cardBorder ?? "rgba(0,0,0,0.06)" }]}>
            <ShimmerBlock style={styles.hero} shimmer={shimmer} baseColor={base} highlightColor={hi} />
            <View style={styles.homeBody}>
                <ShimmerBlock style={styles.lineSm} shimmer={shimmer} baseColor={base} highlightColor={hi} />
                <ShimmerBlock style={styles.lineLg} shimmer={shimmer} baseColor={base} highlightColor={hi} />
                <ShimmerBlock style={styles.lineMd} shimmer={shimmer} baseColor={base} highlightColor={hi} />
            </View>
        </View>
    );
}

/**
 * Skeleton placeholders while feed data loads.
 * @param {{ variant?: "discover"|"home", count?: number }} props
 */
export default function PlaceListSkeleton({ variant = "discover", count = 4 }) {
    const { palette, isDark } = useAppTheme();
    const shimmer = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(shimmer, {
                    toValue: 1,
                    duration: 900,
                    useNativeDriver: true,
                }),
                Animated.timing(shimmer, {
                    toValue: 0,
                    duration: 900,
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [shimmer]);

    const items = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
    const Row = variant === "home" ? HomeCardSkeleton : DiscoverRowSkeleton;

    return (
        <View style={styles.wrap}>
            {items.map((i) => (
                <Row key={i} shimmer={shimmer} palette={palette} isDark={isDark} />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        gap: 12,
        paddingTop: 4,
    },
    block: {
        overflow: "hidden",
        borderRadius: 8,
    },
    row: {
        flexDirection: "row",
        borderRadius: 18,
        borderWidth: 1,
        overflow: "hidden",
        minHeight: 124,
    },
    thumb: {
        width: 108,
        minHeight: 124,
    },
    rowBody: {
        flex: 1,
        padding: 12,
        gap: 8,
        justifyContent: "center",
    },
    homeCard: {
        borderRadius: 20,
        borderWidth: 1,
        overflow: "hidden",
    },
    hero: {
        width: "100%",
        aspectRatio: 16 / 10,
    },
    homeBody: {
        padding: 14,
        gap: 8,
    },
    lineSm: {
        height: 10,
        width: "28%",
    },
    lineLg: {
        height: 14,
        width: "72%",
    },
    lineMd: {
        height: 10,
        width: "90%",
    },
});
