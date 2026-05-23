import {
    Image,
    Linking,
    Pressable,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { Marker } from "react-native-maps";
import { useAppTheme } from "../context/ThemeContext";
import { getEventById } from "../api/eventsApi";
import {
    resolveEventThumbnailUri,
    eventPlaceholderGradientColors,
} from "../utils/eventMedia";

const ADDIS_LAT = 9.032;
const ADDIS_LNG = 38.7469;

const URL_REGEX = /https?:\/\/[^\s)\]>]+/gi;

const CATEGORY_COLORS = {
    music:     "#E040FB",
    tech:      "#2196F3",
    church:    "#FF7043",
    fitness:   "#4CAF50",
    business:  "#FF9800",
    food:      "#F44336",
    art:       "#9C27B0",
    sports:    "#00BCD4",
    education: "#3F51B5",
    social:    "#009688",
    other:     "#607D8B",
};

function extractUrls(text) {
    if (!text || typeof text !== "string") return [];
    const matches = text.match(URL_REGEX) || [];
    const cleaned = matches.map((u) => u.replace(/[.,;]+$/, ""));
    return [...new Set(cleaned)];
}

function isMapUrl(url) {
    const u = url.toLowerCase();
    return (
        u.includes("maps.google") ||
        u.includes("google.com/maps") ||
        u.includes("goo.gl") ||
        u.includes("maps.app.goo.gl") ||
        u.includes("g.page") ||
        u.includes("waze.com") ||
        u.includes("apple.com/maps")
    );
}

function stripUrlsFromText(text) {
    if (!text) return "";
    let t = text.replace(URL_REGEX, " ");
    t = t.replace(/\(\s*\)/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}

function tidyParagraphs(text) {
    if (!text) return "";
    return text.replace(/\n{3,}/g, "\n\n").trim();
}

function deriveTitleAndBody(rawTitle, rawDescription) {
    let title = (rawTitle || "").trim();
    let description = (rawDescription || "").trim();

    if (!title && description) {
        const lines = description.split(/\n/).map((l) => l.trim()).filter(Boolean);
        title = (lines[0] || "Event").slice(0, 200);
        description = lines.slice(1).join("\n").trim();
    }

    if (title.length > 160 && !description) {
        const cut = title.search(/[.!?]\s+/);
        if (cut > 24 && cut < 140) {
            description = title.slice(cut + 2).trim();
            title = title.slice(0, cut + 1).trim();
        }
    }

    if (title && description.startsWith(title)) {
        description = description.slice(title.length).replace(/^[\s:;\-,]+/, "").trim();
    }

    return {
        title: title || "Event",
        description: tidyParagraphs(description),
    };
}

function cleanVenueLabel(location, urls) {
    let v = (location || "").trim();
    if (!v) return "";
    let out = v;
    for (const u of urls) {
        out = out.split(u).join(" ");
    }
    out = out.replace(/[()]/g, " ").replace(/\s{2,}/g, " ").trim();
    return out;
}

function extractPriceHint(fullText) {
    if (!fullText) return "";
    const patterns = [
        /(?:free entry|free admission|rsvp free|no charge)\b/gi,
        /(?:ETB|Birr|Br\.?)\s*[:\-]?\s*[\d,]+(?:\.\d{2})?\b/gi,
        /\$\s*[\d,]+(?:\.\d{2})?\b/gi,
        /\b[\d,]+(?:\.\d{2})?\s*(?:ETB|Birr)\b/gi,
    ];
    const hits = [];
    for (const re of patterns) {
        const m = fullText.match(re);
        if (m) hits.push(...m);
    }
    const uniq = [...new Set(hits.map((s) => s.trim()))];
    return uniq.slice(0, 4).join(" · ");
}

function buildInterestTags(category, title, description) {
    const tags = new Set();
    const cat = (category || "").toLowerCase();
    if (cat && cat !== "other") tags.add(cat);
    const blob = `${title} ${description}`.toLowerCase();
    const pairs = [
        ["networking", "networking"],
        ["workshop", "workshop"],
        ["certification", "professional"],
        ["training", "training"],
        ["concert", "live music"],
        ["startup", "startup"],
        ["family", "family-friendly"],
        ["marathon", "sports"],
        ["gallery", "arts"],
    ];
    for (const [needle, tag] of pairs) {
        if (blob.includes(needle)) tags.add(tag);
    }
    return [...tags].slice(0, 8);
}

function formatOrganizerDisplay(source, sourceUrl) {
    if (sourceUrl) {
        try {
            const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
            if (host) return host;
        } catch {
            /* ignore */
        }
    }
    if (source && typeof source === "string") {
        return source.replace(/^telegram_/, "Telegram · ").replace(/_/g, " ");
    }
    return "";
}

function formatEventDate(isoDate) {
    if (!isoDate) return "Date to be announced";
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString("en-ET", {
            weekday: "long",
            year:    "numeric",
            month:   "long",
            day:     "numeric",
        });
    } catch {
        return String(isoDate).slice(0, 10);
    }
}

