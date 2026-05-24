/**
 * ChatBubble — single message bubble with role-aware styling.
 */

import { StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../../context/ThemeContext";

function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatBubble({ role, content, timestamp, children, fading }) {
    const { palette, gradients, isDark } = useAppTheme();
    const isUser = role === "user";

    return (
        <View
            style={[
                styles.row,
                isUser ? styles.rowRight : styles.rowLeft,
                fading && { opacity: 0.55 },
            ]}
        >
            {!isUser && (
                <LinearGradient
                    colors={gradients.primaryButtonMint}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.avatar}
                >
                    <Ionicons name="sparkles" size={14} color="#fff" />
                </LinearGradient>
            )}

            <View style={styles.bubbleWrap}>
                {isUser ? (
                    <LinearGradient
                        colors={["#2BAFFF", "#1A62BA"]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={[styles.bubble, styles.bubbleUser]}
                    >
                        <Text style={styles.bubbleTextUser}>{content}</Text>
                    </LinearGradient>
                ) : (
                    <View
                        style={[
                            styles.bubble,
                            styles.bubbleAssistant,
                            {
                                backgroundColor: isDark
                                    ? "rgba(22, 44, 70, 0.86)"
                                    : "#FFFFFF",
                                borderColor: palette.borderSoft,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                styles.bubbleTextAssistant,
                                { color: palette.textPrimary },
                            ]}
                        >
                            {content}
                        </Text>
                    </View>
                )}

                {children ? <View style={styles.extras}>{children}</View> : null}

                {timestamp ? (
                    <Text
                        style={[
                            styles.timestamp,
                            isUser ? styles.timestampRight : styles.timestampLeft,
                            { color: palette.textMuted },
                        ]}
                    >
                        {formatTime(timestamp)}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: "row",
        alignItems: "flex-end",
        marginBottom: 14,
        paddingHorizontal: 14,
    },
    rowLeft: { justifyContent: "flex-start" },
    rowRight: { justifyContent: "flex-end" },
    avatar: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        marginRight: 8,
        marginBottom: 2,
    },
    bubbleWrap: {
        maxWidth: "82%",
    },
    bubble: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 18,
    },
    bubbleUser: {
        borderBottomRightRadius: 4,
    },
    bubbleAssistant: {
        borderBottomLeftRadius: 4,
        borderWidth: 1,
    },
    bubbleTextUser: {
        color: "#fff",
        fontSize: 15,
        lineHeight: 21,
    },
    bubbleTextAssistant: {
        fontSize: 15,
        lineHeight: 21,
    },
    extras: {
        marginTop: 10,
    },
    timestamp: {
        marginTop: 4,
        fontSize: 11,
    },
    timestampLeft: { textAlign: "left", paddingLeft: 4 },
    timestampRight: { textAlign: "right", paddingRight: 4 },
});
