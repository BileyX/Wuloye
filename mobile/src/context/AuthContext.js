import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    GoogleAuthProvider,
    OAuthProvider,
    onAuthStateChanged,
    onIdTokenChanged,
    signInWithCredential,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as firebaseSignOut,
} from "firebase/auth";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { auth } from "../config/firebase";
import { getProfile } from "../api/profileApi";
import { unwrapApiData } from "../utils/api";
import * as authStorage from "../utils/authStorage";
import { clearFeedCache } from "../utils/feedCache";

const AuthContext = createContext(null);

/** Max time to wait for GET /profile during cold start before showing an error. */
const BOOTSTRAP_PROFILE_TIMEOUT_MS = 15_000;
/** Max time to wait for Firebase getIdToken() during cold start. */
const BOOTSTRAP_TOKEN_TIMEOUT_MS = 10_000;
/** Hard ceiling — splash must never block longer than this regardless of auth state. */
const BOOTSTRAP_SAFETY_TIMEOUT_MS = 22_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchBackendProfile(options = {}) {
    const { timeoutMs } = options;
    const envelope = await getProfile(
        typeof timeoutMs === "number" ? { timeout: timeoutMs } : undefined,
    );
    return unwrapApiData(envelope, null);
}

function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(message)), ms);
        }),
    ]);
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    /** null = no error; string = error message (network, server, etc.) */
    const [profileError, setProfileError] = useState(null);
    /** true once the initial auth + profile bootstrap completes */
    const [ready, setReady] = useState(false);

    /** Tracks in-flight / completed bootstrap per uid to avoid splash re-lock loops. */
    const bootstrapRef = useRef({ uid: null, inFlight: false, done: false });
    /** Cleared as soon as bootstrap finishes so the safety timer cannot overwrite a success. */
    const safetyTimerRef = useRef(null);

    const clearSafetyTimer = useCallback(() => {
        if (safetyTimerRef.current != null) {
            clearTimeout(safetyTimerRef.current);
            safetyTimerRef.current = null;
        }
    }, []);

    // ── Core profile loader ────────────────────────────────────────────────

    const loadProfileForUser = useCallback(
        async (firebaseUser, options = {}) => {
            const { bootstrap = false } = options;
            if (!firebaseUser) {
                setProfile(null);
                setProfileError(null);
                return;
            }

            setProfileError(null);

            try {
                // Ensure authStorage has the latest token before the API call.
                const tokenPromise = firebaseUser.getIdToken();
                const token = bootstrap
                    ? await withTimeout(
                          tokenPromise,
                          BOOTSTRAP_TOKEN_TIMEOUT_MS,
                          "Auth token timed out. Check your connection and try again.",
                      )
                    : await tokenPromise;
                await authStorage.setFirebaseToken(token);

                const fetchPromise = fetchBackendProfile(
                    bootstrap
                        ? { timeoutMs: BOOTSTRAP_PROFILE_TIMEOUT_MS }
                        : undefined,
                );
                const p = bootstrap
                    ? withTimeout(
                          fetchPromise,
                          BOOTSTRAP_PROFILE_TIMEOUT_MS + 2_000,
                          "Profile sync timed out. Check that the backend is running and reachable.",
                      )
                    : fetchPromise;

                const profileDoc = await p;
                if (profileDoc == null || typeof profileDoc !== "object") {
                    setProfile(null);
                    setProfileError(
                        "Invalid profile response from server. Try again.",
                    );
                    return;
                }
                setProfile(profileDoc);
                setProfileError(null);
            } catch (err) {
                const httpStatus = err?.response?.status;

                if (httpStatus === 401) {
                    // The backend still rejected the token even after the axios
                    // retry interceptor force-refreshed it. Token is revoked or the
                    // Firebase project is mis-configured — force sign-out so the
                    // user is returned to the Login screen cleanly.
                    if (__DEV__) {
                        console.warn("[Auth] Persistent 401 — force sign-out.");
                    }
                    bootstrapRef.current = {
                        uid: null,
                        inFlight: false,
                        done: false,
                    };
                    await authStorage.clearFirebaseToken();
                    await firebaseSignOut(auth);
                    // onAuthStateChanged will fire with null; no need to set state here.
                    return;
                }

                if (__DEV__) {
                    console.warn(
                        "[Auth] GET /api/profile failed:",
                        err?.message ?? err,
                    );
                }
                setProfile(null);
                setProfileError(
                    err?.message ??
                        "Could not load profile. Check your connection.",
                );
            }
        },
        [],
    );

    // ── Auth state listener ────────────────────────────────────────────────

    useEffect(() => {
        // Hard safety net: never leave the splash up indefinitely if Firebase
        // auth or the profile request stalls (e.g. backend not running).
        // IMPORTANT: must be cancelled once bootstrap succeeds — otherwise it
        // fires ~18s later and incorrectly sets profileError on a healthy session.
        safetyTimerRef.current = setTimeout(() => {
            safetyTimerRef.current = null;
            if (bootstrapRef.current.done) return;

            if (__DEV__) {
                console.warn(
                    "[Auth] Bootstrap safety timeout — releasing splash.",
                );
            }
            setReady(true);
            setProfileError(
                (prev) =>
                    prev ??
                    "Startup timed out. Check that the backend is running and try again.",
            );
        }, BOOTSTRAP_SAFETY_TIMEOUT_MS);

        const unsub = onAuthStateChanged(auth, async (nextUser) => {
            setUser(nextUser);

            if (!nextUser) {
                clearSafetyTimer();
                bootstrapRef.current = {
                    uid: null,
                    inFlight: false,
                    done: false,
                };
                setProfile(null);
                setProfileError(null);
                await authStorage.clearFirebaseToken();
                setReady(true);
                return;
            }

            const uid = nextUser.uid;

            // Firebase can emit duplicate auth events for the same signed-in
            // user (token refresh, hot reload). Re-blocking the splash on every
            // event leaves the app stuck on "Synchronizing profile" forever.
            if (
                bootstrapRef.current.uid === uid &&
                bootstrapRef.current.done &&
                !bootstrapRef.current.inFlight
            ) {
                clearSafetyTimer();
                loadProfileForUser(nextUser).catch(() => null);
                setReady(true);
                return;
            }
            if (
                bootstrapRef.current.uid === uid &&
                bootstrapRef.current.inFlight
            ) {
                return;
            }

            bootstrapRef.current = { uid, inFlight: true, done: false };
            setReady(false);
            let bootstrapOk = false;
            try {
                await loadProfileForUser(nextUser, { bootstrap: true });
                bootstrapOk = true;
            } finally {
                bootstrapRef.current = {
                    uid,
                    inFlight: false,
                    done: bootstrapOk,
                };
                clearSafetyTimer();
                setReady(true);
            }
        });

        return () => {
            clearSafetyTimer();
            unsub();
        };
    }, [loadProfileForUser, clearSafetyTimer]);

    // ── Keep AsyncStorage token fresh whenever Firebase rotates the JWT ───

    useEffect(() => {
        const unsub = onIdTokenChanged(auth, async (firebaseUser) => {
            if (!firebaseUser) {
                await authStorage.clearFirebaseToken();
                return;
            }
            try {
                const t = await firebaseUser.getIdToken();
                await authStorage.setFirebaseToken(t);
            } catch {
                /* non-fatal — client.js has its own retry on 401 */
            }
        });

        return unsub;
    }, []);

    // ── Actions ───────────────────────────────────────────────────────────

    /** Re-fetch backend profile (e.g. after onboarding save, or after a network error). */
    const refreshProfile = useCallback(async () => {
        const current = auth.currentUser;
        if (!current) {
            setProfile(null);
            setProfileError(null);
            return;
        }
        setProfileError(null);
        try {
            const p = await fetchBackendProfile();
            setProfile(p);
            setProfileError(null);
            // v18: a profile change (new budget / religion / activities / etc.)
            // invalidates every cached recommendation feed because all of them
            // are personalised. Without this, an onboarding edit silently
            // shows yesterday's For-You feed for the next 5 minutes.
            clearFeedCache();
        } catch (err) {
            if (__DEV__) {
                console.warn(
                    "[Auth] refreshProfile failed:",
                    err?.message ?? err,
                );
            }
            setProfileError(err?.message ?? "Could not load profile.");
        }
    }, []);

    /** Re-run the full bootstrap (used by the network-error screen). */
    const retryProfileLoad = useCallback(async () => {
        const current = auth.currentUser;
        if (!current) return;
        setProfileError(null);
        setReady(false);
        try {
            await loadProfileForUser(current, { bootstrap: true });
        } finally {
            setReady(true);
        }
    }, [loadProfileForUser]);

    const signInWithEmail = useCallback(async (email, password) => {
        await signInWithEmailAndPassword(auth, email.trim(), password);
    }, []);

    const signUpWithEmail = useCallback(async (email, password) => {
        const credential = await createUserWithEmailAndPassword(
            auth,
            email.trim(),
            password,
        );
        const token = await credential.user.getIdToken();
        await authStorage.setFirebaseToken(token);
    }, []);

    const signInWithGoogleIdToken = useCallback(async (idToken) => {
        const credential = GoogleAuthProvider.credential(idToken);
        await signInWithCredential(auth, credential);
    }, []);

    const signInWithApple = useCallback(async () => {
        const available = await AppleAuthentication.isAvailableAsync();
        if (!available) {
            throw new Error("Apple Sign-In is not available on this device.");
        }

        const rawNonce =
            Math.random().toString(36).slice(2) + Date.now().toString(36);
        const hashedNonce = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            rawNonce,
            { encoding: Crypto.CryptoEncoding.HEX },
        );

        const apple = await AppleAuthentication.signInAsync({
            requestedScopes: [
                AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
            nonce: hashedNonce,
        });

        if (!apple.identityToken) {
            throw new Error("Apple did not return an identity token.");
        }

        const provider = new OAuthProvider("apple.com");
        const credential = provider.credential({
            idToken: apple.identityToken,
            rawNonce,
        });
        await signInWithCredential(auth, credential);
    }, []);

    const clearAuth = useCallback(async () => {
        await authStorage.clearFirebaseToken();
        await firebaseSignOut(auth);
        setUser(null);
        setProfile(null);
        setProfileError(null);
    }, []);

    // ── Context value ─────────────────────────────────────────────────────

    const value = useMemo(
        () => ({
            /** Firebase user object (null when signed out) */
            user,
            /** Backend profile document (null when not loaded / new user) */
            profile,
            /** Non-null string when GET /api/profile failed for a non-auth reason */
            profileError,
            /** false while the initial auth + profile bootstrap is running */
            ready,
            refreshProfile,
            retryProfileLoad,
            signInWithEmail,
            signUpWithEmail,
            signInWithGoogleIdToken,
            signInWithApple,
            clearAuth,
        }),
        [
            user,
            profile,
            profileError,
            ready,
            refreshProfile,
            retryProfileLoad,
            signInWithEmail,
            signUpWithEmail,
            signInWithGoogleIdToken,
            signInWithApple,
            clearAuth,
        ],
    );

    return (
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error("useAuth must be used within AuthProvider");
    }
    return ctx;
}
