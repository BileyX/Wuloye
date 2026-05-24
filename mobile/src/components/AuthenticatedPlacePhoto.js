import { useEffect, useRef, useState } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE_URL } from "../utils/constants";

/**
 * @param {string|null|undefined} pathOrUrl — `/places/:id/photo?ref=...&w=...` or absolute URL
 * @returns {string|null}
 */
export function toPlacePhotoAbsoluteUri(pathOrUrl) {
    if (!pathOrUrl) return null;
    const s = String(pathOrUrl).trim();
    if (!s) return null;
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    const p = s.startsWith("/") ? s : `/${s}`;
    return `${API_BASE_URL}${p}`;
}

/**
 * Place thumbnail / hero image with:
 *  - Shimmer skeleton while the network image loads.
 *  - Animated cross-fade once bytes arrive (no layout shift).
 *  - Themed icon fallback when the path is missing or the request fails.
 *  - `cover` resize by default — never stretches, never crops to background.
 *
 * Props (accept either `imagePath` or `relativePath` for legacy call sites):
 *   - imagePath | relativePath  string  relative API path or absolute URL
 *   - style                     RN style applied to the wrapping View
 *   - resizeMode                "cover" | "contain"  (default "cover")
 *   - fallbackIcon              Ionicons name shown when no image (default "image-outline")
 *   - fallbackTint              colour for the fallback icon
 *   - onLoad / onError          optional callbacks
 */
export default function AuthenticatedPlacePhoto({
    imagePath,
    relativePath,
    style,
    resizeMode = "cover",
    fallbackIcon = "image-outline",
    fallbackTint = "rgba(141,208,255,0.55)",
    onLoad,
    onError,
}) {
    const path = imagePath ?? relativePath;
    const uri = toPlacePhotoAbsoluteUri(path);

    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const opacity = useRef(new Animated.Value(0)).current;
    const shimmer = useRef(new Animated.Value(0)).current;

    // Reset state if the source URI changes (recycled FlatList rows etc.).
    useEffect(() => {
        setLoaded(false);
        setFailed(false);
        opacity.setValue(0);
    }, [uri, opacity]);

    // Continuous shimmer while loading.
    useEffect(() => {
        if (loaded || failed) return undefined;
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
    }, [loaded, failed, shimmer]);

    const showFallback = !uri || failed;

    return (
        <View style={[styles.wrapper, style]}>
            {/* Skeleton / fallback layer — always rendered behind the photo so
                a slow network does not produce a blank rectangle. */}
            {!loaded || showFallback ? (
                <View style={styles.fallback}>
                    {showFallback ? (
                        <Ionicons
                            name={fallbackIcon}
                            size={28}
                            color={fallbackTint}
                        />
                    ) : (
                        <Animated.View
                            style={[
                                styles.shimmer,
                                {
                                    opacity: shimmer.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0.25, 0.6],
                                    }),
                                },
                            ]}
                        />
                    )}
                </View>
            ) : null}

            {uri && !failed ? (
                <Animated.Image
                    source={{ uri }}
                    style={[StyleSheet.absoluteFill, { opacity }]}
                    resizeMode={resizeMode}
                    onLoad={() => {
                        setLoaded(true);
                        Animated.timing(opacity, {
                            toValue: 1,
                            duration: 220,
                            useNativeDriver: true,
                        }).start();
                        onLoad?.();
                    }}
                    onError={() => {
                        setFailed(true);
                        onError?.();
                    }}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    wrapper: {
        overflow: "hidden",
        backgroundColor: "rgba(20,40,60,0.22)",
    },
    fallback: {
        ...StyleSheet.absoluteFillObject,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(20,40,60,0.18)",
    },
    shimmer: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: "rgba(141,208,255,0.18)",
    },
});
