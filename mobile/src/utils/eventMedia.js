/**
 * Event image helpers — resolve real thumbnail URLs from API payloads.
 *
 * Many scrapers emit http://, protocol-relative //, or site-relative paths.
 * We normalize those so React Native can load them; placeholders only show
 * when no usable URL exists or loading fails after retries.
 */

const IMG_URL_IN_TEXT =
    /https?:\/\/[^\s"'<>)]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>)]*)?/i;

/** Decode common HTML entity leakage in URLs from scraped HTML */
function decodeUriEntities(u) {
    return u.replace(/&amp;/g, "&").replace(/&#38;/g, "&").trim();
}

/**
 * Normalize a single URL string to https://… when possible.
 */
export function normalizeRemoteImageUri(raw) {
    if (raw == null || typeof raw !== "string") return "";
    let u = decodeUriEntities(raw);
    if (!u || u.startsWith("data:")) return "";
    if (u.startsWith("//")) u = `https:${u}`;
    if (u.startsWith("http://")) u = `https://${u.slice(7)}`;
    if (!/^https:\/\//i.test(u)) return "";
    try {
        // Drop junk whitespace / wrappers some scrapers add
        const parsed = new URL(u);
        if (!parsed.hostname) return "";
        return parsed.href;
    } catch {
        return "";
    }
}

/** @deprecated use normalizeRemoteImageUri — kept for existing imports */
export function getTrustedEventImageUri(raw) {
    return normalizeRemoteImageUri(raw);
}

/** First absolute image-looking URL inside prose (Telegram / HTML blurbs). */
export function extractLooseImageUrlFromText(text) {
    if (!text || typeof text !== "string") return "";
    const m = text.match(IMG_URL_IN_TEXT);
    return m ? normalizeRemoteImageUri(m[0]) : "";
}

const CHAPA_CDN = "https://assets.chapa.co/customer-uploads/";
const CHAPA_SOURCE_RE = /chapa/i;

/**
 * Normalise a Chapa CDN path to a full absolute URL.
 * chapa_scraper sometimes emits just the filename; ensure it's absolute.
 */
function normalizeChapaImageUri(raw) {
    if (!raw || typeof raw !== "string") return "";
    const t = raw.trim();
    if (t.startsWith("http")) return t;
    if (t.startsWith(CHAPA_CDN)) return t;
    // bare filename like "EV_abc123.png"
    if (/^[\w\-]+\.(jpg|jpeg|png|webp|gif)$/i.test(t)) {
        return `${CHAPA_CDN}${t}`;
    }
    return "";
}

/**
 * Best thumbnail URL for an event document from Firestore/API.
 * Priority: Chapa CDN > other absolute URLs > relative paths > prose extraction.
 */
export function resolveEventThumbnailUri(event) {
    if (!event || typeof event !== "object") return "";

    const isChapa = CHAPA_SOURCE_RE.test(String(event.source || ""));

    const bases = [];
    if (typeof event.source_url === "string" && event.source_url.trim()) {
        bases.push(event.source_url.trim());
    }

    const candidates = [];
    for (const key of ["image", "cover_image", "photo_url", "banner_url", "thumbnail"]) {
        const v = event[key];
        if (v != null && String(v).trim()) candidates.push(String(v).trim());
    }

    for (const raw of candidates) {
        // Chapa events: try CDN normalisation first
        if (isChapa) {
            const c = normalizeChapaImageUri(raw);
            if (c) return c;
        }

        const abs = normalizeRemoteImageUri(raw);
        if (abs) return abs;

        if (raw.startsWith("/")) {
            for (const base of bases) {
                try {
                    const joined = new URL(raw, base).href;
                    const n = normalizeRemoteImageUri(joined);
                    if (n) return n;
                } catch {
                    /* ignore */
                }
            }
        }
        // Root-relative without leading slash (some CMS paths)
        if (
            !/^https?:\/\//i.test(raw)
            && raw.includes(".")
            && !raw.includes(" ")
            && bases.length > 0
        ) {
            for (const base of bases) {
                try {
                    const joined = new URL(`/${raw.replace(/^\/+/, "")}`, base).href;
                    const n = normalizeRemoteImageUri(joined);
                    if (n) return n;
                } catch {
                    /* ignore */
                }
            }
        }
    }

    const fromDesc = extractLooseImageUrlFromText(event.description || "");
    if (fromDesc) return fromDesc;

    const fromTitle = extractLooseImageUrlFromText(event.title || "");
    if (fromTitle) return fromTitle;

    return "";
}

/** Stable hue 0–359 from title/id for honest placeholder gradients */
export function eventHueSeed(event) {
    const key = `${event?.id ?? ""}|${event?.title ?? ""}|${event?.source_url ?? ""}`;
    let h = 0;
    for (let i = 0; i < key.length; i += 1) {
        h = (h * 31 + key.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 360;
}

/**
 * Category-aware vibrant gradients — unique per event, visually rich.
 */
const CATEGORY_GRADIENT_HUES = {
    music:     [280, 320],   // purple → pink
    tech:      [210, 240],   // blue → indigo
    business:  [25,  45],    // amber → orange
    sports:    [160, 200],   // teal → cyan
    fitness:   [130, 160],   // green → teal
    church:    [35,  55],    // warm gold
    food:      [10,  35],    // red → orange
    art:       [290, 330],   // violet → magenta
    social:    [180, 210],   // cyan → blue
    education: [215, 250],   // blue → indigo
    other:     [null, null], // use event hash
};

export function eventPlaceholderGradientColors(event) {
    const cat = String(event?.category || "other").toLowerCase();
    const pair = CATEGORY_GRADIENT_HUES[cat] ?? CATEGORY_GRADIENT_HUES.other;
    const hue = eventHueSeed(event);
    const h1 = pair[0] ?? hue;
    const h2 = pair[1] ?? ((hue + 30) % 360);
    const top    = hslToHex(h1, 62, 32);
    const bottom = hslToHex(h2, 55, 18);
    return [top, bottom];
}

function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        const x = Math.round(255 * Math.min(1, Math.max(0, c)));
        const hex = x.toString(16);
        return hex.length === 1 ? `0${hex}` : hex;
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
