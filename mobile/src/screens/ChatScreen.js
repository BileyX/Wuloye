/**
 * ChatScreen — full-screen AI assistant conversation.
 *
 * Layout (bottom to top):
 *   SafeAreaView (top only)
 *   └─ LinearGradient (flex:1)
 *      ├─ Header
 *      ├─ KeyboardAvoidingView (flex:1)  ← owns all shrinkable space
 *      │  ├─ FlatList (flex:1)           ← messages + typing indicator
 *      │  ├─ Error bar
 *      │  ├─ Starter chips (conditional)
 *      │  └─ Input bar + SafeAreaView bottom inset
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    FlatList,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
    Alert,
    Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import {
    sendChatMessage,
    fetchChatHistory,
    clearChatHistory,
    fetchChatSuggestions,
} from "../api/chatApi";
import ChatBubble from "../components/chat/ChatBubble";
import ChatPlaceCard from "../components/chat/ChatPlaceCard";
import TypingIndicator from "../components/chat/TypingIndicator";
import { useAppTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import useLocation from "../hooks/useLocation";
import { getApiErrorMessage } from "../utils/api";

const WELCOME_MESSAGE = {
    id: "welcome",
    role: "assistant",
    content:
        "Hi! I'm your Wuloye assistant. Ask me anything — a quiet cafe, a workout spot, where to eat, or just say what you're in the mood for.",
    createdAt: new Date().toISOString(),
    suggestedActions: [],
    places: [],
    events: [],
};

export default function ChatScreen() {
    const navigation = useNavigation();
    const { palette, gradients, isDark } = useAppTheme();
    const { profile } = useAuth();
    const { location, requestCurrentLocation } = useLocation();
    const insets = useSafeAreaInsets();
    const listRef = useRef(null);
    const inputRef = useRef(null);
    const errorOpacity = useRef(new Animated.Value(0)).current;

    const [messages, setMessages] = useState([WELCOME_MESSAGE]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [suggestions, setSuggestions] = useState([
        "Where can I eat something good?",
        "Find an affordable cafe",
        "What should I do this evening?",
    ]);
    const [error, setError] = useState("");

    const styles = useMemo(() => createStyles(palette, isDark), [palette, isDark]);

    // ── Show / hide error bar with fade ──────────────────────────────────────
    useEffect(() => {
        if (error) {
            Animated.timing(errorOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
            const t = setTimeout(() => {
                Animated.timing(errorOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(
                    () => setError(""),
                );
            }, 4000);
            return () => clearTimeout(t);
        }
    }, [error, errorOpacity]);

    // ── Load history + suggestions on mount ──────────────────────────────────
    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const [history, sugg] = await Promise.all([
                    fetchChatHistory(40).catch(() => []),
                    fetchChatSuggestions().catch(() => []),
                ]);
                if (!active) return;
                if (history.length > 0) {
                    setMessages(history.map(hydrateHistoryItem));
                } else {
                    setMessages([{
                        ...WELCOME_MESSAGE,
                        content: profile?.username
                            ? `Hi ${profile.username}! I'm your Wuloye assistant. Ask me anything — where to eat, a quiet cafe, a gym, or what's happening tonight.`
                            : WELCOME_MESSAGE.content,
                    }]);
                }
                if (sugg.length) setSuggestions(sugg);
            } finally {
                if (active) setLoadingHistory(false);
            }
        })();
        requestCurrentLocation().catch(() => null);
        return () => { active = false; };
    }, [profile?.username, requestCurrentLocation]);

    // ── Auto-scroll to bottom on new messages ────────────────────────────────
    const scrollToEnd = useCallback((animated = true) => {
        setTimeout(() => {
            listRef.current?.scrollToEnd?.({ animated });
        }, 60);
    }, []);

    useEffect(() => {
        scrollToEnd();
    }, [messages.length, sending, scrollToEnd]);

    // ── Send message ──────────────────────────────────────────────────────────
    const send = useCallback(
        async (text) => {
            const trimmed = (text ?? "").trim();
            if (!trimmed || sending) return;

            setError("");
            setInput("");
            const optimisticId = `local-${Date.now()}`;
            const userMsg = {
                id: optimisticId,
                role: "user",
                content: trimmed,
                createdAt: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, userMsg]);
            setSending(true);

            try {
                const loc = location?.coords
                    ? { lat: location.coords.latitude, lng: location.coords.longitude }
                    : null;
                const result = await sendChatMessage({ message: trimmed, location: loc });
                const assistantMsg = {
                    id: result?.message?.id ?? `srv-${Date.now()}`,
                    role: "assistant",
                    content: result?.reply ?? "I'm here, but couldn't generate a reply just now.",
                    createdAt: result?.message?.createdAt ?? new Date().toISOString(),
                    intent: result?.intent,
                    places: result?.places ?? [],
                    events: result?.events ?? [],
                    suggestedActions: result?.suggestedActions ?? [],
                };
                setMessages((prev) => [...prev, assistantMsg]);
            } catch (err) {
                setError(getApiErrorMessage(err, "Couldn't reach the assistant. Try again."));
                setMessages((prev) =>
                    prev.map((m) => (m.id === optimisticId ? { ...m, failed: true } : m)),
                );
            } finally {
                setSending(false);
            }
        },
        [sending, location],
    );

    const handleClear = useCallback(() => {
        Alert.alert(
            "Clear conversation?",
            "This will delete your chat history.",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Clear",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await clearChatHistory();
                            setMessages([WELCOME_MESSAGE]);
                        } catch (err) {
                            setError(getApiErrorMessage(err, "Couldn't clear history."));
                        }
                    },
                },
            ],
        );
    }, []);

    // ── Navigation ────────────────────────────────────────────────────────────
    const openPlace = useCallback(
        (place) => {
            const id = place?.placeId ?? place?.id;
            if (!id) return;
            navigation.navigate("PlaceDetail", { place: { placeId: String(id), ...place } });
        },
        [navigation],
    );

    const openEvent = useCallback(
        (event) => {
            const id = event?.id ?? event?.eventId;
            if (!id) return;
            navigation.navigate("EventDetail", { event: { id: String(id), ...event } });
        },
        [navigation],
    );

    // ── Render item ───────────────────────────────────────────────────────────
    const renderItem = useCallback(
        ({ item }) => {
            const places = Array.isArray(item.places) ? item.places : [];
            const events = Array.isArray(item.events) ? item.events : [];
            const actions = Array.isArray(item.suggestedActions) ? item.suggestedActions : [];

            return (
                <ChatBubble
                    role={item.role}
                    content={item.content}
                    timestamp={item.createdAt}
                    fading={item.failed}
                >
                    {places.length > 0 && (
                        <View style={styles.cardStack}>
                            {places.map((p) => (
                                <ChatPlaceCard
                                    key={(p.placeId ?? p.id) + (p.name ?? "")}
                                    place={p}
                                    onPress={() => openPlace(p)}
                                />
                            ))}
                        </View>
                    )}
                    {events.length > 0 && (
                        <View style={styles.cardStack}>
                            {events.map((e) => (
                                <Pressable
                                    key={(e.id ?? e.eventId) + (e.title ?? "")}
                                    onPress={() => openEvent(e)}
                                    style={[
                                        styles.eventCard,
                                        {
                                            backgroundColor: isDark
                                                ? "rgba(16, 33, 58, 0.95)"
                                                : "#FFFFFF",
                                            borderColor: palette.borderSoft,
                                        },
                                    ]}
                                >
                                    <Ionicons name="calendar" size={16} color={palette.oceanBlue} />
                                    <View style={{ flex: 1 }}>
                                        <Text numberOfLines={1} style={[styles.eventTitle, { color: palette.textPrimary }]}>
                                            {e.title || e.name}
                                        </Text>
                                        {(e.dateText || e.startsAt) && (
                                            <Text style={[styles.eventMeta, { color: palette.textSecondary }]}>
                                                {e.dateText || new Date(e.startsAt).toLocaleString()}
                                            </Text>
                                        )}
                                    </View>
                                    <Ionicons name="chevron-forward" size={16} color={palette.textMuted} />
                                </Pressable>
                            ))}
                        </View>
                    )}
                    {item.role === "assistant" && actions.length > 0 && (
                        <View style={styles.chipRow}>
                            {actions.map((a) => (
                                <Pressable
                                    key={a}
                                    onPress={() => send(a)}
                                    style={[
                                        styles.chip,
                                        {
                                            backgroundColor: isDark
                                                ? "rgba(120, 199, 255, 0.14)"
                                                : "rgba(56, 174, 255, 0.10)",
                                            borderColor: palette.borderSoft,
                                        },
                                    ]}
                                >
                                    <Text style={[styles.chipText, { color: palette.oceanBlue }]}>{a}</Text>
                                </Pressable>
                            ))}
                        </View>
                    )}
                </ChatBubble>
            );
        },
        [styles, palette, isDark, openPlace, openEvent, send],
    );

    const keyExtractor = useCallback((item) => String(item.id), []);
    const showStarterChips = messages.length <= 1 && !sending && !loadingHistory && suggestions.length > 0;

    // ── Typing footer ─────────────────────────────────────────────────────────
    const ListFooter = useMemo(() => {
        if (!sending) return null;
        return (
            <View style={styles.typingRow}>
                <LinearGradient
                    colors={gradients.primaryButtonMint}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.typingAvatar}
                >
                    <Ionicons name="sparkles" size={12} color="#fff" />
                </LinearGradient>
                <View
                    style={[
                        styles.typingBubble,
                        {
                            backgroundColor: isDark ? "rgba(22, 44, 70, 0.86)" : "#FFFFFF",
                            borderColor: palette.borderSoft,
                        },
                    ]}
                >
                    <TypingIndicator />
                </View>
            </View>
        );
    }, [sending, isDark, palette, gradients, styles]);

    return (
        <SafeAreaView edges={["top"]} style={[styles.safeArea, { backgroundColor: palette.pageTop }]}>
            <LinearGradient colors={gradients.appBackground} style={styles.bg}>
                {/* ── Header ─────────────────────────────────────────────── */}
                <View style={[styles.header, { borderBottomColor: palette.borderSoft }]}>
                    <Pressable onPress={() => navigation.goBack()} hitSlop={12} style={styles.headerBtn}>
                        <Ionicons name="chevron-back" size={24} color={palette.textPrimary} />
                    </Pressable>
                    <View style={styles.headerCenter}>
                        <LinearGradient
                            colors={gradients.primaryButtonMint}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.headerAvatar}
                        >
                            <Ionicons name="sparkles" size={14} color="#fff" />
                        </LinearGradient>
                        <View>
                            <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>
                                Wuloye Assistant
                            </Text>
                            <Text style={[styles.headerSub, { color: palette.textSecondary }]}>
                                {sending ? "thinking…" : "online · personalized"}
                            </Text>
                        </View>
                    </View>
                    <Pressable onPress={handleClear} hitSlop={12} style={styles.headerBtn}>
                        <Ionicons name="trash-outline" size={20} color={palette.textSecondary} />
                    </Pressable>
                </View>

                {/* ── Keyboard-aware content ──────────────────────────────── */}
                <KeyboardAvoidingView
                    style={styles.flex}
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24}
                >
                    {/* Messages list */}
                    <FlatList
                        ref={listRef}
                        data={messages}
                        renderItem={renderItem}
                        keyExtractor={keyExtractor}
                        style={styles.flex}
                        contentContainerStyle={styles.listContent}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="interactive"
                        removeClippedSubviews={Platform.OS === "android"}
                        onContentSizeChange={() => scrollToEnd(false)}
                        ListFooterComponent={ListFooter}
                        showsVerticalScrollIndicator={false}
                        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                    />

                    {/* Error banner */}
                    {!!error && (
                        <Animated.View style={[styles.errorBar, { opacity: errorOpacity }]}>
                            <Ionicons name="warning" size={14} color="#fff" />
                            <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
                        </Animated.View>
                    )}

                    {/* Starter chips */}
                    {showStarterChips && (
                        <View style={styles.starterWrap}>
                            <Text style={[styles.starterLabel, { color: palette.textMuted }]}>
                                Try asking
                            </Text>
                            <View style={styles.starterRow}>
                                {suggestions.map((s) => (
                                    <Pressable
                                        key={s}
                                        onPress={() => send(s)}
                                        style={[
                                            styles.starterChip,
                                            {
                                                backgroundColor: isDark
                                                    ? "rgba(120, 199, 255, 0.14)"
                                                    : "#FFFFFF",
                                                borderColor: palette.borderSoft,
                                            },
                                        ]}
                                    >
                                        <Text style={[styles.starterText, { color: palette.textPrimary }]}>{s}</Text>
                                    </Pressable>
                                ))}
                            </View>
                        </View>
                    )}

                    {/* Input bar */}
                    <View
                        style={[
                            styles.inputBar,
                            {
                                backgroundColor: isDark ? "rgba(16, 33, 58, 0.97)" : "#FFFFFF",
                                borderTopColor: palette.borderSoft,
                                paddingBottom: Math.max(insets.bottom, 8),
                            },
                        ]}
                    >
                        <TextInput
                            ref={inputRef}
                            style={[
                                styles.input,
                                {
                                    color: palette.textPrimary,
                                    backgroundColor: isDark ? "rgba(12, 27, 48, 0.7)" : palette.pageTop,
                                },
                            ]}
                            placeholder="Ask me anything…"
                            placeholderTextColor={palette.textMuted}
                            value={input}
                            onChangeText={setInput}
                            multiline
                            maxLength={1000}
                            editable={!sending}
                            returnKeyType="send"
                            blurOnSubmit={false}
                            onSubmitEditing={() => {
                                if (input.trim()) send(input);
                            }}
                        />
                        <Pressable
                            onPress={() => send(input)}
                            disabled={!input.trim() || sending}
                            style={({ pressed }) => [
                                styles.sendBtn,
                                {
                                    opacity: !input.trim() || sending ? 0.45 : pressed ? 0.8 : 1,
                                },
                            ]}
                        >
                            <LinearGradient
                                colors={gradients.primaryButtonMint}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={styles.sendBtnInner}
                            >
                                {sending
                                    ? <Ionicons name="ellipsis-horizontal" size={18} color="#fff" />
                                    : <Ionicons name="arrow-up" size={20} color="#fff" />}
                            </LinearGradient>
                        </Pressable>
                    </View>
                </KeyboardAvoidingView>
            </LinearGradient>
        </SafeAreaView>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hydrateHistoryItem(raw) {
    return {
        id: raw.id ?? `srv-${Math.random().toString(36).slice(2)}`,
        role: raw.role ?? "assistant",
        content: raw.content ?? "",
        createdAt: raw.createdAt ?? new Date().toISOString(),
        intent: raw.intent,
        suggestedActions: raw.suggestedActions ?? [],
        places: [],
        events: [],
    };
}

