import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import DateTimePicker from "@react-native-community/datetimepicker";
import Slider from "@react-native-community/slider";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Loader from "../components/Loader";
import {
    getProfile,
    updateProfile,
    checkUsernameAvailability,
} from "../api/profileApi";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage, unwrapApiData } from "../utils/api";
import { useAppTheme } from "../context/ThemeContext";

/**
 * Onboarding flow — 7 steps:
 *  0. Your username  (required — this is how the app addresses you)
 *  1. Your schedule  (wake up + bedtime + work hours)
 *  2. About you      (religion + gender — optional)
 *  3. Your week      (activities + custom)
 *  4. Daily rhythm   (meals: "Other" opens a text field per meal)
 *  5. Food & eating  (meal preferences only)
 *  6. Budget & outings (weekly ETB budget, place vibe, weekend, events)
 */
const STEPS = 7;

const USERNAME_REGEX = /^[a-z][a-z0-9_]{2,19}$/;

// ─── Static option lists ───────────────────────────────────────────────────────

const RELIGIONS = [
    "protestant",
    "orthodox",
    "catholic",
    "muslim",
    "other",
    "prefer_not_to_say",
];

const RELIGION_LABELS = {
    protestant: "Protestant",
    orthodox: "Orthodox",
    catholic: "Catholic",
    muslim: "Muslim",
    other: "Other",
    prefer_not_to_say: "Prefer not to say",
};

const GENDER_OPTIONS = ["male", "female"];

const GENDER_LABELS = {
    male: "Male",
    female: "Female",
};

const ACTIVITY_CATEGORIES = [
    {
        title: "Work & Productivity",
        icon: "briefcase-outline",
        items: ["work", "study", "coding", "meetings", "networking", "commute"],
    },
    {
        title: "Fitness & Health",
        icon: "fitness-outline",
        items: ["gym", "running", "walking", "football", "sports", "yoga"],
    },
    {
        title: "Lifestyle & Leisure",
        icon: "heart-outline",
        items: [
            "prayer",
            "meditation",
            "reading",
            "music",
            "gaming",
            "movies",
            "photography",
            "shopping",
            "coffee",
            "volunteering",
            "family",
            "social",
            "creative",
            "rest",
            "errands",
        ],
    },
];

const ALL_PREDEFINED_ACTIVITIES = ACTIVITY_CATEGORIES.flatMap((c) => c.items);

const MEAL_PREFS = [
    "home_cooking",
    "meal_prep",
    "takeout",
    "cafes",
    "quick_bites",
    "vegetarian",
    "high_protein",
    "comfort_food",
    "weekend_goals",
];

const MEAL_TYPES = ["vegetarian", "simple_snacks", "protein_rich", "other"];

const MEAL_TYPE_LABELS = {
    vegetarian: "Vegetarian",
    simple_snacks: "Simple snacks",
    protein_rich: "Protein-rich",
    other: "Other",
};

const LOCATION_PREF = ["indoor", "outdoor", "any"];
const WEEKEND_PREFS = ["indoor", "outdoor", "hiking", "other"];
const EVENT_INTERESTS = ["tech", "religious", "trainings", "social", "other"];

const EVENT_INTEREST_LABELS = {
    tech: "Tech",
    religious: "Religious",
    trainings: "Trainings",
    social: "Social",
    other: "Other",
};

/** Weekly outing budget in ETB — aligned with typical Ethiopian household context */
const BUDGET_TIER_LOW = { min: 1, max: 2000 };
const BUDGET_TIER_MEDIUM = { min: 2000, max: 10000 };
const BUDGET_STEP_LOW = 50;
const BUDGET_STEP_MEDIUM = 100;

// ─── Utility functions ─────────────────────────────────────────────────────────

