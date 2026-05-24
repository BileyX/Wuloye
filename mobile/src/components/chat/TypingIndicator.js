/**
 * TypingIndicator — three animated dots showing the assistant is responding.
 */

import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useAppTheme } from "../../context/ThemeContext";

function Dot({ delay, color }) {
    const anim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.delay(delay),
                Animated.timing(anim, {
                    toValue: 1,
                    duration: 380,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: true,
                }),
                Animated.timing(anim, {
                    toValue: 0,
                    duration: 380,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [anim, delay]);

    const translateY = anim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -5],
    });
    const opacity = anim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.35, 1],
    });

    return (
        <Animated.View
            style={[
                styles.dot,
                { backgroundColor: color, transform: [{ translateY }], opacity },
            ]}
        />
    );
}

export default function TypingIndicator() {
    const { palette } = useAppTheme();
    return (
        <View style={styles.row}>
            <Dot delay={0} color={palette.oceanBlue} />
            <Dot delay={140} color={palette.oceanBlue} />
            <Dot delay={280} color={palette.oceanBlue} />
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 6,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
});
