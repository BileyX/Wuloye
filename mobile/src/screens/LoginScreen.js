import { useEffect, useMemo, useRef, useState } from "react";
import {
    Animated,
    Alert,
    Image,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
    findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Google from "expo-auth-session/providers/google";
import { useAuth } from "../context/AuthContext";
import { GOOGLE_WEB_CLIENT_ID } from "../utils/constants";
import { getApiErrorMessage } from "../utils/api";
import { useAppTheme } from "../context/ThemeContext";

function AuthButton({
    label,
    icon,
    onPress,
    primary = false,
    disabled = false,
    palette,
    gradients,
    /** Avoid prop name `styles` — Hermes can throw "Property 'styles' doesn't exist". */
    styleSheet,
}) {
    if (primary) {
        return (
            <Pressable
                onPress={onPress}
                disabled={disabled}
                style={[
                    styleSheet.primaryButtonWrap,
                    disabled && styleSheet.buttonDisabled,
                ]}
            >
                <LinearGradient
                    colors={gradients.primaryButton}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styleSheet.primaryButton}
                >
                    {icon ? (
                        <Ionicons
                            name={icon}
                            size={17}
                            color={palette.iceWhite}
                        />
                    ) : null}
                    <Text
                        style={[
                            styleSheet.buttonText,
                            styleSheet.primaryButtonText,
                        ]}
                    >
                        {label}
                    </Text>
                </LinearGradient>
            </Pressable>
        );
    }

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            style={[
                styleSheet.buttonBase,
                disabled && styleSheet.buttonDisabled,
            ]}
        >
            {icon ? (
                <Ionicons name={icon} size={17} color={palette.textPrimary} />
            ) : null}
            <Text style={styleSheet.buttonText}>{label}</Text>
        </Pressable>
    );
}

