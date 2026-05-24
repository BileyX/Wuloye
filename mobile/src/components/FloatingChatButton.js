/**
 * FloatingChatButton — circular floating action button that opens the AI chat.
 *
 * Sits above the bottom tab bar on Home / Discover / Planner screens.
 */

import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAppTheme } from "../context/ThemeContext";

const BUTTON_SIZE = 58;
const PULSE_DURATION = 1900;

export default function FloatingChatButton({ bottom = 110, right = 18 }) {
    const navigation = useNavigation();
    const { palette, gradients, isDark } = useAppTheme();
    const pulseAnim = useRef(new Animated.Value(0)).current;
    const pressScale = useRef(new Animated.Value(1)).current;

    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: PULSE_DURATION,
                    easing: Easing.out(Easing.ease),
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 0,
                    duration: 0,
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [pulseAnim]);

    const pulseScale = pulseAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.85, 1.5],
    });
    const pulseOpacity = pulseAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.32, 0],
    });

    const handlePress = () => {
        Animated.sequence([
            Animated.timing(pressScale, {
                toValue: 0.9,
                duration: 90,
                useNativeDriver: true,
            }),
            Animated.spring(pressScale, {
                toValue: 1,
                friction: 5,
                useNativeDriver: true,
            }),
        ]).start();
        navigation.navigate("Chat");
    };

    return (
        <View
            pointerEvents="box-none"
            style={[styles.host, { bottom, right }]}
        >
            <Animated.View
                pointerEvents="none"
                style={[
                    styles.pulse,
                    {
                        backgroundColor: palette.oceanBlue,
                        transform: [{ scale: pulseScale }],
                        opacity: pulseOpacity,
                    },
                ]}
            />
            <Animated.View style={{ transform: [{ scale: pressScale }] }}>
                <Pressable
                    onPress={handlePress}
                    accessibilityRole="button"
                    accessibilityLabel="Open Wuloye AI assistant"
                    hitSlop={8}
                    style={({ pressed }) => [
                        styles.buttonShadow,
                        pressed && { opacity: 0.92 },
                    ]}
                >
                    <LinearGradient
                        colors={gradients.primaryButtonMint}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={[
                            styles.button,
                            {
                                borderColor: isDark
                                    ? "rgba(141, 208, 255, 0.45)"
                                    : "rgba(255,255,255,0.9)",
                            },
                        ]}
                    >
                        <Ionicons
                            name="sparkles"
                            size={26}
                            color="#fff"
                        />
                    </LinearGradient>
                </Pressable>
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    host: {
        position: "absolute",
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
    },
    pulse: {
        position: "absolute",
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        borderRadius: BUTTON_SIZE / 2,
    },
    buttonShadow: {
        shadowColor: "#1A62BA",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.28,
        shadowRadius: 12,
        elevation: 8,
        borderRadius: BUTTON_SIZE / 2,
    },
    button: {
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        borderRadius: BUTTON_SIZE / 2,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 2,
    },
});