function formatLabel(value) {
    if (!value || typeof value !== "string") return "";
    return value
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

function timeFromHHmm(str) {
    const d = new Date();
    d.setSeconds(0, 0);
    if (!str || !str.includes(":")) {
        d.setHours(23, 0, 0, 0);
        return d;
    }
    const [h, m] = str.split(":").map((x) => parseInt(x, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) {
        d.setHours(23, 0, 0, 0);
        return d;
    }
    d.setHours(h, m, 0, 0);
    return d;
}

function toHHmm(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function normalizeTimeInput(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    const match12 = s.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/);
    if (match12) {
        const hh = parseInt(match12[1], 10);
        const mm = parseInt(match12[2], 10);
        const period = match12[3];
        if (hh < 1 || hh > 12 || mm > 59) return null;
        const base = hh % 12;
        const hour24 = period === "pm" ? base + 12 : base;
        return `${String(hour24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!match24) return null;
    const hh = parseInt(match24[1], 10);
    const mm = parseInt(match24[2], 10);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function formatTimeLabel(raw) {
    const normalized = normalizeTimeInput(raw);
    if (!normalized) return String(raw ?? "");
    const [h, m] = normalized.split(":").map((v) => parseInt(v, 10));
    const period = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function deriveBudgetRange(amount) {
    if (amount <= BUDGET_TIER_LOW.max) return "low";
    if (amount <= BUDGET_TIER_MEDIUM.max) return "medium";
    return "high";
}

function inferBudgetTierFromAmount(amount) {
    if (typeof amount !== "number" || Number.isNaN(amount)) return "low";
    if (amount <= BUDGET_TIER_LOW.max) return "low";
    if (amount <= BUDGET_TIER_MEDIUM.max) return "medium";
    return "flexible";
}

function mealPrefLabel(id) {
    if (id === "weekend_goals") return "Weekend goals";
    return formatLabel(id);
}

function mealPrefSubtitle(id) {
    if (id === "weekend_goals")
        return "Helps tailor weekend events & light tasks for you";
    return null;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function SelectChip({ label, selected, onPress, styleSheet }) {
    return (
        <Pressable
            onPress={onPress}
            style={[styleSheet.chip, selected && styleSheet.chipSelected]}
        >
            <Text
                style={[
                    styleSheet.chipText,
                    selected && styleSheet.chipTextSelected,
                ]}
            >
                {label}
            </Text>
        </Pressable>
    );
}

function TimeTextInput({ value, onChange, placeholder, styles }) {
    const [draft, setDraft] = useState(formatTimeLabel(value));

    useEffect(() => {
        setDraft(formatTimeLabel(value));
    }, [value]);

    return (
        <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder || "8:00 AM"}
            keyboardType="numbers-and-punctuation"
            style={styles.timeInput}
            onBlur={() => {
                const n = normalizeTimeInput(draft);
                if (n) {
                    onChange(n);
                    setDraft(formatTimeLabel(n));
                } else {
                    setDraft(formatTimeLabel(value));
                }
            }}
        />
    );
}

// ─── Username availability hook ────────────────────────────────────────────────

function useUsernameAvailability(username, currentUsername) {
    const [status, setStatus] = useState(null);
    const debounceRef = useRef(null);

    useEffect(() => {
        const raw = username.trim().toLowerCase();
        if (!raw || raw === (currentUsername ?? "")) {
            setStatus(null);
            return;
        }
        if (!USERNAME_REGEX.test(raw)) {
            setStatus("invalid");
            return;
        }
        setStatus("checking");
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            try {
                const result = await checkUsernameAvailability(raw);
                setStatus(result.available ? "valid" : "taken");
            } catch {
                setStatus(null);
            }
        }, 500);
        return () => clearTimeout(debounceRef.current);
    }, [username, currentUsername]);

    return status;
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function ProfileSetupScreen({ navigation }) {
    const { palette, gradients, isDark } = useAppTheme();
    const styles = useMemo(
        () => createStyles(palette, isDark),
        [palette, isDark],
    );
    const { refreshProfile } = useAuth();
    const baseScrollPadding = 120;
    const focusGap = 360;

    const [step, setStep] = useState(0);

    // ── Step 0: Username ──────────────────────────────────────────────────────
    const [username, setUsername] = useState("");
    const [existingUsername, setExistingUsername] = useState(null);

    // ── Step 1: Schedule (wake + bed + work hours) ────────────────────────────
    const [wakeTime, setWakeTime] = useState("07:00");
    const [sleepTime, setSleepTime] = useState("23:00");
    const [wakeDate, setWakeDate] = useState(() => timeFromHHmm("07:00"));
    const [sleepDate, setSleepDate] = useState(() => timeFromHHmm("23:00"));
    const [morningStartDate, setMorningStartDate] = useState(() =>
        timeFromHHmm("08:00"),
    );
    const [morningEndDate, setMorningEndDate] = useState(() =>
        timeFromHHmm("12:00"),
    );
    const [afternoonStartDate, setAfternoonStartDate] = useState(() =>
        timeFromHHmm("13:00"),
    );
    const [afternoonEndDate, setAfternoonEndDate] = useState(() =>
        timeFromHHmm("17:00"),
    );
    const [wakePickerOpen, setWakePickerOpen] = useState(false);
    const [sleepPickerOpen, setSleepPickerOpen] = useState(false);
    const [morningStartPickerOpen, setMorningStartPickerOpen] = useState(false);
    const [morningEndPickerOpen, setMorningEndPickerOpen] = useState(false);
    const [afternoonStartPickerOpen, setAfternoonStartPickerOpen] =
        useState(false);
    const [afternoonEndPickerOpen, setAfternoonEndPickerOpen] = useState(false);
    const [workingHoursFlexible, setWorkingHoursFlexible] = useState(false);
    const [morningStart, setMorningStart] = useState("08:00");
    const [morningEnd, setMorningEnd] = useState("12:00");
    const [afternoonStart, setAfternoonStart] = useState("13:00");
    const [afternoonEnd, setAfternoonEnd] = useState("17:00");

    // ── Step 2: About you (religion + gender) ─────────────────────────────────
    const [religion, setReligion] = useState("");
    const [gender, setGender] = useState("");

    // ── Step 3: Weekly activities + custom ───────────────────────────────────
    const [weeklyActivities, setWeeklyActivities] = useState([]);
    const [customActivityInput, setCustomActivityInput] = useState("");
    const [customActivities, setCustomActivities] = useState([]);

    // ── Step 4: Daily rhythm ──────────────────────────────────────────────────
    const [breakfastTime, setBreakfastTime] = useState("08:00");
    const [breakfastDate, setBreakfastDate] = useState(() =>
        timeFromHHmm("08:00"),
    );
    const [breakfastPickerOpen, setBreakfastPickerOpen] = useState(false);
    const [breakfastType, setBreakfastType] = useState("");
    const [lunchTime, setLunchTime] = useState("12:00");
    const [lunchType, setLunchType] = useState("");
    const [dinnerTime, setDinnerTime] = useState("19:00");
    const [dinnerType, setDinnerType] = useState("");
    const [breakfastOtherDetail, setBreakfastOtherDetail] = useState("");
    const [lunchOtherDetail, setLunchOtherDetail] = useState("");
    const [dinnerOtherDetail, setDinnerOtherDetail] = useState("");
    const [lunchPickerOpen, setLunchPickerOpen] = useState(false);
    const [dinnerPickerOpen, setDinnerPickerOpen] = useState(false);
    const [lunchDate, setLunchDate] = useState(() => timeFromHHmm("12:00"));
    const [dinnerDate, setDinnerDate] = useState(() => timeFromHHmm("19:00"));

    // ── Step 5: Meal preferences only ────────────────────────────────────────
    const [mealPreferences, setMealPreferences] = useState([]);

    // ── Step 6: Budget & outings ──────────────────────────────────────────────
    const [budgetTier, setBudgetTier] = useState("low");
    const [weeklyBudget, setWeeklyBudget] = useState(1000);
    const [flexibleBudgetText, setFlexibleBudgetText] = useState("12000");
    const [locationPreference, setLocationPreference] = useState("any");
    const [weekendPreference, setWeekendPreference] = useState("");
    const [eventInterests, setEventInterests] = useState([]);

    // ── UI state ──────────────────────────────────────────────────────────────
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [keyboardOffset, setKeyboardOffset] = useState(0);
    const scrollRef = useRef(null);
    const customActivityInputRef = useRef(null);

    const usernameStatus = useUsernameAvailability(username, existingUsername);

    // ── Profile load ──────────────────────────────────────────────────────────
    useEffect(() => {
        let mounted = true;

        async function loadProfile() {
            try {
                setLoading(true);
                setError("");
                const envelope = await getProfile();
                const profile = unwrapApiData(envelope, {});
                if (!mounted) return;

                if (profile?.username) {
                    setUsername(profile.username);
                    setExistingUsername(profile.username);
                }

                if (profile?.workingHours) {
                    const wh = profile.workingHours;
                    if (wh.flexible) {
                        setWorkingHoursFlexible(true);
                    } else {
                        if (wh.morning?.start) {
                            setMorningStart(wh.morning.start);
                            setMorningStartDate(timeFromHHmm(wh.morning.start));
                        }
                        if (wh.morning?.end) {
                            setMorningEnd(wh.morning.end);
                            setMorningEndDate(timeFromHHmm(wh.morning.end));
                        }
                        if (wh.afternoon?.start) {
                            setAfternoonStart(wh.afternoon.start);
                            setAfternoonStartDate(
                                timeFromHHmm(wh.afternoon.start),
                            );
                        }
                        if (wh.afternoon?.end) {
                            setAfternoonEnd(wh.afternoon.end);
                            setAfternoonEndDate(timeFromHHmm(wh.afternoon.end));
                        }
                    }
                }
                if (profile?.sleepTime) {
                    setSleepTime(profile.sleepTime);
                    setSleepDate(timeFromHHmm(profile.sleepTime));
                }
                if (profile?.wakeTime) {
                    setWakeTime(profile.wakeTime);
                    setWakeDate(timeFromHHmm(profile.wakeTime));
                }

                if (profile?.religion) setReligion(profile.religion);
                if (profile?.gender) setGender(profile.gender);

                const savedActivities = Array.isArray(profile?.weeklyActivities)
                    ? profile.weeklyActivities
                    : Array.isArray(profile?.interests)
                      ? profile.interests.filter((x) =>
                            ALL_PREDEFINED_ACTIVITIES.includes(x),
                        )
                      : [];

                const predefined = savedActivities.filter((x) =>
                    ALL_PREDEFINED_ACTIVITIES.includes(x),
                );
                const custom = savedActivities.filter(
                    (x) => !ALL_PREDEFINED_ACTIVITIES.includes(x),
                );
                if (predefined.length > 0) setWeeklyActivities(predefined);
                if (custom.length > 0) setCustomActivities(custom);

                if (profile?.dailyRoutine) {
                    const dr = profile.dailyRoutine;
                    if (dr.morning?.breakfastTime) {
                        setBreakfastTime(dr.morning.breakfastTime);
                        setBreakfastDate(
                            timeFromHHmm(dr.morning.breakfastTime),
                        );
                    }
                    if (dr.morning?.breakfastType)
                        setBreakfastType(dr.morning.breakfastType);
                    if (typeof dr.morning?.breakfastOther === "string")
                        setBreakfastOtherDetail(dr.morning.breakfastOther);
                    if (dr.afternoon?.lunchTime) {
                        setLunchTime(dr.afternoon.lunchTime);
                        setLunchDate(timeFromHHmm(dr.afternoon.lunchTime));
                    }
                    if (dr.afternoon?.lunchType)
                        setLunchType(dr.afternoon.lunchType);
                    if (typeof dr.afternoon?.lunchOther === "string")
                        setLunchOtherDetail(dr.afternoon.lunchOther);
                    if (dr.evening?.dinnerTime) {
                        setDinnerTime(dr.evening.dinnerTime);
                        setDinnerDate(timeFromHHmm(dr.evening.dinnerTime));
                    }
                    if (dr.evening?.dinnerType)
                        setDinnerType(dr.evening.dinnerType);
                    if (typeof dr.evening?.dinnerOther === "string")
                        setDinnerOtherDetail(dr.evening.dinnerOther);
                }

                if (
                    Array.isArray(profile?.mealPreferences) &&
                    profile.mealPreferences.length > 0
                )
                    setMealPreferences(profile.mealPreferences);
                if (typeof profile?.weeklyBudget === "number") {
                    const amt = profile.weeklyBudget;
                    setWeeklyBudget(amt);
                    setFlexibleBudgetText(String(Math.round(amt)));
                    setBudgetTier(inferBudgetTierFromAmount(amt));
                }
                if (profile?.locationPreference)
                    setLocationPreference(profile.locationPreference);
                if (profile?.weekendPreference)
                    setWeekendPreference(profile.weekendPreference);
                if (Array.isArray(profile?.eventInterests))
                    setEventInterests(profile.eventInterests);
            } catch (err) {
                if (mounted)
                    setError(
                        getApiErrorMessage(err, "Unable to load profile."),
                    );
            } finally {
                if (mounted) setLoading(false);
            }
        }

        loadProfile();
        return () => {
            mounted = false;
        };
    }, []);

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

    // ── Step validation ───────────────────────────────────────────────────────
    const stepValid = useMemo(() => {
        if (step === 0) {
            const rawUser = username.trim().toLowerCase();
            if (!rawUser || rawUser.length < 3) return false;
            if (rawUser === existingUsername) return true;
            return usernameStatus === "valid";
        }
        if (step === 1) {
            return (
                !!normalizeTimeInput(sleepTime) &&
                !!normalizeTimeInput(wakeTime)
            );
        }
        if (step === 2) return true;
        if (step === 3) {
            return weeklyActivities.length + customActivities.length > 0;
        }
        if (step === 4) {
            const otherOk = (type, detail) =>
                type !== "other" || detail.trim().length >= 1;
            return (
                otherOk(breakfastType, breakfastOtherDetail) &&
                otherOk(lunchType, lunchOtherDetail) &&
                otherOk(dinnerType, dinnerOtherDetail)
            );
        }
        if (step === 5) {
            return mealPreferences.length > 0;
        }
        const budgetOk =
            budgetTier === "flexible"
                ? (() => {
                      const n = parseFloat(
                          String(flexibleBudgetText).replace(/,/g, ""),
                      );
                      return Number.isFinite(n) && n > BUDGET_TIER_MEDIUM.max;
                  })()
                : typeof weeklyBudget === "number" && weeklyBudget >= 1;
        return budgetOk && !!locationPreference;
    }, [
        step,
        username,
        existingUsername,
        usernameStatus,
        sleepTime,
        wakeTime,
        weeklyActivities,
        customActivities,
        breakfastType,
        breakfastOtherDetail,
        lunchType,
        lunchOtherDetail,
        dinnerType,
        dinnerOtherDetail,
        mealPreferences,
        weeklyBudget,
        budgetTier,
        flexibleBudgetText,
        locationPreference,
    ]);

    const canGoNext = stepValid && !loading;
    const isLastStep = step === STEPS - 1;

    // ── Helpers ───────────────────────────────────────────────────────────────
    function toggleListItem(item, setList) {
        setList((cur) =>
            cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item],
        );
    }

    function onWakeChange(_e, date) {
        if (Platform.OS === "android") setWakePickerOpen(false);
        if (date) {
            setWakeDate(date);
            setWakeTime(toHHmm(date));
        }
    }
    function onSleepChange(_e, date) {
        if (Platform.OS === "android") setSleepPickerOpen(false);
        if (date) {
            setSleepDate(date);
            setSleepTime(toHHmm(date));
        }
    }
    function onMorningStartChange(_e, date) {
        if (Platform.OS === "android") setMorningStartPickerOpen(false);
        if (date) {
            setMorningStartDate(date);
            setMorningStart(toHHmm(date));
        }
    }
    function onMorningEndChange(_e, date) {
        if (Platform.OS === "android") setMorningEndPickerOpen(false);
        if (date) {
            setMorningEndDate(date);
            setMorningEnd(toHHmm(date));
        }
    }
    function onAfternoonStartChange(_e, date) {
        if (Platform.OS === "android") setAfternoonStartPickerOpen(false);
        if (date) {
            setAfternoonStartDate(date);
            setAfternoonStart(toHHmm(date));
        }
    }
    function onAfternoonEndChange(_e, date) {
        if (Platform.OS === "android") setAfternoonEndPickerOpen(false);
        if (date) {
            setAfternoonEndDate(date);
            setAfternoonEnd(toHHmm(date));
        }
    }
    function onBreakfastChange(_e, date) {
        if (Platform.OS === "android") setBreakfastPickerOpen(false);
        if (date) {
            setBreakfastDate(date);
            setBreakfastTime(toHHmm(date));
        }
    }
    function onLunchChange(_e, date) {
        if (Platform.OS === "android") setLunchPickerOpen(false);
        if (date) {
            setLunchDate(date);
            setLunchTime(toHHmm(date));
        }
    }
    function onDinnerChange(_e, date) {
        if (Platform.OS === "android") setDinnerPickerOpen(false);
        if (date) {
            setDinnerDate(date);
            setDinnerTime(toHHmm(date));
        }
    }

    function applyBudgetTier(tier) {
        setBudgetTier(tier);
        if (tier === "low") {
            setWeeklyBudget((v) =>
                Math.min(
                    BUDGET_TIER_LOW.max,
                    Math.max(BUDGET_TIER_LOW.min, v ?? 1000),
                ),
            );
        } else if (tier === "medium") {
            setWeeklyBudget((v) => {
                const x = v ?? 5000;
                const clamped = Math.min(
                    BUDGET_TIER_MEDIUM.max,
                    Math.max(BUDGET_TIER_MEDIUM.min, x),
                );
                return x < BUDGET_TIER_MEDIUM.min ? 5000 : clamped;
            });
        } else {
            setFlexibleBudgetText(
                String(
                    Math.max(
                        BUDGET_TIER_MEDIUM.max + 1,
                        Math.round(weeklyBudget || 12000),
                    ),
                ),
            );
        }
    }

    function addCustomActivity() {
        const trimmed = customActivityInput.trim();
        if (!trimmed || customActivities.includes(trimmed)) return;
        setCustomActivities((c) => [...c, trimmed]);
        setCustomActivityInput("");
    }

    function goNext() {
        if (!canGoNext || saving) return;
        setError("");
        if (step < STEPS - 1) setStep((s) => s + 1);
    }

    function goBack() {
        setError("");
        if (step > 0) setStep((s) => s - 1);
    }

    async function saveAndContinue() {
        if (!stepValid || saving) return;
        try {
            setSaving(true);
            setError("");

            let amount =
                budgetTier === "flexible"
                    ? Math.round(
                          parseFloat(
                              String(flexibleBudgetText).replace(/,/g, ""),
                          ) || 0,
                      )
                    : Math.round(weeklyBudget);
            if (!Number.isFinite(amount) || amount < 1) amount = 1;
            if (budgetTier === "flexible" && amount <= BUDGET_TIER_MEDIUM.max) {
                amount = BUDGET_TIER_MEDIUM.max + 1;
            }

            const budgetRange = deriveBudgetRange(amount);
            const sleepOut = normalizeTimeInput(sleepTime) ?? toHHmm(sleepDate);
            const wakeOut = normalizeTimeInput(wakeTime) ?? toHHmm(wakeDate);

            const workingHours = workingHoursFlexible
                ? { flexible: true }
                : {
                      morning: { start: morningStart, end: morningEnd },
                      afternoon: { start: afternoonStart, end: afternoonEnd },
                      flexible: false,
                  };

            const allActivities = [...weeklyActivities, ...customActivities];

            const dailyRoutine = {
                morning: {
                    breakfastTime,
                    breakfastType,
                    ...(breakfastType === "other" && breakfastOtherDetail.trim()
                        ? { breakfastOther: breakfastOtherDetail.trim() }
                        : {}),
                },
                afternoon: {
                    lunchTime,
                    lunchType,
                    ...(lunchType === "other" && lunchOtherDetail.trim()
                        ? { lunchOther: lunchOtherDetail.trim() }
                        : {}),
                },
                evening: {
                    dinnerTime,
                    dinnerType,
                    ...(dinnerType === "other" && dinnerOtherDetail.trim()
                        ? { dinnerOther: dinnerOtherDetail.trim() }
                        : {}),
                },
            };

            const rawUser = username.trim().toLowerCase();

            const payload = {
                username: rawUser,
                sleepTime: sleepOut,
                wakeTime: wakeOut,
                weeklyActivities: allActivities,
                mealPreferences,
                weeklyBudget: amount,
                budgetRange,
                locationPreference,
                interests: allActivities,
                workingHours,
                religion,
                gender,
                dailyRoutine,
                weekendPreference,
                eventInterests,
            };

            await updateProfile(payload);
            await refreshProfile();
            navigation.navigate("RoutineBuilder");
        } catch (err) {
            setError(getApiErrorMessage(err, "Unable to save profile."));
        } finally {
            setSaving(false);
        }
    }

    // ── Progress ──────────────────────────────────────────────────────────────
    const progressWidth = `${((step + 1) / STEPS) * 100}%`;

    const STEP_TITLES = [
        "Choose your username",
        "Your daily schedule",
        "About you",
        "Your typical week",
        "Daily rhythm",
        "Food & eating habits",
        "Budget & outings",
    ];

    const STEP_HINTS = [
        "This is how the app will address you.",
        "Helps the AI understand your lifestyle rhythm and availability.",
        "Personalizes recommendations and filters content for you.",
        "Pick all activities that regularly shape your week.",
        "Meals and timing help the AI suggest food and breaks at the right moments.",
        "How you like to eat — so we can suggest cafés, restaurants, and home-style picks.",
        "How much you usually spend going out (Ethiopian Birr) and where you like to be.",
    ];

    const STEP_ICONS = [
        "at-outline",
        "time-outline",
        "person-outline",
        "calendar-outline",
        "restaurant-outline",
        "restaurant-outline",
        "wallet-outline",
    ];

    // ── Username status helpers ───────────────────────────────────────────────
    const usernameStatusColor =
        usernameStatus === "valid"
            ? palette.mint
            : usernameStatus === "taken" || usernameStatus === "invalid"
              ? palette.danger
              : palette.textMuted;

    const usernameStatusText =
        usernameStatus === "valid"
            ? "Available — looks good!"
            : usernameStatus === "taken"
              ? "Already taken, try another"
              : usernameStatus === "invalid"
                ? "3–20 chars, start with a letter, a–z 0–9 _"
                : usernameStatus === "checking"
                  ? "Checking…"
                  : "";

    // ── Time picker renderer ──────────────────────────────────────────────────
    function renderTimeCard(
        label,
        timeVal,
        pickerOpen,
        setPickerOpen,
        dateVal,
        onChange,
        onSetSetter,
    ) {
        return (
            <View style={styles.timeCardWrap}>
                <Text style={styles.timeCardLabel}>{label}</Text>
                {Platform.OS === "web" ? (
                    <TimeTextInput
                        value={timeVal}
                        onChange={onSetSetter}
                        placeholder="8:00 AM"
                        styles={styles}
                    />
                ) : (
                    <>
                        <Pressable
                            onPress={() => {
                                setSleepPickerOpen(false);
                                setWakePickerOpen(false);
                                setLunchPickerOpen(false);
                                setDinnerPickerOpen(false);
                                setMorningStartPickerOpen(false);
                                setMorningEndPickerOpen(false);
                                setAfternoonStartPickerOpen(false);
                                setAfternoonEndPickerOpen(false);
                                setPickerOpen(true);
                            }}
                            style={styles.timeCard}
                        >
                            <Text style={styles.timeValue}>
                                {formatTimeLabel(timeVal)}
                            </Text>
                            <Text style={styles.timeHint}>Tap to change</Text>
                        </Pressable>
                        {pickerOpen ? (
                            <DateTimePicker
                                value={dateVal}
                                mode="time"
                                is24Hour={false}
                                display={
                                    Platform.OS === "ios"
                                        ? "spinner"
                                        : "default"
                                }
                                onChange={onChange}
                            />
                        ) : null}
                        {Platform.OS === "ios" && pickerOpen ? (
                            <Pressable
                                style={styles.timeDone}
                                onPress={() => setPickerOpen(false)}
                            >
                                <Text style={styles.timeDoneText}>Done</Text>
                            </Pressable>
                        ) : null}
                    </>
                )}
            </View>
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
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
                        contentContainerStyle={[
                            styles.scrollContent,
                            {
                                paddingBottom:
                                    baseScrollPadding + keyboardOffset + 180,
                            },
                        ]}
                        showsVerticalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode={
                            Platform.OS === "ios" ? "interactive" : "on-drag"
                        }
                        automaticallyAdjustKeyboardInsets
                    >
                        {/* ── Progress Header ────────────────────────────────────── */}
                        <View style={styles.progressHeader}>
                            <View style={styles.progressMeta}>
                                <View style={styles.stepIconWrap}>
                                    <Ionicons
                                        name={STEP_ICONS[step]}
                                        size={18}
                                        color={palette.oceanBlue}
                                    />
                                </View>
                                <View>
                                    <Text style={styles.stepCounter}>
                                        Step {step + 1} of {STEPS}
                                    </Text>
                                    <Text style={styles.stepName}>
                                        {STEP_TITLES[step]}
                                    </Text>
                                </View>
                            </View>
                            <Text style={styles.stepPct}>
                                {Math.round(((step + 1) / STEPS) * 100)}%
                            </Text>
                        </View>

                        <View style={styles.progressTrack}>
                            <View
                                style={[
                                    styles.progressFill,
                                    { width: progressWidth },
                                ]}
                            />
                        </View>

                        <Text style={styles.title}>{STEP_TITLES[step]}</Text>
                        <Text style={styles.subtitle}>{STEP_HINTS[step]}</Text>

                        {loading ? <Loader /> : null}
                        {error ? (
                            <Text style={styles.errorText}>{error}</Text>
                        ) : null}

                        {/* ── STEP 0: Username ──────────────────────────────────── */}
                        {step === 0 ? (
                            <View style={styles.stepBody}>
                                <View style={styles.usernameHeroCard}>
                                    <Ionicons
                                        name="at"
                                        size={32}
                                        color={palette.oceanBlue}
                                    />
                                    <Text style={styles.usernameHeroText}>
                                        Choose a name the app should call you.
                                    </Text>
                                    <Text style={styles.usernameHeroSub}>
                                        This becomes your unique handle — used
                                        throughout the app and by the AI when
                                        addressing you.
                                    </Text>
                                </View>

                                <Text style={styles.fieldLabel}>
                                    Username *
                                </Text>
                                <Text style={styles.fieldHint}>
                                    Lowercase letters, numbers & underscores ·
                                    3–20 characters.
                                </Text>
                                <View
                                    style={[
                                        styles.usernameInputRow,
                                        usernameStatus === "valid" &&
                                            styles.usernameInputValid,
                                        (usernameStatus === "taken" ||
                                            usernameStatus === "invalid") &&
                                            styles.usernameInputError,
                                    ]}
                                >
                                    <Text style={styles.usernameAtSymbol}>
                                        @
                                    </Text>
                                    <TextInput
                                        value={username}
                                        onChangeText={(t) =>
                                            setUsername(
                                                t
                                                    .toLowerCase()
                                                    .replace(/\s/g, ""),
                                            )
                                        }
                                        placeholder="your_username"
                                        placeholderTextColor={palette.textMuted}
                                        style={styles.usernameTextInput}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        maxLength={20}
                                        autoFocus
                                    />
                                    {usernameStatus === "valid" ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={palette.mint}
                                        />
                                    ) : usernameStatus === "taken" ||
                                      usernameStatus === "invalid" ? (
                                        <Ionicons
                                            name="close-circle"
                                            size={20}
                                            color={palette.danger}
                                        />
                                    ) : usernameStatus === "checking" ? (
                                        <Ionicons
                                            name="sync-outline"
                                            size={18}
                                            color={palette.textMuted}
                                        />
                                    ) : null}
                                </View>
                                {usernameStatusText ? (
                                    <Text
                                        style={[
                                            styles.usernameStatusText,
                                            { color: usernameStatusColor },
                                        ]}
                                    >
                                        {usernameStatusText}
                                    </Text>
                                ) : null}

                                <View style={styles.usernameTipsCard}>
                                    <Text style={styles.usernameTipsTitle}>
                                        Good examples
                                    </Text>
                                    <Text style={styles.usernameTipsItem}>
                                        biruk_codes · alex99 · yonas_x
                                    </Text>
                                </View>
                            </View>
                        ) : null}

                        {/* ── STEP 1: Schedule (wake + bed + work hours) ──────────── */}
                        {step === 1 ? (
                            <View style={styles.stepBody}>
                                {/* Sleep schedule */}
                                <View style={styles.scheduleSection}>
                                    <View style={styles.scheduleSectionHeader}>
                                        <Ionicons
                                            name="moon-outline"
                                            size={16}
                                            color={palette.oceanBlue}
                                        />
                                        <Text
                                            style={styles.scheduleSectionTitle}
                                        >
                                            Sleep schedule
                                        </Text>
                                    </View>
                                    <Text style={styles.helper}>
                                        Helps the AI understand your morning
                                        energy and evening wind-down.
                                    </Text>
                                    {Platform.OS === "web" ? (
                                        <View style={styles.twoColRow}>
                                            <View style={styles.twoColField}>
                                                <Text
                                                    style={styles.timeCardLabel}
                                                >
                                                    Wake up
                                                </Text>
                                                <TimeTextInput
                                                    value={wakeTime}
                                                    onChange={(n) => {
                                                        setWakeTime(n);
                                                        setWakeDate(
                                                            timeFromHHmm(n),
                                                        );
                                                    }}
                                                    placeholder="7:00 AM"
                                                    styles={styles}
                                                />
                                            </View>
                                            <View style={styles.twoColField}>
                                                <Text
                                                    style={styles.timeCardLabel}
                                                >
                                                    Bedtime
                                                </Text>
                                                <TimeTextInput
                                                    value={sleepTime}
                                                    onChange={(n) => {
                                                        setSleepTime(n);
                                                        setSleepDate(
                                                            timeFromHHmm(n),
                                                        );
                                                    }}
                                                    placeholder="10:00 PM"
                                                    styles={styles}
                                                />
                                            </View>
                                        </View>
                                    ) : (
                                        <View style={styles.twoColRow}>
                                            {renderTimeCard(
                                                "Wake up",
                                                wakeTime,
                                                wakePickerOpen,
                                                setWakePickerOpen,
                                                wakeDate,
                                                onWakeChange,
                                                setWakeTime,
                                            )}
                                            {renderTimeCard(
                                                "Bedtime",
                                                sleepTime,
                                                sleepPickerOpen,
                                                setSleepPickerOpen,
                                                sleepDate,
                                                onSleepChange,
                                                setSleepTime,
                                            )}
                                        </View>
                                    )}
                                    {Platform.OS === "web" ? (
                                        <Text style={styles.webTimeHint}>
                                            Use 12-hour format · e.g. 7:00 AM
                                        </Text>
                                    ) : null}
                                </View>

                                {/* Work hours */}
                                <View
                                    style={[
                                        styles.scheduleSection,
                                        { marginTop: 16 },
                                    ]}
                                >
                                    <View style={styles.scheduleSectionHeader}>
                                        <Ionicons
                                            name="briefcase-outline"
                                            size={16}
                                            color={palette.oceanBlue}
                                        />
                                        <Text
                                            style={styles.scheduleSectionTitle}
                                        >
                                            Work hours
                                        </Text>
                                        <View style={styles.optionalBadge}>
                                            <Text style={styles.optionalText}>
                                                Optional
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.helper}>
                                        We avoid scheduling suggestions during
                                        your work hours.
                                    </Text>

                                    <Pressable
                                        onPress={() =>
                                            setWorkingHoursFlexible((v) => !v)
                                        }
                                        style={[
                                            styles.flexToggle,
                                            workingHoursFlexible &&
                                                styles.flexToggleOn,
                                        ]}
                                    >
                                        <Ionicons
                                            name={
                                                workingHoursFlexible
                                                    ? "checkmark-circle"
                                                    : "ellipse-outline"
                                            }
                                            size={16}
                                            color={
                                                workingHoursFlexible
                                                    ? palette.deepBlue
                                                    : palette.textMuted
                                            }
                                        />
                                        <Text
                                            style={[
                                                styles.flexToggleText,
                                                workingHoursFlexible &&
                                                    styles.flexToggleTextOn,
                                            ]}
                                        >
                                            {workingHoursFlexible
                                                ? "Flexible / I'll set this later"
                                                : "I have fixed hours — set them"}
                                        </Text>
                                    </Pressable>

                                    {!workingHoursFlexible ? (
                                        <View style={styles.workingHoursCard}>
                                            <View
                                                style={styles.workPeriodStack}
                                            >
                                                <View
                                                    style={
                                                        styles.workPeriodCard
                                                    }
                                                >
                                                    <View
                                                        style={
                                                            styles.workPeriodHeaderRow
                                                        }
                                                    >
                                                        <View
                                                            style={
                                                                styles.workPeriodTitleWrap
                                                            }
                                                        >
                                                            <Ionicons
                                                                name="sunny-outline"
                                                                size={16}
                                                                color={
                                                                    palette.oceanBlue
                                                                }
                                                            />
                                                            <Text
                                                                style={
                                                                    styles.workPeriodTitle
                                                                }
                                                            >
                                                                Morning
                                                            </Text>
                                                        </View>
                                                        <View
                                                            style={
                                                                styles.workPeriodBadge
                                                            }
                                                        >
                                                            <Text
                                                                style={
                                                                    styles.workPeriodBadgeText
                                                                }
                                                            >
                                                                Start to End
                                                            </Text>
                                                        </View>
                                                    </View>
                                                    <View
                                                        style={
                                                            styles.workPeriodRow
                                                        }
                                                    >
                                                        <View
                                                            style={
                                                                styles.workTimeSlot
                                                            }
                                                        >
                                                            {renderTimeCard(
                                                                "Start",
                                                                morningStart,
                                                                morningStartPickerOpen,
                                                                setMorningStartPickerOpen,
                                                                morningStartDate,
                                                                onMorningStartChange,
                                                                (n) => {
                                                                    setMorningStart(
                                                                        n,
                                                                    );
                                                                    setMorningStartDate(
                                                                        timeFromHHmm(
                                                                            n,
                                                                        ),
                                                                    );
                                                                },
                                                            )}
                                                        </View>
                                                        <View
                                                            style={
                                                                styles.workTimeSlot
                                                            }
                                                        >
                                                            {renderTimeCard(
                                                                "End",
                                                                morningEnd,
                                                                morningEndPickerOpen,
                                                                setMorningEndPickerOpen,
                                                                morningEndDate,
                                                                onMorningEndChange,
                                                                (n) => {
                                                                    setMorningEnd(
                                                                        n,
                                                                    );
                                                                    setMorningEndDate(
                                                                        timeFromHHmm(
                                                                            n,
                                                                        ),
                                                                    );
                                                                },
                                                            )}
                                                        </View>
                                                    </View>
                                                </View>

                                                <View
                                                    style={
                                                        styles.workPeriodSeparator
                                                    }
                                                />

                                                <View
                                                    style={[
                                                        styles.workPeriodCard,
                                                        styles.workPeriodCardAlt,
                                                    ]}
                                                >
                                                    <View
                                                        style={
                                                            styles.workPeriodHeaderRow
                                                        }
                                                    >
                                                        <View
                                                            style={
                                                                styles.workPeriodTitleWrap
                                                            }
                                                        >
                                                            <Ionicons
                                                                name="sunny"
                                                                size={16}
                                                                color={
                                                                    palette.oceanBlue
                                                                }
                                                            />
                                                            <Text
                                                                style={
                                                                    styles.workPeriodTitle
                                                                }
                                                            >
                                                                Afternoon
                                                            </Text>
                                                        </View>
                                                        <View
                                                            style={
                                                                styles.workPeriodBadge
                                                            }
                                                        >
                                                            <Text
                                                                style={
                                                                    styles.workPeriodBadgeText
                                                                }
                                                            >
                                                                Start to End
                                                            </Text>
                                                        </View>
                                                    </View>
                                                    <View
                                                        style={
                                                            styles.workPeriodRow
                                                        }
                                                    >
                                                        <View
                                                            style={
                                                                styles.workTimeSlot
                                                            }
                                                        >
                                                            {renderTimeCard(
                                                                "Start",
                                                                afternoonStart,
                                                                afternoonStartPickerOpen,
                                                                setAfternoonStartPickerOpen,
                                                                afternoonStartDate,
                                                                onAfternoonStartChange,
                                                                (n) => {
                                                                    setAfternoonStart(
                                                                        n,
                                                                    );
                                                                    setAfternoonStartDate(
                                                                        timeFromHHmm(
                                                                            n,
                                                                        ),
                                                                    );
                                                                },
                                                            )}
                                                        </View>
                                                        <View
                                                            style={
                                                                styles.workTimeSlot
                                                            }
                                                        >
                                                            {renderTimeCard(
                                                                "End",
                                                                afternoonEnd,
                                                                afternoonEndPickerOpen,
                                                                setAfternoonEndPickerOpen,
                                                                afternoonEndDate,
                                                                onAfternoonEndChange,
                                                                (n) => {
                                                                    setAfternoonEnd(
                                                                        n,
                                                                    );
                                                                    setAfternoonEndDate(
                                                                        timeFromHHmm(
                                                                            n,
                                                                        ),
                                                                    );
                                                                },
                                                            )}
                                                        </View>
                                                    </View>
                                                </View>
                                            </View>
                                            <Text style={styles.webTimeHint}>
                                                12-hour format · e.g. 8:00 AM
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>
                            </View>
                        ) : null}

                        {/* ── STEP 2: About you (religion + gender) ──────────────── */}
                        {step === 2 ? (
                            <View style={styles.stepBody}>
                                <View style={styles.aiContextCard}>
                                    <Ionicons
                                        name="sparkles-outline"
                                        size={18}
                                        color={palette.oceanBlue}
                                    />
                                    <Text style={styles.aiContextText}>
                                        These fields help the AI personalize
                                        recommendations — for example, only
                                        suggesting churches or events aligned
                                        with your faith.
                                    </Text>
                                </View>

                                {/* Religion */}
                                <View style={styles.aboutSection}>
                                    <View style={styles.aboutSectionHeader}>
                                        <Text style={styles.sectionLabel}>
                                            Religion
                                        </Text>
                                        <View style={styles.optionalBadge}>
                                            <Text style={styles.optionalText}>
                                                Optional
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.helper}>
                                        Used to filter places and events to
                                        match your faith.
                                    </Text>
                                    <View style={styles.chipsWrap}>
                                        {RELIGIONS.map((r) => (
                                            <SelectChip
                                                key={r}
                                                label={RELIGION_LABELS[r]}
                                                selected={religion === r}
                                                onPress={() =>
                                                    setReligion(
                                                        religion === r ? "" : r,
                                                    )
                                                }
                                                styleSheet={styles}
                                            />
                                        ))}
                                    </View>
                                </View>

                                {/* Gender */}
                                <View
                                    style={[
                                        styles.aboutSection,
                                        { marginTop: 24 },
                                    ]}
                                >
                                    <View style={styles.aboutSectionHeader}>
                                        <Text style={styles.sectionLabel}>
                                            Sex / Gender
                                        </Text>
                                        <View style={styles.optionalBadge}>
                                            <Text style={styles.optionalText}>
                                                Optional
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.helper}>
                                        Helps tailor activity and event
                                        recommendations.
                                    </Text>
                                    <View style={styles.chipsWrap}>
                                        {GENDER_OPTIONS.map((g) => (
                                            <SelectChip
                                                key={g}
                                                label={GENDER_LABELS[g]}
                                                selected={gender === g}
                                                onPress={() =>
                                                    setGender(
                                                        gender === g ? "" : g,
                                                    )
                                                }
                                                styleSheet={styles}
                                            />
                                        ))}
                                    </View>
                                </View>

                                <Text style={styles.skipHint}>
                                    Both fields are completely optional — tap
                                    Next to skip.
                                </Text>
                            </View>
                        ) : null}

                        {/* ── STEP 3: Your typical week ─────────────────────────── */}
                        {step === 3 ? (
                            <View style={styles.stepBody}>
                                <Text style={styles.helper}>
                                    Select everything that regularly fills your
                                    week. The AI uses this to understand your
                                    habits and lifestyle.
                                </Text>

                                {ACTIVITY_CATEGORIES.map((cat) => (
                                    <View
                                        key={cat.title}
                                        style={styles.activityCategory}
                                    >
                                        <View
                                            style={
                                                styles.activityCategoryHeader
                                            }
                                        >
                                            <Ionicons
                                                name={cat.icon}
                                                size={14}
                                                color={palette.oceanBlue}
                                            />
                                            <Text
                                                style={
                                                    styles.activityCategoryTitle
                                                }
                                            >
                                                {cat.title}
                                            </Text>
                                        </View>
                                        <View style={styles.chipsWrap}>
                                            {cat.items.map((item) => (
                                                <SelectChip
                                                    key={item}
                                                    label={formatLabel(item)}
                                                    selected={weeklyActivities.includes(
                                                        item,
                                                    )}
                                                    onPress={() =>
                                                        toggleListItem(
                                                            item,
                                                            setWeeklyActivities,
                                                        )
                                                    }
                                                    styleSheet={styles}
                                                />
                                            ))}
                                        </View>
                                    </View>
                                ))}

                                {/* Custom activity */}
                                <View style={styles.customActivitySection}>
                                    <View style={styles.aboutSectionHeader}>
                                        <Text style={styles.sectionLabel}>
                                            Add custom activity
                                        </Text>
                                        <View style={styles.optionalBadge}>
                                            <Text style={styles.optionalText}>
                                                Optional
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.helper}>
                                        Add anything not listed above (e.g.
                                        church visits, swimming, journaling).
                                    </Text>
                                    <View style={styles.customInputRow}>
                                        <TextInput
                                            ref={customActivityInputRef}
                                            value={customActivityInput}
                                            onChangeText={
                                                setCustomActivityInput
                                            }
                                            placeholder="e.g. journaling"
                                            placeholderTextColor={
                                                palette.textMuted
                                            }
                                            style={styles.customInput}
                                            onSubmitEditing={addCustomActivity}
                                            onFocus={() => {
                                                setTimeout(() => {
                                                    scrollToInput(
                                                        customActivityInputRef,
                                                    );
                                                }, 80);
                                            }}
                                            returnKeyType="done"
                                            maxLength={30}
                                        />
                                        <Pressable
                                            onPress={addCustomActivity}
                                            style={[
                                                styles.customAddBtn,
                                                !customActivityInput.trim() &&
                                                    styles.customAddBtnDisabled,
                                            ]}
                                            disabled={
                                                !customActivityInput.trim()
                                            }
                                        >
                                            <Text style={styles.customAddText}>
                                                Add
                                            </Text>
                                        </Pressable>
                                    </View>
                                    {customActivities.length > 0 ? (
                                        <View
                                            style={[
                                                styles.chipsWrap,
                                                { marginTop: 10 },
                                            ]}
                                        >
                                            {customActivities.map((act) => (
                                                <Pressable
                                                    key={act}
                                                    onPress={() =>
                                                        setCustomActivities(
                                                            (c) =>
                                                                c.filter(
                                                                    (x) =>
                                                                        x !==
                                                                        act,
                                                                ),
                                                        )
                                                    }
                                                    style={[
                                                        styles.chip,
                                                        styles.chipCustom,
                                                    ]}
                                                >
                                                    <Text
                                                        style={[
                                                            styles.chipText,
                                                            styles.chipTextCustom,
                                                        ]}
                                                    >
                                                        {act}
                                                    </Text>
                                                    <Ionicons
                                                        name="close"
                                                        size={12}
                                                        color={palette.mint}
                                                        style={{
                                                            marginLeft: 4,
                                                        }}
                                                    />
                                                </Pressable>
                                            ))}
                                        </View>
                                    ) : null}
                                </View>
                            </View>
                        ) : null}

                        {/* ── STEP 4: Daily rhythm ───────────────────────────────── */}
                        {step === 4 ? (
                            <View style={styles.stepBody}>
                                <Text style={styles.helper}>
                                    Optional — share how your typical day flows
                                    so the AI can schedule suggestions at the
                                    right moments.
                                </Text>

                                {/* Morning */}
                                <View style={styles.routineSection}>
                                    <View style={styles.routineSectionHeader}>
                                        <Ionicons
                                            name="sunny-outline"
                                            size={14}
                                            color={palette.oceanBlue}
                                        />
                                        <Text
                                            style={styles.routineSectionTitle}
                                        >
                                            Morning
                                        </Text>
                                    </View>
                                    <Text style={styles.sectionLabel}>
                                        Breakfast time
                                    </Text>
                                    {Platform.OS === "web" ? (
                                        <TimeTextInput
                                            value={breakfastTime}
                                            onChange={(n) => {
                                                setBreakfastTime(n);
                                                setBreakfastDate(
                                                    timeFromHHmm(n),
                                                );
                                            }}
                                            placeholder="8:00 AM"
                                            styles={styles}
                                        />
                                    ) : (
                                        <>
                                            <Pressable
                                                onPress={() => {
                                                    setWakePickerOpen(false);
                                                    setSleepPickerOpen(false);
                                                    setLunchPickerOpen(false);
                                                    setDinnerPickerOpen(false);
                                                    setMorningStartPickerOpen(
                                                        false,
                                                    );
                                                    setMorningEndPickerOpen(
                                                        false,
                                                    );
                                                    setAfternoonStartPickerOpen(
                                                        false,
                                                    );
                                                    setAfternoonEndPickerOpen(
                                                        false,
                                                    );
                                                    setBreakfastPickerOpen(
                                                        true,
                                                    );
                                                }}
                                                style={styles.timeCard}
                                            >
                                                <Text style={styles.timeValue}>
                                                    {formatTimeLabel(
                                                        breakfastTime,
                                                    )}
                                                </Text>
                                                <Text style={styles.timeHint}>
                                                    Tap to change
                                                </Text>
                                            </Pressable>
                                            {breakfastPickerOpen ? (
                                                <DateTimePicker
                                                    value={breakfastDate}
                                                    mode="time"
                                                    is24Hour={false}
                                                    display={
                                                        Platform.OS === "ios"
                                                            ? "spinner"
                                                            : "default"
                                                    }
                                                    onChange={onBreakfastChange}
                                                />
                                            ) : null}
                                            {Platform.OS === "ios" &&
                                            breakfastPickerOpen ? (
                                                <Pressable
                                                    style={styles.timeDone}
                                                    onPress={() =>
                                                        setBreakfastPickerOpen(
                                                            false,
                                                        )
                                                    }
                                                >
                                                    <Text
                                                        style={
                                                            styles.timeDoneText
                                                        }
                                                    >
                                                        Done
                                                    </Text>
                                                </Pressable>
                                            ) : null}
                                        </>
                                    )}
                                    <Text
                                        style={[
                                            styles.sectionLabel,
                                            { marginTop: 14 },
                                        ]}
                                    >
                                        Breakfast preference
                                    </Text>
                                    <View style={styles.chipsWrap}>
                                        {MEAL_TYPES.map((t) => (
                                            <SelectChip
                                                key={t}
                                                label={MEAL_TYPE_LABELS[t]}
                                                selected={breakfastType === t}
                                                onPress={() => {
                                                    const next =
                                                        breakfastType === t
                                                            ? ""
                                                            : t;
                                                    setBreakfastType(next);
                                                    if (next !== "other")
                                                        setBreakfastOtherDetail(
                                                            "",
                                                        );
                                                }}
                                                styleSheet={styles}
                                            />
                                        ))}
                                    </View>
                                    {breakfastType === "other" ? (
                                        <View style={styles.mealOtherBlock}>
                                            <Text style={styles.fieldLabel}>
                                                Describe your breakfast
                                            </Text>
                                            <Text style={styles.fieldHint}>
                                                e.g. Shiro, eggs & injera,
                                                oatmeal…
                                            </Text>
                                            <TextInput
                                                value={breakfastOtherDetail}
                                                onChangeText={
                                                    setBreakfastOtherDetail
                                                }
                                                placeholder="What do you usually eat?"
                                                placeholderTextColor={
                                                    palette.textMuted
                                                }
                                                style={styles.fieldInput}
                                                maxLength={120}
                                            />
                                        </View>
                                    ) : null}
                                </View>

                                {/* Afternoon */}
                                <View style={styles.routineSection}>
                                    <View style={styles.routineSectionHeader}>
                                        <Ionicons
                                            name="partly-sunny-outline"
                                            size={14}
                                            color={palette.oceanBlue}
                                        />
                                        <Text
                                            style={styles.routineSectionTitle}
                                        >
                                            Afternoon
                                        </Text>
                                    </View>
                                    <Text style={styles.sectionLabel}>
                                        Lunch time
                                    </Text>
                                    {Platform.OS === "web" ? (
                                        <TimeTextInput
                                            value={lunchTime}
                                            onChange={(n) => {
                                                setLunchTime(n);
                                                setLunchDate(timeFromHHmm(n));
                                            }}
                                            placeholder="12:00 PM"
                                            styles={styles}
                                        />
                                    ) : (
                                        <>
                                            <Pressable
                                                onPress={() => {
                                                    setDinnerPickerOpen(false);
                                                    setLunchPickerOpen(true);
                                                }}
                                                style={styles.timeCard}
                                            >
                                                <Text style={styles.timeValue}>
                                                    {formatTimeLabel(lunchTime)}
                                                </Text>
                                                <Text style={styles.timeHint}>
                                                    Tap to change
                                                </Text>
                                            </Pressable>
                                            {lunchPickerOpen ? (
                                                <DateTimePicker
                                                    value={lunchDate}
                                                    mode="time"
                                                    is24Hour={false}
                                                    display={
                                                        Platform.OS === "ios"
                                                            ? "spinner"
                                                            : "default"
                                                    }
                                                    onChange={onLunchChange}
                                                />
                                            ) : null}
                                            {Platform.OS === "ios" &&
                                            lunchPickerOpen ? (
                                                <Pressable
                                                    style={styles.timeDone}
                                                    onPress={() =>
                                                        setLunchPickerOpen(
                                                            false,
                                                        )
                                                    }
                                                >
                                                    <Text
                                                        style={
                                                            styles.timeDoneText
                                                        }
                                                    >
                                                        Done
                                                    </Text>
                                                </Pressable>
                                            ) : null}
                                        </>
                                    )}
                                    <Text
                                        style={[
                                            styles.sectionLabel,
                                            { marginTop: 12 },
                                        ]}
                                    >
                                        Lunch type
                                    </Text>
                                    <View style={styles.chipsWrap}>
                                        {MEAL_TYPES.map((t) => (
                                            <SelectChip
                                                key={t}
                                                label={MEAL_TYPE_LABELS[t]}
                                                selected={lunchType === t}
                                                onPress={() => {
                                                    const next =
                                                        lunchType === t
                                                            ? ""
                                                            : t;
                                                    setLunchType(next);
                                                    if (next !== "other")
                                                        setLunchOtherDetail("");
                                                }}
                                                styleSheet={styles}
                                            />
                                        ))}
                                    </View>
                                    {lunchType === "other" ? (
                                        <View style={styles.mealOtherBlock}>
                                            <Text style={styles.fieldLabel}>
                                                Describe your lunch
                                            </Text>
                                            <Text style={styles.fieldHint}>
                                                e.g. Firfir, pasta, fasting
                                                platters…
                                            </Text>
                                            <TextInput
                                                value={lunchOtherDetail}
                                                onChangeText={
                                                    setLunchOtherDetail
                                                }
                                                placeholder="What do you usually eat?"
                                                placeholderTextColor={
                                                    palette.textMuted
                                                }
                                                style={styles.fieldInput}
                                                maxLength={120}
                                            />
                                        </View>
                                    ) : null}
                                </View>

                                {/* Evening */}
                                <View style={styles.routineSection}>
                                    <View style={styles.routineSectionHeader}>
                                        <Ionicons
                                            name="moon-outline"
                                            size={14}
                                            color={palette.oceanBlue}
                                        />
                                        <Text
                                            style={styles.routineSectionTitle}
                                        >
                                            Evening
                                        </Text>
                                    </View>
                                    <Text style={styles.sectionLabel}>
                                        Dinner time
                                    </Text>
                                    {Platform.OS === "web" ? (
                                        <TimeTextInput
                                            value={dinnerTime}
                                            onChange={(n) => {
                                                setDinnerTime(n);
                                                setDinnerDate(timeFromHHmm(n));
                                            }}
                                            placeholder="7:00 PM"
                                            styles={styles}
                                        />
                                    ) : (
                                        <>
                                            <Pressable
                                                onPress={() => {
                                                    setLunchPickerOpen(false);
                                                    setDinnerPickerOpen(true);
                                                }}
                                                style={styles.timeCard}
                                            >
                                                <Text style={styles.timeValue}>
                                                    {formatTimeLabel(
                                                        dinnerTime,
                                                    )}
                                                </Text>
                                                <Text style={styles.timeHint}>
                                                    Tap to change
                                                </Text>
                                            </Pressable>
                                            {dinnerPickerOpen ? (
                                                <DateTimePicker
                                                    value={dinnerDate}
                                                    mode="time"
                                                    is24Hour={false}
                                                    display={
                                                        Platform.OS === "ios"
                                                            ? "spinner"
                                                            : "default"
                                                    }
                                                    onChange={onDinnerChange}
                                                />
                                            ) : null}
                                            {Platform.OS === "ios" &&
                                            dinnerPickerOpen ? (
                                                <Pressable
                                                    style={styles.timeDone}
                                                    onPress={() =>
                                                        setDinnerPickerOpen(
                                                            false,
                                                        )
                                                    }
                                                >
                                                    <Text
                                                        style={
                                                            styles.timeDoneText
                                                        }
                                                    >
                                                        Done
                                                    </Text>
                                                </Pressable>
                                            ) : null}
                                        </>
                                    )}
                                    <Text
                                        style={[
                                            styles.sectionLabel,
                                            { marginTop: 12 },
                                        ]}
                                    >
                                        Dinner type
                                    </Text>
                                    <View style={styles.chipsWrap}>
                                        {MEAL_TYPES.map((t) => (
                                            <SelectChip
                                                key={t}
                                                label={MEAL_TYPE_LABELS[t]}
                                                selected={dinnerType === t}
                                                onPress={() => {
                                                    const next =
                                                        dinnerType === t
                                                            ? ""
                                                            : t;
                                                    setDinnerType(next);
                                                    if (next !== "other")
                                                        setDinnerOtherDetail(
                                                            "",
                                                        );
                                                }}
                                                styleSheet={styles}
                                            />
                                        ))}
                                    </View>
                                    {dinnerType === "other" ? (
                                        <View style={styles.mealOtherBlock}>
                                            <Text style={styles.fieldLabel}>
                                                Describe your dinner
                                            </Text>
                                            <Text style={styles.fieldHint}>
                                                e.g. Tibs, kitfo, soup & bread…
                                            </Text>
                                            <TextInput
                                                value={dinnerOtherDetail}
                                                onChangeText={
                                                    setDinnerOtherDetail
                                                }
                                                placeholder="What do you usually eat?"
                                                placeholderTextColor={
                                                    palette.textMuted
                                                }
                                                style={styles.fieldInput}
                                                maxLength={120}
                                            />
                                        </View>
                                    ) : null}
                                </View>

                                <Text style={styles.skipHint}>
                                    Optional — skip what you do not need. If you
                                    pick &quot;Other&quot; for a meal, add a
                                    short note so the AI understands your food.
                                </Text>
                            </View>
                        ) : null}

                        {/* ── STEP 5: Food & eating habits ─────────────────────── */}
                        {step === 5 ? (
                            <View style={styles.stepBody}>
                                <View style={styles.stepScreenIntroCard}>
                                    <Ionicons
                                        name="restaurant-outline"
                                        size={22}
                                        color={palette.oceanBlue}
                                    />
                                    <Text style={styles.stepScreenIntroTitle}>
                                        Food & eating habits
                                    </Text>
                                    <Text style={styles.stepScreenIntroSub}>
                                        This step is only about how you eat —
                                        not money. Pick everything that fits
                                        you; we use it for cafés, restaurants,
                                        and meal ideas.
                                    </Text>
                                </View>

                                <Text style={styles.sectionLabel}>
                                    Meal preferences
                                </Text>
                                <Text style={styles.helper}>
                                    Tap all that apply. You can select more than
                                    one.
                                </Text>
                                <View style={styles.mealList}>
                                    {MEAL_PREFS.map((item) => {
                                        const selected =
                                            mealPreferences.includes(item);
                                        const sub = mealPrefSubtitle(item);
                                        return (
                                            <Pressable
                                                key={item}
                                                onPress={() =>
                                                    toggleListItem(
                                                        item,
                                                        setMealPreferences,
                                                    )
                                                }
                                                style={[
                                                    styles.mealRow,
                                                    selected &&
                                                        styles.mealRowSelected,
                                                ]}
                                            >
                                                <View
                                                    style={styles.mealRowText}
                                                >
                                                    <Text
                                                        style={[
                                                            styles.mealRowTitle,
                                                            selected &&
                                                                styles.mealRowTitleSelected,
                                                        ]}
                                                    >
                                                        {mealPrefLabel(item)}
                                                    </Text>
                                                    {sub ? (
                                                        <Text
                                                            style={
                                                                styles.mealRowSub
                                                            }
                                                        >
                                                            {sub}
                                                        </Text>
                                                    ) : null}
                                                </View>
                                                <View
                                                    style={[
                                                        styles.mealCheck,
                                                        selected &&
                                                            styles.mealCheckOn,
                                                    ]}
                                                >
                                                    {selected ? (
                                                        <Ionicons
                                                            name="checkmark"
                                                            size={14}
                                                            color={
                                                                palette.deepBlue
                                                            }
                                                        />
                                                    ) : null}
                                                </View>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            </View>
                        ) : null}

                        {/* ── STEP 6: Budget & outings ─────────────────────────── */}
                        {step === 6 ? (
                            <View style={styles.stepBody}>
                                <View
                                    style={[
                                        styles.stepScreenIntroCard,
                                        styles.stepScreenIntroCardAlt,
                                    ]}
                                >
                                    <Ionicons
                                        name="wallet-outline"
                                        size={22}
                                        color={palette.emerald}
                                    />
                                    <Text style={styles.stepScreenIntroTitle}>
                                        Budget & outings
                                    </Text>
                                    <Text style={styles.stepScreenIntroSub}>
                                        All amounts are in Ethiopian Birr (ETB)
                                        per week for going out (cafés, events,
                                        fun trips). The app will not suggest
                                        places above your range.
                                    </Text>
                                </View>

                                <Text style={styles.sectionLabel}>
                                    Weekly outing budget (ETB)
                                </Text>
                                <Text style={styles.helper}>
                                    Cheap fits lighter spending; Medium fits
                                    typical middle-range weeks; Flexible is for
                                    budgets above 10,000 ETB — type your amount.
                                </Text>
                                <View style={styles.tierRow}>
                                    {[
                                        {
                                            id: "low",
                                            title: "Cheap",
                                            hint: `1–${BUDGET_TIER_LOW.max.toLocaleString()} ETB / wk`,
                                            icon: "leaf-outline",
                                        },
                                        {
                                            id: "medium",
                                            title: "Middle",
                                            hint: `${BUDGET_TIER_MEDIUM.min.toLocaleString()}–${BUDGET_TIER_MEDIUM.max.toLocaleString()} ETB / wk`,
                                            icon: "wallet-outline",
                                        },
                                        {
                                            id: "flexible",
                                            title: "Flexible",
                                            hint: `Above ${BUDGET_TIER_MEDIUM.max.toLocaleString()} ETB`,
                                            icon: "infinite-outline",
                                        },
                                    ].map((t) => (
                                        <Pressable
                                            key={t.id}
                                            onPress={() =>
                                                applyBudgetTier(t.id)
                                            }
                                            style={[
                                                styles.tierChip,
                                                budgetTier === t.id &&
                                                    styles.tierChipSelected,
                                            ]}
                                        >
                                            <Ionicons
                                                name={t.icon}
                                                size={16}
                                                color={
                                                    budgetTier === t.id
                                                        ? palette.deepBlue
                                                        : palette.textMuted
                                                }
                                            />
                                            <Text
                                                style={[
                                                    styles.tierChipTitle,
                                                    budgetTier === t.id &&
                                                        styles.tierChipTitleSelected,
                                                ]}
                                            >
                                                {t.title}
                                            </Text>
                                            <Text style={styles.tierChipHint}>
                                                {t.hint}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>

                                {budgetTier === "flexible" ? (
                                    <View style={styles.budgetCard}>
                                        <Text style={styles.flexLabel}>
                                            Amount per week (ETB)
                                        </Text>
                                        <Text style={styles.fieldHint}>
                                            Enter more than{" "}
                                            {BUDGET_TIER_MEDIUM.max.toLocaleString()}{" "}
                                            ETB.
                                        </Text>
                                        <TextInput
                                            value={flexibleBudgetText}
                                            onChangeText={setFlexibleBudgetText}
                                            keyboardType="numeric"
                                            placeholder="e.g. 15000"
                                            placeholderTextColor={
                                                palette.textMuted
                                            }
                                            style={styles.flexInput}
                                        />
                                    </View>
                                ) : (
                                    <View style={styles.budgetCard}>
                                        <Text style={styles.budgetNumber}>
                                            {Math.round(weeklyBudget)}
                                        </Text>
                                        <Text style={styles.budgetUnit}>
                                            ETB per week
                                        </Text>
                                        <Slider
                                            style={styles.slider}
                                            minimumValue={
                                                budgetTier === "low"
                                                    ? BUDGET_TIER_LOW.min
                                                    : BUDGET_TIER_MEDIUM.min
                                            }
                                            maximumValue={
                                                budgetTier === "low"
                                                    ? BUDGET_TIER_LOW.max
                                                    : BUDGET_TIER_MEDIUM.max
                                            }
                                            step={
                                                budgetTier === "low"
                                                    ? BUDGET_STEP_LOW
                                                    : BUDGET_STEP_MEDIUM
                                            }
                                            value={weeklyBudget}
                                            onValueChange={setWeeklyBudget}
                                            minimumTrackTintColor={
                                                palette.oceanBlue
                                            }
                                            maximumTrackTintColor={
                                                palette.borderStrong
                                            }
                                            thumbTintColor={palette.deepBlue}
                                        />
                                        <View style={styles.sliderEnds}>
                                            <Text style={styles.sliderEndLabel}>
                                                {budgetTier === "low"
                                                    ? `${BUDGET_TIER_LOW.min} ETB`
                                                    : `${BUDGET_TIER_MEDIUM.min} ETB`}
                                            </Text>
                                            <Text style={styles.sliderEndLabel}>
                                                {budgetTier === "low"
                                                    ? `${BUDGET_TIER_LOW.max} ETB`
                                                    : `${BUDGET_TIER_MEDIUM.max} ETB`}
                                            </Text>
                                        </View>
                                    </View>
                                )}

                                <Text
                                    style={[
                                        styles.sectionLabel,
                                        { marginTop: 20 },
                                    ]}
                                >
                                    Place vibe (outings)
                                </Text>
                                <Text style={styles.helper}>
                                    Indoor, outdoor, or a mix — for place ideas.
                                </Text>
                                <View style={styles.inlineOptions}>
                                    {LOCATION_PREF.map((item) => (
                                        <SelectChip
                                            key={item}
                                            label={formatLabel(item)}
                                            selected={
                                                locationPreference === item
                                            }
                                            onPress={() =>
                                                setLocationPreference(item)
                                            }
                                            styleSheet={styles}
                                        />
                                    ))}
                                </View>

                                <Text
                                    style={[
                                        styles.sectionLabel,
                                        { marginTop: 20 },
                                    ]}
                                >
                                    Weekend preference
                                </Text>
                                <Text style={styles.helper}>
                                    How do you usually like to spend your
                                    weekends?
                                </Text>
                                <View style={styles.inlineOptions}>
                                    {WEEKEND_PREFS.map((item) => (
                                        <SelectChip
                                            key={item}
                                            label={formatLabel(item)}
                                            selected={
                                                weekendPreference === item
                                            }
                                            onPress={() =>
                                                setWeekendPreference(
                                                    weekendPreference === item
                                                        ? ""
                                                        : item,
                                                )
                                            }
                                            styleSheet={styles}
                                        />
                                    ))}
                                </View>

                                <Text
                                    style={[
                                        styles.sectionLabel,
                                        { marginTop: 20 },
                                    ]}
                                >
                                    Event interests
                                </Text>
                                <Text style={styles.helper}>
                                    What kinds of events do you enjoy? Select
                                    all that apply.
                                </Text>
                                <View style={styles.chipsWrap}>
                                    {EVENT_INTERESTS.map((item) => (
                                        <SelectChip
                                            key={item}
                                            label={EVENT_INTEREST_LABELS[item]}
                                            selected={eventInterests.includes(
                                                item,
                                            )}
                                            onPress={() =>
                                                toggleListItem(
                                                    item,
                                                    setEventInterests,
                                                )
                                            }
                                            styleSheet={styles}
                                        />
                                    ))}
                                </View>
                            </View>
                        ) : null}
                    </ScrollView>
                </KeyboardAvoidingView>

                {/* Footer navigation */}
                <View style={styles.footerRow}>
                    {step > 0 ? (
                        <Pressable
                            onPress={goBack}
                            disabled={saving}
                            style={styles.secondaryBtnWrap}
                        >
                            <Ionicons
                                name="arrow-back"
                                size={16}
                                color={palette.textSecondary}
                                style={{ marginRight: 4 }}
                            />
                            <Text style={styles.secondaryBtnText}>Back</Text>
                        </Pressable>
                    ) : (
                        <View style={styles.footerSpacer} />
                    )}
                    <Pressable
                        onPress={isLastStep ? saveAndContinue : goNext}
                        disabled={
                            (!isLastStep && !canGoNext) ||
                            (isLastStep && (!stepValid || saving))
                        }
                        style={[
                            styles.ctaWrap,
                            ((!isLastStep && !canGoNext) ||
                                (isLastStep && (!stepValid || saving))) &&
                                styles.ctaDisabled,
                        ]}
                    >
                        <LinearGradient
                            colors={gradients.primaryButton}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.cta}
                        >
                            <Text style={styles.ctaText}>
                                {saving
                                    ? "Saving…"
                                    : isLastStep
                                      ? "Continue"
                                      : "Next"}
                            </Text>
                            {!saving ? (
                                <Ionicons
                                    name={
                                        isLastStep
                                            ? "checkmark"
                                            : "arrow-forward"
                                    }
                                    size={16}
                                    color="#fff"
                                />
                            ) : null}
                        </LinearGradient>
                    </Pressable>
                </View>
            </LinearGradient>
        </SafeAreaView>
    );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

function createStyles(palette, isDark) {
    return StyleSheet.create({
        flex: {
            flex: 1,
        },
        safeArea: {
            flex: 1,
            backgroundColor: palette.pageTop,
        },
        screen: {
            flex: 1,
            paddingHorizontal: 20,
        },
        scrollContent: {
            paddingTop: 8,
        },

        // ── Progress Header ────────────────────────────────────────────────
        progressHeader: {
            marginTop: 8,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
        },
        progressMeta: {
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
        },
        stepIconWrap: {
            width: 40,
            height: 40,
            borderRadius: 13,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(31,100,200,0.2)"
                : "rgba(31,159,234,0.1)",
            alignItems: "center",
            justifyContent: "center",
        },
        stepCounter: {
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 0.8,
        },
        stepName: {
            color: palette.textPrimary,
            fontSize: 13,
            fontWeight: "800",
            marginTop: 1,
        },
        stepPct: {
            color: palette.oceanBlue,
            fontSize: 15,
            fontWeight: "800",
        },
        progressTrack: {
            marginTop: 12,
            height: 5,
            borderRadius: 999,
            backgroundColor: "rgba(10,108,168,0.18)",
            overflow: "hidden",
        },
        progressFill: {
            height: "100%",
            borderRadius: 999,
            backgroundColor: palette.oceanBlue,
        },

        // ── Step header ────────────────────────────────────────────────────
        title: {
            marginTop: 20,
            color: palette.textPrimary,
            fontSize: 28,
            lineHeight: 34,
            fontWeight: "800",
        },
        subtitle: {
            marginTop: 6,
            color: palette.textSecondary,
            fontSize: 15,
            lineHeight: 22,
        },
        stepBody: {
            marginTop: 12,
        },
        sectionLabel: {
            marginTop: 16,
            marginBottom: 6,
            color: palette.textMuted,
            fontSize: 11,
            letterSpacing: 1.1,
            textTransform: "uppercase",
            fontWeight: "800",
        },
        helper: {
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 20,
            marginBottom: 6,
        },
        errorText: {
            color: palette.danger,
            fontSize: 12,
            marginTop: 12,
            marginBottom: 8,
        },
        skipHint: {
            marginTop: 18,
            color: palette.textMuted,
            fontSize: 12,
            fontStyle: "italic",
            textAlign: "center",
        },

        // ── Step 0 — username ──────────────────────────────────────────────
        usernameHeroCard: {
            borderRadius: 18,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(31,100,200,0.1)"
                : "rgba(31,159,234,0.06)",
            padding: 20,
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
        },
        usernameHeroText: {
            color: palette.textPrimary,
            fontSize: 17,
            fontWeight: "800",
            textAlign: "center",
            lineHeight: 24,
        },
        usernameHeroSub: {
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 19,
            textAlign: "center",
        },
        fieldLabel: {
            marginTop: 16,
            color: palette.textMuted,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: "800",
        },
        fieldHint: {
            marginTop: 3,
            marginBottom: 8,
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 18,
        },
        fieldInput: {
            height: 50,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            color: palette.textPrimary,
            paddingHorizontal: 14,
            fontSize: 15,
            fontWeight: "600",
        },
        mealOtherBlock: {
            marginTop: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            padding: 14,
        },
        stepScreenIntroCard: {
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(31,100,200,0.12)"
                : "rgba(31,159,234,0.07)",
            padding: 16,
            marginBottom: 6,
            gap: 8,
        },
        stepScreenIntroCardAlt: {
            borderColor: isDark
                ? "rgba(38,201,122,0.35)"
                : "rgba(38,201,122,0.28)",
            backgroundColor: isDark
                ? "rgba(38,201,122,0.1)"
                : "rgba(38,201,122,0.06)",
        },
        stepScreenIntroTitle: {
            color: palette.textPrimary,
            fontSize: 16,
            fontWeight: "800",
        },
        stepScreenIntroSub: {
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 19,
        },
        usernameInputRow: {
            flexDirection: "row",
            alignItems: "center",
            height: 54,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            paddingHorizontal: 14,
            gap: 6,
        },
        usernameInputValid: {
            borderColor: palette.mint,
            backgroundColor: isDark
                ? "rgba(46,204,113,0.08)"
                : "rgba(46,204,113,0.05)",
        },
        usernameInputError: {
            borderColor: palette.danger,
            backgroundColor: isDark
                ? "rgba(231,76,60,0.08)"
                : "rgba(231,76,60,0.04)",
        },
        usernameAtSymbol: {
            color: palette.textMuted,
            fontSize: 20,
            fontWeight: "700",
        },
        usernameTextInput: {
            flex: 1,
            color: palette.textPrimary,
            fontSize: 18,
            fontWeight: "700",
            height: "100%",
        },
        usernameStatusText: {
            marginTop: 6,
            fontSize: 12,
            fontWeight: "600",
        },
        usernameTipsCard: {
            marginTop: 20,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 14,
        },
        usernameTipsTitle: {
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: "800",
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 6,
        },
        usernameTipsItem: {
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 20,
        },

        // ── Step 1 — schedule ──────────────────────────────────────────────
        scheduleSection: {
            borderRadius: 18,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 16,
        },
        scheduleSectionHeader: {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
        },
        scheduleSectionTitle: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "800",
        },
        twoColRow: {
            flexDirection: "row",
            gap: 10,
            marginTop: 4,
        },
        twoColField: {
            flex: 1,
        },
        timeCardWrap: {
            flex: 1,
        },
        timeCardLabel: {
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 6,
        },
        timeCard: {
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            paddingVertical: 14,
            paddingHorizontal: 14,
        },
        timeValue: {
            color: palette.textPrimary,
            fontSize: 26,
            fontWeight: "800",
            letterSpacing: 0.5,
        },
        timeHint: {
            marginTop: 4,
            color: palette.textMuted,
            fontSize: 11,
        },
        timeInput: {
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            paddingVertical: 12,
            paddingHorizontal: 14,
            color: palette.textPrimary,
            fontSize: 18,
            fontWeight: "800",
        },
        webTimeHint: {
            marginTop: 8,
            color: palette.textMuted,
            fontSize: 12,
        },
        timeDone: {
            alignSelf: "flex-end",
            marginTop: 8,
            paddingVertical: 8,
            paddingHorizontal: 12,
        },
        timeDoneText: {
            color: palette.oceanBlue,
            fontWeight: "800",
            fontSize: 16,
        },
        flexToggle: {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            alignSelf: "flex-start",
            borderRadius: 999,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            paddingHorizontal: 14,
            paddingVertical: 10,
            marginBottom: 10,
        },
        flexToggleOn: {
            borderColor: palette.oceanBlue,
            backgroundColor: "rgba(31,159,234,0.12)",
        },
        flexToggleText: {
            color: palette.textSecondary,
            fontSize: 13,
            fontWeight: "700",
        },
        flexToggleTextOn: {
            color: palette.deepBlue,
        },
        workingHoursCard: {
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            padding: 14,
        },
        workPeriodStack: {
            gap: 14,
        },
        workPeriodCard: {
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 12,
            gap: 10,
        },
        workPeriodCardAlt: {
            backgroundColor: isDark
                ? "rgba(31,159,234,0.08)"
                : "rgba(31,159,234,0.06)",
        },
        workPeriodHeaderRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
        },
        workPeriodTitleWrap: {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
        },
        workPeriodTitle: {
            color: palette.textPrimary,
            fontSize: 14,
            fontWeight: "800",
        },
        workPeriodBadge: {
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 4,
            backgroundColor: isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.05)",
        },
        workPeriodBadgeText: {
            color: palette.textMuted,
            fontSize: 10,
            fontWeight: "800",
            letterSpacing: 0.6,
            textTransform: "uppercase",
        },
        workPeriodSeparator: {
            height: 1,
            backgroundColor: palette.borderStrong,
            opacity: 0.7,
        },
        workPeriodRow: {
            flexDirection: "row",
            gap: 10,
        },
        workTimeSlot: {
            flex: 1,
        },

        // ── Step 2 — about you ─────────────────────────────────────────────
        aiContextCard: {
            flexDirection: "row",
            gap: 10,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: isDark
                ? "rgba(31,100,200,0.12)"
                : "rgba(31,159,234,0.07)",
            padding: 14,
            marginBottom: 4,
            alignItems: "flex-start",
        },
        aiContextText: {
            flex: 1,
            color: palette.textSecondary,
            fontSize: 13,
            lineHeight: 19,
        },
        aboutSection: {},
        aboutSectionHeader: {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 20,
            marginBottom: 4,
        },
        optionalBadge: {
            borderRadius: 999,
            backgroundColor: isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.06)",
            paddingHorizontal: 8,
            paddingVertical: 2,
        },
        optionalText: {
            color: palette.textMuted,
            fontSize: 10,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 0.6,
        },
        sectionTagWrap: {
            borderRadius: 999,
            backgroundColor: "rgba(31,159,234,0.12)",
            paddingHorizontal: 8,
            paddingVertical: 2,
        },
        sectionTagText: {
            color: palette.oceanBlue,
            fontSize: 10,
            fontWeight: "700",
        },

        // ── Step 3 — activities ────────────────────────────────────────────
        activityCategory: {
            marginTop: 18,
        },
        activityCategoryHeader: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginBottom: 10,
        },
        activityCategoryTitle: {
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: "800",
            textTransform: "uppercase",
            letterSpacing: 0.9,
        },
        customActivitySection: {
            marginTop: 20,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 14,
        },
        customInputRow: {
            flexDirection: "row",
            gap: 8,
            marginTop: 4,
        },
        customInput: {
            flex: 1,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            paddingVertical: 10,
            paddingHorizontal: 12,
            color: palette.textPrimary,
            fontSize: 14,
        },
        customAddBtn: {
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.oceanBlue,
            backgroundColor: "rgba(31,159,234,0.12)",
            paddingHorizontal: 16,
            justifyContent: "center",
        },
        customAddBtnDisabled: {
            borderColor: palette.borderStrong,
            backgroundColor: "transparent",
            opacity: 0.4,
        },
        customAddText: {
            color: palette.deepBlue,
            fontWeight: "800",
            fontSize: 13,
        },

        // ── Chips ──────────────────────────────────────────────────────────
        chipsWrap: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
        },
        chip: {
            borderRadius: 999,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            paddingHorizontal: 13,
            paddingVertical: 8,
        },
        chipSelected: {
            borderColor: palette.oceanBlue,
            backgroundColor: "rgba(31,159,234,0.18)",
        },
        chipCustom: {
            borderColor: palette.mint,
            backgroundColor: "rgba(46,204,113,0.12)",
            flexDirection: "row",
            alignItems: "center",
        },
        chipText: {
            color: palette.textSecondary,
            fontSize: 12,
            fontWeight: "700",
        },
        chipTextSelected: { color: palette.deepBlue },
        chipTextCustom: { color: palette.mint },
        inlineOptions: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
        },

        // ── Daily routine sections ─────────────────────────────────────────
        routineSection: {
            marginTop: 14,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 14,
        },
        routineSectionHeader: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
        },
        routineSectionTitle: {
            color: palette.oceanBlue,
            fontSize: 14,
            fontWeight: "800",
            textTransform: "uppercase",
            letterSpacing: 0.8,
        },

        // ── Meal list ──────────────────────────────────────────────────────
        mealList: { gap: 8 },
        mealRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            paddingVertical: 12,
            paddingHorizontal: 14,
        },
        mealRowSelected: {
            borderColor: palette.oceanBlue,
            backgroundColor: "rgba(31,159,234,0.14)",
        },
        mealRowText: { flex: 1, paddingRight: 12 },
        mealRowTitle: {
            color: palette.textPrimary,
            fontSize: 15,
            fontWeight: "700",
        },
        mealRowTitleSelected: { color: palette.deepBlue },
        mealRowSub: {
            marginTop: 4,
            color: palette.textSecondary,
            fontSize: 12,
            lineHeight: 17,
        },
        mealCheck: {
            width: 26,
            height: 26,
            borderRadius: 999,
            borderWidth: 2,
            borderColor: palette.borderStrong,
            alignItems: "center",
            justifyContent: "center",
        },
        mealCheckOn: {
            borderColor: palette.oceanBlue,
            backgroundColor: "rgba(31,159,234,0.25)",
        },

        // ── Budget ─────────────────────────────────────────────────────────
        tierRow: {
            flexDirection: "row",
            gap: 8,
            marginBottom: 10,
        },
        tierChip: {
            flex: 1,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            paddingVertical: 12,
            paddingHorizontal: 10,
            alignItems: "center",
            gap: 4,
        },
        tierChipSelected: {
            borderColor: palette.emerald,
            backgroundColor: "rgba(38,201,122,0.12)",
        },
        tierChipTitle: {
            color: palette.textPrimary,
            fontSize: 13,
            fontWeight: "800",
        },
        tierChipTitleSelected: { color: palette.deepBlue },
        tierChipHint: {
            color: palette.textMuted,
            fontSize: 10,
            lineHeight: 14,
            textAlign: "center",
        },
        budgetCard: {
            marginTop: 4,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            padding: 16,
        },
        budgetNumber: {
            color: palette.textPrimary,
            fontSize: 36,
            fontWeight: "800",
            textAlign: "center",
        },
        budgetUnit: {
            color: palette.textMuted,
            fontSize: 12,
            textAlign: "center",
            marginBottom: 8,
        },
        slider: { width: "100%", height: 44 },
        sliderEnds: { flexDirection: "row", justifyContent: "space-between" },
        sliderEndLabel: { color: palette.textMuted, fontSize: 11 },
        flexLabel: {
            color: palette.textMuted,
            fontSize: 12,
            fontWeight: "700",
            marginBottom: 8,
        },
        flexInput: {
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surfaceStrong,
            paddingVertical: 12,
            paddingHorizontal: 14,
            color: palette.textPrimary,
            fontSize: 20,
            fontWeight: "800",
        },

        // ── Footer ─────────────────────────────────────────────────────────
        footerRow: {
            position: "absolute",
            left: 20,
            right: 20,
            bottom: 26,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
        },
        footerSpacer: { width: 100 },
        secondaryBtnWrap: {
            width: 100,
            height: 54,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderStrong,
            backgroundColor: palette.surface,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
        },
        secondaryBtnText: {
            color: palette.textSecondary,
            fontWeight: "800",
            fontSize: 15,
        },
        ctaWrap: {
            flex: 1,
            borderRadius: 16,
            overflow: "hidden",
        },
        cta: {
            height: 54,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 8,
        },
        ctaDisabled: { opacity: 0.5 },
        ctaText: {
            color: palette.iceWhite,
            fontWeight: "800",
            textTransform: "uppercase",
            letterSpacing: 0.5,
        },
    });
}