function GoogleAuthBlock({
    disabled,
    onBusy,
    signInWithGoogleIdToken,
    palette,
    gradients,
    styleSheet,
}) {
    const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
        webClientId: GOOGLE_WEB_CLIENT_ID,
    });

    useEffect(() => {
        if (response?.type !== "success") {
            return;
        }
        const idToken = response.params?.id_token;
        if (!idToken) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                onBusy(true);
                await signInWithGoogleIdToken(idToken);
            } catch (error) {
                if (!cancelled) {
                    Alert.alert(
                        "Google sign-in failed",
                        getApiErrorMessage(
                            error,
                            "Could not complete sign-in.",
                        ),
                    );
                }
            } finally {
                if (!cancelled) {
                    onBusy(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [response, onBusy, signInWithGoogleIdToken]);

    return (
        <AuthButton
            label="Continue with Google"
            icon="logo-google"
            disabled={disabled || !request}
            palette={palette}
            gradients={gradients}
            styleSheet={styleSheet}
            onPress={() => {
                promptAsync().catch((error) => {
                    Alert.alert(
                        "Google",
                        getApiErrorMessage(
                            error,
                            "Could not open Google sign-in.",
                        ),
                    );
                });
            }}
        />
    );
}

export default function LoginScreen() {
    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );
    const baseScrollPadding = 32;
    const focusGap = 320;

    const {
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogleIdToken,
        signInWithApple,
    } = useAuth();

    const [isSignUp, setIsSignUp] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [keyboardOffset, setKeyboardOffset] = useState(0);
    const heroFloat = useState(new Animated.Value(0))[0];
    const scrollRef = useRef(null);
    const emailRef = useRef(null);
    const passwordRef = useRef(null);
    const confirmPasswordRef = useRef(null);

    useEffect(() => {
        Animated.loop(
            Animated.sequence([
                Animated.timing(heroFloat, {
                    toValue: 1,
                    duration: 2200,
                    useNativeDriver: true,
                }),
                Animated.timing(heroFloat, {
                    toValue: 0,
                    duration: 2200,
                    useNativeDriver: true,
                }),
            ]),
        ).start();
    }, [heroFloat]);

    useEffect(() => {
        const showEvent =
            Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
        const hideEvent =
            Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

        const showSub = Keyboard.addListener(showEvent, (event) => {
            setKeyboardOffset(event?.endCoordinates?.height ?? 0);
        });
        const hideSub = Keyboard.addListener(hideEvent, () => {
            setKeyboardOffset(0);
        });

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    function scrollToInput(ref) {
        if (!ref?.current || !scrollRef.current) {
            return;
        }
        const node = findNodeHandle(ref.current);
        const responder = scrollRef.current.getScrollResponder?.();
        if (!node || !responder?.scrollResponderScrollNativeHandleToKeyboard) {
            return;
        }
        responder.scrollResponderScrollNativeHandleToKeyboard(
            node,
            focusGap,
            true,
        );
    }

    async function submitEmailAuth() {
        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            Alert.alert("Missing fields", "Enter email and password.");
            return;
        }

        if (isSignUp) {
            if (password !== confirmPassword) {
                Alert.alert("Passwords", "Passwords do not match.");
                return;
            }
            if (password.length < 6) {
                Alert.alert(
                    "Password",
                    "Use at least 6 characters (Firebase requirement).",
                );
                return;
            }
        }

        try {
            setSubmitting(true);
            if (isSignUp) {
                await signUpWithEmail(trimmedEmail, password);
            } else {
                await signInWithEmail(trimmedEmail, password);
            }
        } catch (error) {
            const fallback = isSignUp
                ? "Could not create account."
                : "Invalid email or password.";
            Alert.alert(
                isSignUp ? "Sign up failed" : "Sign in failed",
                getApiErrorMessage(error, fallback),
            );
        } finally {
            setSubmitting(false);
        }
    }

    async function onApplePress() {
        try {
            setSubmitting(true);
            await signInWithApple();
        } catch (error) {
            const code = error?.code;
            if (code === "ERR_REQUEST_CANCELED") {
                return;
            }
            Alert.alert(
                "Apple sign-in failed",
                getApiErrorMessage(error, "Could not complete sign-in."),
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <SafeAreaView style={styles.safeArea}>
            <LinearGradient
                colors={gradients.appBackground}
                style={styles.screen}
            >
                <KeyboardAvoidingView
                    style={styles.flex}
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
                >
                    <ScrollView
                        ref={scrollRef}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode={
                            Platform.OS === "ios" ? "interactive" : "on-drag"
                        }
                        automaticallyAdjustKeyboardInsets
                        contentContainerStyle={[
                            styles.scrollContent,
                            {
                                paddingBottom:
                                    baseScrollPadding + keyboardOffset + 140,
                            },
                        ]}
                        showsVerticalScrollIndicator={false}
                    >
                        <View style={styles.heroGlowA} />
                        <View style={styles.heroGlowB} />

                        <Text style={styles.title}>
                            Welcome to{" "}
                            <Text style={styles.titleAccent}>Wuloye</Text>
                        </Text>
                        <Text style={styles.subtitle}>
                            Curated discovery for the discerning traveler.
                        </Text>

                        <Animated.View
                            style={{
                                transform: [
                                    {
                                        translateY: heroFloat.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0, -7],
                                        }),
                                    },
                                ],
                            }}
                        >
                            <LinearGradient
                                colors={
                                    isDark
                                        ? ["#132741", "#0E1D32", "#143047"]
                                        : ["#FFFFFF", "#EAF7FF", "#DFF7EA"]
                                }
                                style={styles.visualCard}
                            >
                                <Image
                                    source={require("../../assets/originaal.png")}
                                    style={styles.visualImage}
                                    resizeMode="cover"
                                />
                            </LinearGradient>
                        </Animated.View>

                        {GOOGLE_WEB_CLIENT_ID ? (
                            <GoogleAuthBlock
                                disabled={submitting}
                                onBusy={setSubmitting}
                                signInWithGoogleIdToken={
                                    signInWithGoogleIdToken
                                }
                                palette={palette}
                                gradients={gradients}
                                styleSheet={styles}
                            />
                        ) : (
                            <Text style={styles.hintText}>
                                Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to enable
                                Google sign-in.
                            </Text>
                        )}

                        {Platform.OS === "ios" ? (
                            <AuthButton
                                label="Continue with Apple"
                                icon="logo-apple"
                                disabled={submitting}
                                palette={palette}
                                gradients={gradients}
                                styleSheet={styles}
                                onPress={onApplePress}
                            />
                        ) : null}

                        <View style={styles.dividerRow}>
                            <View style={styles.divider} />
                            <Text style={styles.dividerText}>or</Text>
                            <View style={styles.divider} />
                        </View>

                        <View style={styles.emailBlock}>
                            <Text style={styles.fieldLabel}>Email</Text>
                            <TextInput
                                ref={emailRef}
                                value={email}
                                onChangeText={setEmail}
                                style={styles.fieldInput}
                                placeholder="you@example.com"
                                placeholderTextColor={palette.textMuted}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="email-address"
                                textContentType="emailAddress"
                                onFocus={() => scrollToInput(emailRef)}
                                returnKeyType="next"
                                onSubmitEditing={() => {
                                    if (isSignUp) {
                                        passwordRef.current?.focus();
                                        return;
                                    }
                                    passwordRef.current?.focus();
                                }}
                            />
                            <Text style={styles.fieldLabel}>Password</Text>
                            <TextInput
                                ref={passwordRef}
                                value={password}
                                onChangeText={setPassword}
                                style={styles.fieldInput}
                                placeholder={
                                    isSignUp
                                        ? "At least 6 characters"
                                        : "Your password"
                                }
                                placeholderTextColor={palette.textMuted}
                                secureTextEntry
                                textContentType={
                                    isSignUp ? "newPassword" : "password"
                                }
                                onFocus={() => scrollToInput(passwordRef)}
                                returnKeyType={isSignUp ? "next" : "go"}
                                onSubmitEditing={() => {
                                    if (isSignUp) {
                                        confirmPasswordRef.current?.focus();
                                        return;
                                    }
                                    submitEmailAuth();
                                }}
                            />
                            {isSignUp ? (
                                <>
                                    <Text style={styles.fieldLabel}>
                                        Confirm password
                                    </Text>
                                    <TextInput
                                        ref={confirmPasswordRef}
                                        value={confirmPassword}
                                        onChangeText={setConfirmPassword}
                                        style={styles.fieldInput}
                                        placeholder="Repeat password"
                                        placeholderTextColor={palette.textMuted}
                                        secureTextEntry
                                        textContentType="newPassword"
                                        onFocus={() =>
                                            scrollToInput(confirmPasswordRef)
                                        }
                                        returnKeyType="go"
                                        onSubmitEditing={submitEmailAuth}
                                    />
                                </>
                            ) : null}
                        </View>

                        <AuthButton
                            label={
                                submitting
                                    ? isSignUp
                                        ? "Signing up..."
                                        : "Signing in..."
                                    : isSignUp
                                      ? "Sign up"
                                      : "Sign in"
                            }
                            primary
                            disabled={submitting}
                            palette={palette}
                            gradients={gradients}
                            styleSheet={styles}
                            onPress={submitEmailAuth}
                        />

                        <Pressable
                            onPress={() => {
                                setIsSignUp((v) => !v);
                                setConfirmPassword("");
                            }}
                            style={styles.toggleRow}
                        >
                            <Text style={styles.switchText}>
                                {isSignUp
                                    ? "Already have an account? "
                                    : "New here? "}
                                <Text style={styles.switchLink}>
                                    {isSignUp ? "Sign in" : "Create an account"}
                                </Text>
                            </Text>
                        </Pressable>

                        <View style={styles.bottomBlock}>
                            <Text style={styles.legalText}>
                                Terms of Service
                            </Text>
                            <Text style={styles.legalText}>Privacy Policy</Text>
                        </View>
                    </ScrollView>
                </KeyboardAvoidingView>
            </LinearGradient>
        </SafeAreaView>
    );
}

function createStyles(palette, isDark) {
    return StyleSheet.create({
        flex: {
            flex: 1,
        },
        scrollContent: {
            paddingHorizontal: 22,
            paddingTop: 18,
        },
        hintText: {
            marginTop: 12,
            color: palette.textMuted,
            fontSize: 12,
            lineHeight: 18,
        },
        safeArea: {
            flex: 1,
            backgroundColor: palette.pageTop,
        },
        screen: {
            flex: 1,
        },
        heroGlowA: {
            position: "absolute",
            width: 240,
            height: 240,
            borderRadius: 120,
            backgroundColor: "#36C983",
            top: -50,
            left: -90,
            opacity: 0.22,
        },
        heroGlowB: {
            position: "absolute",
            width: 230,
            height: 230,
            borderRadius: 115,
            backgroundColor: "#33A7EF",
            bottom: 120,
            right: -120,
            opacity: 0.2,
        },
        title: {
            color: palette.textPrimary,
            fontSize: 38,
            fontWeight: "800",
            lineHeight: 46,
        },
        titleAccent: {
            color: palette.oceanBlue,
        },
        subtitle: {
            marginTop: 8,
            color: palette.textSecondary,
            fontSize: 17,
            lineHeight: 25,
        },
        visualCard: {
            marginTop: 22,
            borderRadius: 26,
            height: 170,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            overflow: "hidden",
            justifyContent: "center",
            alignItems: "center",
            shadowColor: "#2A95D8",
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.15,
            shadowRadius: 16,
            elevation: 6,
        },
        visualImage: {
            width: "86%",
            height: "86%",
            borderRadius: 20,
            transform: [{ rotate: "-7deg" }],
        },
        buttonBase: {
            marginTop: 12,
            height: 54,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
        },
        buttonDisabled: {
            opacity: 0.55,
        },
        primaryButton: {
            height: "100%",
            width: "100%",
            borderRadius: 16,
            shadowColor: "#2A9DE5",
            shadowOffset: { width: 0, height: 8 },
            shadowRadius: 16,
            shadowOpacity: 0.34,
            elevation: 6,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 8,
        },
        primaryButtonWrap: {
            marginTop: 18,
            height: 54,
            borderRadius: 16,
            overflow: "hidden",
            borderColor: "rgba(18, 115, 196, 0.55)",
            borderWidth: 1,
        },
        buttonText: {
            color: palette.textPrimary,
            fontSize: 16,
            fontWeight: "700",
        },
        primaryButtonText: {
            color: isDark ? palette.iceWhite : "#063C75",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontSize: 14,
            textShadowColor: isDark
                ? "rgba(6,14,28,0.48)"
                : "rgba(255,255,255,0.28)",
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 1,
        },
        dividerRow: {
            marginTop: 18,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
        },
        divider: {
            flex: 1,
            height: 1,
            backgroundColor: palette.borderStrong,
        },
        dividerText: {
            color: palette.textMuted,
            textTransform: "uppercase",
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 1,
        },
        emailBlock: {
            marginTop: 8,
            gap: 6,
        },
        fieldLabel: {
            marginTop: 8,
            color: palette.textMuted,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: "700",
        },
        fieldHint: {
            marginTop: 4,
            color: palette.textSecondary,
            fontSize: 12,
            lineHeight: 17,
        },
        usernameInputRow: {
            flexDirection: "row",
            alignItems: "center",
            height: 46,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            paddingHorizontal: 12,
            gap: 4,
        },
        usernameAt: {
            color: palette.textMuted,
            fontSize: 18,
            fontWeight: "700",
        },
        usernameFieldInput: {
            flex: 1,
            color: palette.textPrimary,
            fontSize: 15,
            height: "100%",
        },
        fieldInput: {
            height: 46,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            color: palette.textPrimary,
            paddingHorizontal: 12,
            fontSize: 15,
        },
        toggleRow: {
            marginTop: 16,
            alignItems: "center",
        },
        bottomBlock: {
            marginTop: 22,
            alignItems: "center",
            gap: 8,
        },
        switchText: {
            color: palette.textSecondary,
            fontSize: 15,
        },
        switchLink: {
            color: palette.emerald,
            fontWeight: "700",
            textDecorationLine: "underline",
        },
        legalText: {
            color: palette.textMuted,
            fontSize: 12,
        },
    });
}