function formatEventTime(isoDate) {
    if (!isoDate) return "";
    try {
        const d = new Date(isoDate);
        if (d.getHours() === 0 && d.getMinutes() === 0) return "";
        return d.toLocaleTimeString("en-ET", { hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

function buildNormalizedModel(event) {
    const combinedText = `${event.title || ""}\n${event.description || ""}`;
    const urls = extractUrls(combinedText);
    const mapUrls = urls.filter(isMapUrl);
    const extraUrls = urls.filter((u) => !isMapUrl(u));

    const { title, description } = deriveTitleAndBody(event.title, event.description);

    const descNoUrls = stripUrlsFromText(description);
    const venueClean = cleanVenueLabel(event.location, urls) || cleanVenueLabel(title, urls);

    const priceHint = extractPriceHint(combinedText);
    const tags = buildInterestTags(event.category, title, descNoUrls);
    const organizer = formatOrganizerDisplay(event.source, event.source_url);

    const participationNote =
        /(?:limited seats|register|rsvp|booking required)\b/i.test(combinedText)
            ? "Registration may be required — check the listing for details."
            : "";

    return {
        title,
        aboutText: descNoUrls,
        venueClean,
        urls,
        mapUrls,
        extraUrls,
        priceHint,
        tags,
        organizer,
        participationNote,
    };
}

function snapCoord(n, fallback) {
    const x = Number(n);
    return Number.isFinite(x) ? x : fallback;
}

function SectionHeader({ children, palette }) {
    return (
        <Text style={[styles.sectionHeader, { color: palette.textMuted }]}>
            {children}
        </Text>
    );
}

function ActionRow({ icon, label, sublabel, onPress, palette, isDark }) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            style={({ pressed }) => [
                styles.actionRow,
                {
                    backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                    borderColor: palette.borderSoft,
                    opacity: pressed ? 0.85 : 1,
                },
            ]}
        >
            <View style={[styles.actionIconWrap, { backgroundColor: palette.pageMid }]}>
                <Ionicons name={icon} size={20} color={palette.oceanBlue} />
            </View>
            <View style={{ flex: 1 }}>
                <Text style={[styles.actionLabel, { color: palette.textPrimary }]}>{label}</Text>
                {sublabel ? (
                    <Text style={[styles.actionSub, { color: palette.textMuted }]} numberOfLines={2}>
                        {sublabel}
                    </Text>
                ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
        </Pressable>
    );
}

export default function EventDetailScreen({ route, navigation }) {
    const initial = route.params?.event;
    const { palette, gradients, isDark } = useAppTheme();
    const insets = useSafeAreaInsets();

    const [event, setEvent] = useState(initial);
    const [heroFailed, setHeroFailed] = useState(false);
    const [heroTryHttp, setHeroTryHttp] = useState(false);

    useEffect(() => {
        setEvent(initial);
    }, [initial]);

    // Warm hero image cache from list payload so the screen paints faster.
    useEffect(() => {
        if (!initial) return;
        const uri = resolveEventThumbnailUri(initial);
        if (uri && uri.startsWith("http")) {
            Image.prefetch(uri).catch(() => null);
        }
    }, [initial?.id]);

    useEffect(() => {
        let cancelled = false;
        const id = initial?.id;
        if (!id) return undefined;
        (async () => {
            try {
                const fresh = await getEventById(id);
                if (!cancelled && fresh && typeof fresh === "object") {
                    setEvent((prev) => ({ ...(prev || {}), ...fresh }));
                }
            } catch {
                /* keep route payload */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [initial?.id]);

    const dynStyles = useMemo(() => createDynStyles(palette, isDark), [palette, isDark]);

    const normalized = useMemo(() => (event ? buildNormalizedModel(event) : null), [event]);

    const resolvedHeroHttps = useMemo(
        () => (event ? resolveEventThumbnailUri(event) : ""),
        [event],
    );

    useEffect(() => {
        setHeroFailed(false);
        setHeroTryHttp(false);
    }, [event?.id, resolvedHeroHttps]);

    const registrationExtras = useMemo(() => {
        if (!event?.registration_urls) return [];
        const listing = (event.source_url || "").trim();
        const seen = new Set();
        const out = [];
        for (const u of event.registration_urls) {
            const s = typeof u === "string" ? u.trim() : "";
            if (!s.startsWith("http")) continue;
            if (listing && s === listing) continue;
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(s);
        }
        return out;
    }, [event?.registration_urls, event?.source_url]);

    const openUrl = useCallback((url) => {
        if (!url) return;
        Linking.openURL(url).catch(() => null);
    }, []);

    const shareEvent = useCallback(async () => {
        if (!event || !normalized) return;
        try {
            const message = [
                normalized.title,
                formatEventDate(event.date),
                normalized.venueClean || event.location,
                event.source_url,
            ]
                .filter(Boolean)
                .join("\n");
            await Share.share({ title: normalized.title, message });
        } catch {
            /* user dismissed */
        }
    }, [event, normalized]);

    const directionsUrl = useMemo(() => {
        if (!normalized) return "";
        const direct = normalized.mapUrls[0];
        if (direct) return direct;
        const q = normalized.venueClean || event?.location;
        if (q && q.length > 2) {
            return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
        }
        return "";
    }, [normalized, event?.location]);

    const rawHero = typeof event?.image === "string" ? event.image.trim() : "";
    const heroDisplayUri =
        heroTryHttp && rawHero.startsWith("http://") ? rawHero : resolvedHeroHttps;
    const showHeroImage = Boolean(heroDisplayUri && !heroFailed);

    const onHeroLoadError = useCallback(() => {
        if (!heroTryHttp && rawHero.startsWith("http://") && resolvedHeroHttps !== rawHero) {
            setHeroTryHttp(true);
        } else {
            setHeroFailed(true);
        }
    }, [heroTryHttp, rawHero, resolvedHeroHttps]);

    if (!event || !normalized) {
        return (
            <View style={[styles.center, { backgroundColor: palette.pageTop }]}>
                <Text style={{ color: palette.textPrimary }}>Event not found</Text>
                <Pressable onPress={() => navigation.goBack()} style={{ marginTop: 16 }}>
                    <Text style={{ color: palette.oceanBlue }}>Go back</Text>
                </Pressable>
            </View>
        );
    }

    const catColor = CATEGORY_COLORS[event.category] || CATEGORY_COLORS.other;
    const dateStr = formatEventDate(event.date);
    const timeStr = formatEventTime(event.date);

    const lat = snapCoord(event.coordinates?.lat, ADDIS_LAT);
    const lng = snapCoord(event.coordinates?.lng, ADDIS_LNG);
    const isDefaultPin =
        Math.abs(lat - ADDIS_LAT) < 0.002 && Math.abs(lng - ADDIS_LNG) < 0.002;
    const hasPreciseCoords = Boolean(
        event.coordinates &&
        Number.isFinite(Number(event.coordinates.lat)) &&
        Number.isFinite(Number(event.coordinates.lng)) &&
        !isDefaultPin,
    );

    const [heroG0, heroG1] = eventPlaceholderGradientColors(event);

    // Prefer booking_url (direct ticket purchase link) over source_url
    const bookingUrl = (event.booking_url || "").trim();
    const listingUrl = bookingUrl || (event.source_url || "").trim();

    const isChapaEvent = String(event?.source || "").includes("chapa");
    const primaryLinkLabel =
        bookingUrl && (isChapaEvent || bookingUrl.includes("eventbrite") || bookingUrl.includes("chapa"))
            ? "Book Tickets on Chapa Events"
            : listingUrl.includes("eventbrite") ? "Tickets & registration"
                : listingUrl.includes("t.me") || listingUrl.includes("telegram") ? "View original post"
                    : "Full details & registration";

    // Source display metadata
    const SOURCE_META_DETAIL = {
        chapa_events:   { label: "Chapa Events",  color: "#F59E0B", icon: "ticket-outline" },
        eventbrite:     { label: "Eventbrite",    color: "#F05537", icon: "ticket-outline" },
        meetup:         { label: "Meetup",         color: "#ED1C40", icon: "people-outline" },
        alladdisevents: { label: "AllAddisEvents", color: "#2563EB", icon: "globe-outline" },
        eth_rss:        { label: "News",           color: "#64748B", icon: "newspaper-outline" },
        eth_local:      { label: "Local",          color: "#059669", icon: "business-outline" },
    };
    const sourceMeta = (() => {
        const src = String(event?.source || "").toLowerCase();
        for (const [key, meta] of Object.entries(SOURCE_META_DETAIL)) {
            if (src.includes(key)) return meta;
        }
        if (src.startsWith("telegram_")) return { label: "Telegram", color: "#229ED9", icon: "paper-plane-outline" };
        return null;
    })();

    return (
        <LinearGradient colors={gradients.appBackground} style={{ flex: 1 }}>
            <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
                {/* Top bar */}
                <View style={[dynStyles.topBar, { paddingTop: 4 }]}>
                    <Pressable
                        onPress={() => navigation.goBack()}
                        style={dynStyles.backBtn}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Go back"
                    >
                        <Ionicons name="arrow-back" size={22} color={palette.textPrimary} />
                    </Pressable>
                    <Text style={[dynStyles.topBarTitle, { color: palette.textPrimary }]} numberOfLines={1}>
                        Event details
                    </Text>
                    <Pressable
                        onPress={shareEvent}
                        style={dynStyles.backBtn}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Share event"
                    >
                        <Ionicons name="share-outline" size={20} color={palette.textPrimary} />
                    </Pressable>
                </View>

                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{
                        paddingBottom: insets.bottom + 100,
                    }}
                >
                    {/* Hero */}
                    <View style={styles.heroWrap}>
                        {showHeroImage ? (
                            <Image
                                source={{ uri: heroDisplayUri }}
                                style={styles.heroImage}
                                resizeMode="cover"
                                onError={onHeroLoadError}
                            />
                        ) : (
                            <LinearGradient
                                colors={[heroG0, heroG1]}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={styles.heroImage}
                            >
                                <View style={styles.heroPlaceholderInner}>
                                    <Ionicons name="calendar-outline" size={52} color="rgba(255,255,255,0.82)" />
                                </View>
                            </LinearGradient>
                        )}
                        <LinearGradient
                            colors={["transparent", "rgba(0,0,0,0.75)"]}
                            style={styles.heroGradient}
                        />
                        <View style={styles.heroBadgeRow}>
                            <View style={[styles.catBadge, { backgroundColor: catColor }]}>
                                <Text style={styles.catBadgeText}>
                                    {(event.category || "other").replace(/_/g, " ").toUpperCase()}
                                </Text>
                            </View>
                        </View>
                    </View>

                    <View style={dynStyles.content}>
                        {/* Title + chips */}
                        <Text style={[styles.title, { color: palette.textPrimary }]}>
                            {normalized.title}
                        </Text>

                        <View style={styles.chipRow}>
                            <View style={[styles.chip, { borderColor: palette.borderSoft, backgroundColor: palette.surface }]}>
                                <Ionicons name="calendar-outline" size={14} color={palette.oceanBlue} />
                                <Text style={[styles.chipText, { color: palette.textSecondary }]} numberOfLines={1}>
                                    {dateStr}
                                </Text>
                            </View>
                            {timeStr ? (
                                <View style={[styles.chip, { borderColor: palette.borderSoft, backgroundColor: palette.surface }]}>
                                    <Ionicons name="time-outline" size={14} color={palette.oceanBlue} />
                                    <Text style={[styles.chipText, { color: palette.textSecondary }]}>
                                        {timeStr}
                                    </Text>
                                </View>
                            ) : null}
                            {event?.ticket_price || event?.is_paid === false ? (
                                <View style={[styles.chip, { borderColor: palette.borderSoft, backgroundColor: palette.surface }]}>
                                    <Ionicons name="pricetag-outline" size={14} color={palette.oceanBlue} />
                                    <Text style={[styles.chipText, { color: palette.textSecondary }]} numberOfLines={1}>
                                        {event.ticket_price || (event.is_paid === false ? "Free" : "")}
                                    </Text>
                                </View>
                            ) : null}
                        </View>

                        {/* Source badge */}
                        {sourceMeta && (
                            <View style={styles.sourceRow}>
                                <View style={[styles.sourceTag, { backgroundColor: sourceMeta.color + "20" }]}>
                                    <Ionicons name={sourceMeta.icon} size={13} color={sourceMeta.color} />
                                    <Text style={[styles.sourceTagText, { color: sourceMeta.color }]}>
                                        {sourceMeta.label}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {/* AI reason banner */}
                        {!!event?.explain && (
                            <View
                                style={[
                                    styles.reasonBanner,
                                    {
                                        borderColor: isDark ? "rgba(96,165,250,0.4)" : "rgba(37,99,235,0.35)",
                                        backgroundColor: isDark ? "rgba(96,165,250,0.12)" : "rgba(37,99,235,0.08)",
                                    },
                                ]}
                            >
                                <Ionicons
                                    name="sparkles-outline"
                                    size={16}
                                    color={isDark ? "#93C5FD" : "#1D4ED8"}
                                />
                                <Text
                                    style={[
                                        styles.reasonBannerText,
                                        { color: isDark ? "#DBEAFE" : "#1E3A8A" },
                                    ]}
                                >
                                    {event.explain}
                                </Text>
                            </View>
                        )}

                        {/* Book Ticket CTA — shown prominently for events with a booking URL */}
                        {(bookingUrl || listingUrl) ? (
                            <Pressable
                                onPress={() => Linking.openURL(bookingUrl || listingUrl).catch(() => {})}
                                style={({ pressed }) => [
                                    styles.bookTicketBtn,
                                    {
                                        opacity: pressed ? 0.88 : 1,
                                        backgroundColor: isChapaEvent ? "#F59E0B" : palette.oceanBlue,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel="Book ticket for this event"
                            >
                                <Ionicons name="ticket-outline" size={18} color="#fff" />
                                <Text style={styles.bookTicketBtnText}>
                                    {isChapaEvent ? "Book on Chapa Events" : event?.ticket_price ? "Get Tickets" : "View Event"}
                                </Text>
                                <Ionicons name="open-outline" size={14} color="rgba(255,255,255,0.8)" />
                            </Pressable>
                        ) : null}

                        {/* Key facts card */}
                        <View style={[dynStyles.card]}>
                            {(normalized.venueClean || event.location) ? (
                                <View style={styles.factBlock}>
                                    <Text style={[styles.factLabel, { color: palette.textMuted }]}>Venue & area</Text>
                                    <Text style={[styles.factValue, { color: palette.textPrimary }]}>
                                        {normalized.venueClean || event.location || "Ethiopia"}
                                    </Text>
                                </View>
                            ) : null}

                            {normalized.priceHint ? (
                                <>
                                    <View style={[styles.hairline, { backgroundColor: palette.borderSoft }]} />
                                    <View style={styles.factBlock}>
                                        <Text style={[styles.factLabel, { color: palette.textMuted }]}>Pricing</Text>
                                        <Text style={[styles.factValue, { color: palette.textPrimary }]}>
                                            {normalized.priceHint}
                                        </Text>
                                    </View>
                                </>
                            ) : null}

                            {normalized.organizer ? (
                                <>
                                    <View style={[styles.hairline, { backgroundColor: palette.borderSoft }]} />
                                    <View style={styles.factBlock}>
                                        <Text style={[styles.factLabel, { color: palette.textMuted }]}>Organizer / source</Text>
                                        <Text style={[styles.factValue, { color: palette.textPrimary }]}>
                                            {normalized.organizer}
                                        </Text>
                                    </View>
                                </>
                            ) : null}

                            {normalized.participationNote ? (
                                <Text style={[styles.noteText, { color: palette.textMuted }]}>
                                    {normalized.participationNote}
                                </Text>
                            ) : null}
                        </View>

                        {/* Links */}
                        {(listingUrl || directionsUrl || normalized.extraUrls.length > 0 || registrationExtras.length > 0) ? (
                            <View style={dynStyles.section}>
                                <SectionHeader palette={palette}>Links & actions</SectionHeader>
                                <View style={{ gap: 10 }}>
                                    {/* Show booking URL separately when it differs from listing URL */}
                                    {bookingUrl && bookingUrl !== (event.source_url || "") ? (
                                        <ActionRow
                                            icon="ticket-outline"
                                            label={isChapaEvent ? "Book on Chapa Events" : "Book Tickets"}
                                            sublabel={bookingUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 72)}
                                            onPress={() => openUrl(bookingUrl)}
                                            palette={palette}
                                            isDark={isDark}
                                        />
                                    ) : null}
                                    {listingUrl && listingUrl !== bookingUrl ? (
                                        <ActionRow
                                            icon="open-outline"
                                            label={primaryLinkLabel}
                                            sublabel={listingUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 72)}
                                            onPress={() => openUrl(listingUrl)}
                                            palette={palette}
                                            isDark={isDark}
                                        />
                                    ) : listingUrl ? (
                                        <ActionRow
                                            icon="open-outline"
                                            label={primaryLinkLabel}
                                            sublabel={listingUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 72)}
                                            onPress={() => openUrl(listingUrl)}
                                            palette={palette}
                                            isDark={isDark}
                                        />
                                    ) : null}
                                    {registrationExtras.map((url) => (
                                        <ActionRow
                                            key={url}
                                            icon="ticket-outline"
                                            label="Registration or tickets"
                                            sublabel={url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}
                                            onPress={() => openUrl(url)}
                                            palette={palette}
                                            isDark={isDark}
                                        />
                                    ))}
                                    {directionsUrl ? (
                                        <ActionRow
                                            icon="navigate-outline"
                                            label="Directions"
                                            sublabel="Open in Maps"
                                            onPress={() => openUrl(directionsUrl)}
                                            palette={palette}
                                            isDark={isDark}
                                        />
                                    ) : null}
                                    {normalized.extraUrls
                                        .filter((u) => u !== listingUrl && !registrationExtras.includes(u))
                                        .slice(0, 4)
                                        .map((url) => (
                                            <ActionRow
                                                key={url}
                                                icon="link-outline"
                                                label="Related link"
                                                sublabel={url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}
                                                onPress={() => openUrl(url)}
                                                palette={palette}
                                                isDark={isDark}
                                            />
                                        ))}
                                </View>
                            </View>
                        ) : null}

                        {/* Tags */}
                        {normalized.tags.length > 0 ? (
                            <View style={dynStyles.section}>
                                <SectionHeader palette={palette}>Tags & interests</SectionHeader>
                                <View style={styles.tagWrap}>
                                    {normalized.tags.map((tag) => (
                                        <View
                                            key={tag}
                                            style={[styles.tagChip, { borderColor: palette.borderSoft, backgroundColor: palette.surface }]}
                                        >
                                            <Text style={[styles.tagChipText, { color: palette.textSecondary }]}>
                                                {tag}
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            </View>
                        ) : null}

                        {/* About */}
                        {normalized.aboutText ? (
                            <View style={dynStyles.section}>
                                <SectionHeader palette={palette}>About this event</SectionHeader>
                                <Text
                                    style={[styles.bodyText, { color: palette.textSecondary }]}
                                    selectable
                                >
                                    {normalized.aboutText}
                                </Text>
                            </View>
                        ) : (
                            <View style={dynStyles.section}>
                                <SectionHeader palette={palette}>About this event</SectionHeader>
                                <Text style={[styles.placeholderText, { color: palette.textMuted }]}>
                                    No detailed description yet. Use the links above for schedules and registration.
                                </Text>
                            </View>
                        )}

                        {/* Map preview */}
                        <View style={dynStyles.section}>
                            <SectionHeader palette={palette}>Map preview</SectionHeader>
                            <View style={[styles.mapWrap, { borderColor: palette.borderSoft }]}>
                                <MapView
                                    style={styles.map}
                                    initialRegion={{
                                        latitude: lat,
                                        longitude: lng,
                                        latitudeDelta:  0.02,
                                        longitudeDelta: 0.02,
                                    }}
                                    scrollEnabled={false}
                                    zoomEnabled={false}
                                    rotateEnabled={false}
                                    pitchEnabled={false}
                                >
                                    <Marker
                                        coordinate={{ latitude: lat, longitude: lng }}
                                        title={normalized.title}
                                        description={normalized.venueClean || event.location}
                                        pinColor={catColor}
                                    />
                                </MapView>
                            </View>
                            {!hasPreciseCoords ? (
                                <Text style={[styles.mapFootnote, { color: palette.textMuted }]}>
                                    Approximate area shown. Use Directions for the exact location when available.
                                </Text>
                            ) : null}
                        </View>
                    </View>
                </ScrollView>

                {/* Bottom bar */}
                <View style={[dynStyles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                    {listingUrl ? (
                        <Pressable
                            onPress={() => openUrl(listingUrl)}
                            style={styles.bottomPrimaryWrap}
                            accessibilityRole="button"
                        >
                            <LinearGradient
                                colors={gradients.primaryButtonMint}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.bottomPrimary}
                            >
                                <Ionicons name="rocket-outline" size={20} color="#fff" />
                                <Text style={styles.bottomPrimaryText}>{primaryLinkLabel}</Text>
                            </LinearGradient>
                        </Pressable>
                    ) : directionsUrl ? (
                        <Pressable
                            onPress={() => openUrl(directionsUrl)}
                            style={styles.bottomPrimaryWrap}
                            accessibilityRole="button"
                        >
                            <LinearGradient
                                colors={gradients.primaryButtonMint}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.bottomPrimary}
                            >
                                <Ionicons name="navigate-outline" size={20} color="#fff" />
                                <Text style={styles.bottomPrimaryText}>Get directions</Text>
                            </LinearGradient>
                        </Pressable>
                    ) : (
                        <Text style={[styles.bottomFallback, { color: palette.textMuted }]}>
                            Check back soon — listing link will appear when available.
                        </Text>
                    )}
                </View>
            </SafeAreaView>
        </LinearGradient>
    );
}

const styles = StyleSheet.create({
    center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
    },
    heroWrap: {
        marginHorizontal: 16,
        borderRadius: 20,
        overflow: "hidden",
        height: 220,
        marginBottom: 8,
    },
    heroImage: {
        width: "100%",
        height: "100%",
    },
    heroGradient: {
        ...StyleSheet.absoluteFillObject,
    },
    heroPlaceholderInner: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    heroBadgeRow: {
        position: "absolute",
        left: 14,
        bottom: 14,
        right: 14,
        flexDirection: "row",
        justifyContent: "flex-start",
    },
    catBadge: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
    },
    catBadgeText: {
        color: "#fff",
        fontSize: 11,
        fontWeight: "700",
        letterSpacing: 0.6,
    },
    title: {
        fontSize: 26,
        fontWeight: "800",
        lineHeight: 32,
        letterSpacing: -0.3,
        marginBottom: 12,
    },
    chipRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 18,
    },
    chip: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        maxWidth: "100%",
    },
    chipText: {
        fontSize: 13,
        fontWeight: "600",
        flexShrink: 1,
    },
    sourceRow: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 12,
    },
    sourceTag: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 20,
    },
    sourceTagText: {
        fontSize: 12,
        fontWeight: "700",
    },
    bookTicketBtn: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingVertical: 14,
        paddingHorizontal: 20,
        borderRadius: 14,
        marginBottom: 20,
    },
    bookTicketBtnText: {
        color: "#fff",
        fontSize: 16,
        fontWeight: "700",
        flex: 1,
        textAlign: "center",
    },
    reasonBanner: {
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 18,
    },
    reasonBannerText: {
        flex: 1,
        fontSize: 13,
        fontWeight: "600",
        lineHeight: 18,
    },
    sectionHeader: {
        fontSize: 11,
        fontWeight: "700",
        letterSpacing: 1.2,
        textTransform: "uppercase",
        marginBottom: 10,
    },
    factBlock: {
        paddingVertical: 4,
    },
    factLabel: {
        fontSize: 11,
        fontWeight: "600",
        marginBottom: 4,
        textTransform: "uppercase",
        letterSpacing: 0.6,
    },
    factValue: {
        fontSize: 16,
        fontWeight: "600",
        lineHeight: 22,
    },
    hairline: {
        height: StyleSheet.hairlineWidth,
        marginVertical: 12,
    },
    noteText: {
        fontSize: 13,
        lineHeight: 19,
        marginTop: 12,
        fontStyle: "italic",
    },
    actionRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 14,
        borderRadius: 14,
        borderWidth: 1,
    },
    actionIconWrap: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
    },
    actionLabel: {
        fontSize: 15,
        fontWeight: "700",
    },
    actionSub: {
        fontSize: 12,
        marginTop: 2,
        lineHeight: 16,
    },
    tagWrap: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
    },
    tagChip: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
    },
    tagChipText: {
        fontSize: 13,
        fontWeight: "600",
        textTransform: "capitalize",
    },
    bodyText: {
        fontSize: 16,
        lineHeight: 26,
        fontWeight: "400",
    },
    placeholderText: {
        fontSize: 15,
        lineHeight: 22,
    },
    mapWrap: {
        borderRadius: 16,
        overflow: "hidden",
        height: 180,
        borderWidth: 1,
    },
    map: {
        flex: 1,
    },
    mapFootnote: {
        fontSize: 12,
        lineHeight: 17,
        marginTop: 8,
    },
    bottomPrimaryWrap: {
        borderRadius: 14,
        overflow: "hidden",
    },
    bottomPrimary: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        paddingVertical: 16,
        paddingHorizontal: 20,
    },
    bottomPrimaryText: {
        color: "#fff",
        fontSize: 16,
        fontWeight: "800",
    },
    bottomFallback: {
        textAlign: "center",
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: 12,
    },
});

function createDynStyles(palette, isDark) {
    return StyleSheet.create({
        topBar: {
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 14,
            paddingVertical: 8,
            justifyContent: "space-between",
        },
        backBtn: {
            width: 40,
            height: 40,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.06)",
        },
        topBarTitle: {
            fontSize: 17,
            fontWeight: "700",
            flex: 1,
            textAlign: "center",
            marginHorizontal: 8,
        },
        content: {
            paddingHorizontal: 18,
            paddingTop: 16,
        },
        card: {
            borderRadius: 18,
            padding: 16,
            marginBottom: 22,
            backgroundColor: isDark ? "rgba(18,35,58,0.72)" : "rgba(255,255,255,0.9)",
            borderWidth: 1,
            borderColor: palette.borderSoft,
        },
        section: {
            marginBottom: 26,
        },
        bottomBar: {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 18,
            paddingTop: 10,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
            backgroundColor: isDark ? "rgba(12,22,38,0.94)" : "rgba(250,252,255,0.94)",
        },
    });
}