// ── Styles ────────────────────────────────────────────────────────────────────

function createStyles(palette, isDark) {
    return StyleSheet.create({
        safeArea: { flex: 1 },
        bg: { flex: 1 },
        flex: { flex: 1 },
        header: {
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingTop: 4,
            paddingBottom: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
        },
        headerBtn: {
            width: 40,
            height: 40,
            alignItems: "center",
            justifyContent: "center",
        },
        headerCenter: {
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
        },
        headerAvatar: {
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
        },
        headerTitle: { fontSize: 16, fontWeight: "800" },
        headerSub: { fontSize: 11, marginTop: 1 },
        listContent: {
            paddingTop: 12,
            paddingBottom: 8,
            flexGrow: 1,
        },
        typingRow: {
            flexDirection: "row",
            alignItems: "flex-end",
            paddingHorizontal: 14,
            paddingBottom: 14,
        },
        typingAvatar: {
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 8,
        },
        typingBubble: {
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 18,
            borderBottomLeftRadius: 4,
            borderWidth: StyleSheet.hairlineWidth,
        },
        cardStack: { marginTop: 6, gap: 8 },
        eventCard: {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderRadius: 12,
            borderWidth: StyleSheet.hairlineWidth,
            paddingHorizontal: 12,
            paddingVertical: 10,
        },
        eventTitle: { fontSize: 14, fontWeight: "700" },
        eventMeta: { fontSize: 11, marginTop: 2 },
        chipRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 8,
        },
        chip: {
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 14,
            borderWidth: StyleSheet.hairlineWidth,
        },
        chipText: { fontSize: 12, fontWeight: "600" },
        errorBar: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: "#c0392b",
            paddingHorizontal: 14,
            paddingVertical: 9,
            marginHorizontal: 12,
            marginBottom: 6,
            borderRadius: 10,
        },
        errorText: { color: "#fff", fontSize: 12, fontWeight: "600", flex: 1 },
        starterWrap: {
            paddingHorizontal: 14,
            paddingBottom: 6,
        },
        starterLabel: {
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 8,
            fontWeight: "700",
        },
        starterRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
        },
        starterChip: {
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 18,
            borderWidth: StyleSheet.hairlineWidth,
        },
        starterText: { fontSize: 13, fontWeight: "600" },
        inputBar: {
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 8,
            paddingHorizontal: 12,
            paddingTop: 10,
            borderTopWidth: StyleSheet.hairlineWidth,
        },
        input: {
            flex: 1,
            minHeight: 44,
            maxHeight: 130,
            paddingHorizontal: 14,
            paddingTop: 11,
            paddingBottom: 11,
            borderRadius: 22,
            fontSize: 15,
            lineHeight: 20,
        },
        sendBtn: {
            width: 44,
            height: 44,
            borderRadius: 22,
            overflow: "hidden",
            marginBottom: 0,
        },
        sendBtnInner: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
        },
    });
}
