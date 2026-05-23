/**
 * utils/pricing.utils.js — Fast rule-based price classifier (Node.js).
 *
 * Mirrors the Python ai-service pricing/classifier.py logic so the backend
 * can tag every place with `priceLevel` ("cheap"|"mid"|"expensive") even
 * when the AI service is unavailable.
 *
 * Priority:
 *  1. Google priceLevel hint (0-4) — authoritative when present
 *  2. Brand / luxury keyword hits  — very high confidence
 *  3. Area-based reputation        — medium confidence
 *  4. Generic keyword heuristic    — low confidence
 *  5. Rating/popularity fallback   — lowest confidence
 *
 * Output: "cheap" | "mid" | "expensive" (always returns one of the three)
 */

import {
  getPlaceReligionType as _classifyReligion,
  denominationAllowedForUser as _denominationAllowed,
} from "./denominationClassifier.js";

// ── Keyword lists ────────────────────────────────────────────────────────────

const EXPENSIVE_BRANDS = [
  "skylight", "hyatt", "sheraton", "radisson", "hilton", "marriott",
  "ramada", "intercontinental", "kempinski", "ellilly", "elilly",
  "golden tulip", "capital hotel", "elilly international", "trinity hotel",
];

const EXPENSIVE_KEYWORDS = [
  "luxury", "premium", "fine dining", "rooftop bar", "five star", "5-star",
  "5 star", "exclusive", "vip lounge", "boutique hotel", "high-end", "upscale",
];

const CHEAP_KEYWORDS = [
  "mercato", "merkato", "sook", "souq", "kibat", "local food",
  "traditional food", "tej bet", "tella bet", "buna bet",
  "street food", "addis ketema", "shola market", "piazza market",
  "cheap", "budget", "affordable",
];

// Area → tier map (medium-confidence context signal)
const AREA_TIER = new Map([
  // Expensive areas / Bole sub-areas
  ["bole internacional", "expensive"],
  ["bole medhane alem", "expensive"],
  ["bole bulbula", "expensive"],
  ["bole", "mid"],          // generic "bole" alone is mid — specific Bole sub-spots vary
  ["old airport", "mid"],
  // Mid-range neighborhoods
  ["kazanchis", "mid"],
  ["atlas", "mid"],
  ["sarbet", "mid"],
  ["gerji", "mid"],
  ["megenagna", "mid"],
  ["haya hulet", "mid"],
  ["22", "mid"],            // 22 mazoria area
  ["summit", "mid"],
  // Budget / cheap neighborhoods
  ["mercato", "cheap"],
  ["merkato", "cheap"],
  ["addis ketema", "cheap"],
  ["shola", "cheap"],
  ["saris", "cheap"],
  ["piazza", "cheap"],
  ["kality", "cheap"],
  ["lideta", "cheap"],
  ["akaki", "cheap"],
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function gatherText(place) {
  const parts = [];
  for (const key of ["name", "title", "description", "summary", "address",
                      "vicinity", "formatted_address"]) {
    if (typeof place[key] === "string") parts.push(place[key]);
  }
  if (Array.isArray(place.tags)) parts.push(...place.tags.map(String));
  if (Array.isArray(place.types)) parts.push(...place.types.map(String));
  return parts.join(" ").toLowerCase();
}

function matchArea(text) {
  // Iterate longest keys first so "bole internacional" beats "bole"
  const sorted = [...AREA_TIER.keys()].sort((a, b) => b.length - a.length);
  for (const area of sorted) {
    if (text.includes(area)) return AREA_TIER.get(area);
  }
  return null;
}

// ─── Category-aware pricing visibility ────────────────────────────────────────
// Mirrors ai-service/pricing/eligibility.py (keep rules aligned).

const HARD_OFF_TYPES = new Set([
  "church",
  "mosque",
  "worship",
  "prayer",
  "chapel",
  "cathedral",
  "synagogue",
  "shrine",
  "temple",
  "hindu_temple",
  "park",
  "plaza",
  "monument",
  "cemetery",
  "memorial",
  "playground",
  "hiking",
  "trail",
  "walking",
  "viewpoint",
  "lookout",
  "bridge",
  "town_square",
  "public_space",
]);

const LIBRARY_TYPES = new Set(["library"]);

const SOFT_OFF_OUTDOOR = new Set(["outdoor"]);

const HARD_ON_TYPES = new Set([
  "coffee",
  "cafe",
  "restaurant",
  "bakery",
  "bar",
  "lounge",
  "night_club",
  "hotel",
  "lodge",
  "guesthouse",
  "gym",
  "yoga",
  "fitness",
  "spa",
  "cinema",
  "club",
  "music",
  "shop",
  "shopping",
  "mall",
  "store",
  "market",
  "taxi",
  "bus",
  "ride",
  "workspace",
  "coworking",
  "office",
  "museum",
  "gallery",
  "art",
  "theater",
  "stadium",
  "sports",
  "event",
  "events",
  "concert",
  "social",
]);

const FREE_PHRASES = [
  "free entry",
  "no entrance fee",
  "entrance free",
  "open to the public",
  "public park",
  "public library",
  "church service",
  "community center",
  "community centre",
  "volunteer event",
  "religious service",
  "public gathering",
  "walking area",
  "prayer only",
  "free event",
  "donation only",
  "free admission",
  "no ticket",
  "free and open",
  "public space",
  "national park",
  "university campus",
  "campus library",
  "study area",
  "public garden",
];

const PAID_PATTERN = new RegExp(
  [
    "luxury",
    "coworking",
    "co-working",
    "membership",
    "membership plan",
    "subscription",
    "reservation required",
    "booking required",
    "book now",
    "ticket",
    "tickets",
    "cover charge",
    "cover fee",
    "buffet",
    "admission fee",
    "entrance fee",
    "day pass",
    "day-pass",
    "premium lounge",
    "vip",
    "5-star",
    "five star",
    "hotel",
    "conference fee",
    "paid event",
    "paid training",
    "training course",
    "workshop fee",
  ].join("|"),
  "i",
);

const FREE_PHRASE_RE = new RegExp(
  FREE_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

const FREE_WORD_RE = /\b(public|volunteer|nonprofit|non-profit|mass\b|sermon|mosque|church\b|prayer\s+hall|free\b|donation-based|donations?\b)\b/i;

function normalizePlaceType(place) {
  let raw = place?.type || place?.category || "";
  if (typeof raw !== "string") raw = String(raw || "");
  let s = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (s === "coffee_shop" || s === "coffeeshop") return "coffee";
  if (s === "movie_theater" || s === "movie_theatre") return "cinema";
  if (s === "performing_arts_theater") return "theater";
  return s;
}

function googleImpliesPaid(place) {
  const pl = place?.priceLevel ?? place?.googlePriceLevel ?? place?.price_level;
  if (pl == null) return false;
  const n = parseInt(pl, 10);
  if (!Number.isNaN(n)) return n >= 1;
  if (typeof pl === "string") {
    const s = pl.toLowerCase();
    return s.includes("moderate") || s.includes("expensive") || s.includes("very_exp");
  }
  return false;
}

/**
 * Whether to show price UI / apply budget tier for this place (fast path, no LLM).
 * @returns {{ pricingEnabled: boolean, reason: string, ambiguous: boolean, signals: string[] }}
 */
export function resolvePricingEligibility(place) {
  const signals = [];
  if (!place || typeof place !== "object") {
    return { pricingEnabled: false, reason: "Invalid place", ambiguous: false, signals: ["invalid"] };
  }

  const ptype = normalizePlaceType(place);
  const text = gatherText(place);
  const paidKw = PAID_PATTERN.test(text);
  const freeKw = FREE_PHRASE_RE.test(text) || FREE_WORD_RE.test(text);
  const googlePaid = googleImpliesPaid(place);

  if (freeKw) signals.push("free_keyword");

  if (HARD_OFF_TYPES.has(ptype)) {
    return {
      pricingEnabled: false,
      reason: "Religious or public place — no typical consumer spend",
      ambiguous: false,
      signals: [...signals, `hard_off_type=${ptype}`],
    };
  }

  if (LIBRARY_TYPES.has(ptype) || /\blibrary\b/i.test(text)) {
    if (paidKw || text.includes("cafe") || text.includes("coffee") || text.includes("coworking") || googlePaid) {
      signals.push("library_paid_signal");
    } else {
      return {
        pricingEnabled: false,
        reason: "Public library — reading is typically free",
        ambiguous: false,
        signals: [...signals, "library_public"],
      };
    }
  }

  if (SOFT_OFF_OUTDOOR.has(ptype)) {
    if (
      paidKw ||
      googlePaid ||
      /adventure park|water park|resort|glamping|zipline/i.test(text)
    ) {
      signals.push("outdoor_commercial");
    } else {
      return {
        pricingEnabled: false,
        reason: "Outdoor / nature spot — usually no entry spend",
        ambiguous: false,
        signals: [...signals, "outdoor_free"],
      };
    }
  }

  if (["event", "events", "concert", "social"].includes(ptype)) {
    if (freeKw) {
      return {
        pricingEnabled: false,
        reason: "Community or free event",
        ambiguous: false,
        signals: [...signals, "event_free"],
      };
    }
    const hasMoneyMention =
      /\b(etb|birr|\d+)\b/i.test(text) &&
      /\b(ticket|price|fee|paid)\b/i.test(text);
    if (
      paidKw ||
      /ticket|concert|show|festival|conference|training|workshop|cover charge/i.test(text) ||
      hasMoneyMention
    ) {
      return {
        pricingEnabled: true,
        reason: "Ticketed or paid event — estimate shown",
        ambiguous: false,
        signals: [...signals, "event_paid"],
      };
    }
    return {
      pricingEnabled: false,
      reason: "Event without clear pricing context",
      ambiguous: true,
      signals: [...signals, "event_ambiguous"],
    };
  }

  if (paidKw) {
    return {
      pricingEnabled: true,
      reason: "Description suggests paid access or services",
      ambiguous: false,
      signals: [...signals, "paid_keyword"],
    };
  }

  if (googlePaid && !HARD_OFF_TYPES.has(ptype)) {
    if (freeKw && (ptype === "park" || ptype === "library")) {
      // fall through
    } else {
      return {
        pricingEnabled: true,
        reason: "Google Maps lists a price level for this venue",
        ambiguous: false,
        signals: [...signals, "google_price_level"],
      };
    }
  }

  if (HARD_ON_TYPES.has(ptype)) {
    if (freeKw && ["restaurant", "cafe", "coffee", "bar"].includes(ptype)) {
      if (/\bfree\s+(lunch|breakfast|buffet|meal)\b/i.test(text) || text.includes("complimentary food")) {
        return {
          pricingEnabled: false,
          reason: "Listed as complimentary / free food offering",
          ambiguous: true,
          signals: [...signals, "food_free_edge_case"],
        };
      }
    }
    return {
      pricingEnabled: true,
      reason: "Category usually involves spending",
      ambiguous: false,
      signals: [...signals, `hard_on_type=${ptype}`],
    };
  }

  if (freeKw) {
    return {
      pricingEnabled: false,
      reason: "Described as public, free, or community-oriented",
      ambiguous: false,
      signals: [...signals, "free_keyword_block"],
    };
  }

  return {
    pricingEnabled: false,
    reason: "No strong signal that typical spending applies",
    ambiguous: true,
    signals: [...signals, "default_no_price"],
  };
}

// ── Public classifier ─────────────────────────────────────────────────────────

/**
 * @param {object} place — any place-shaped object (Firestore doc, Google Places, etc.)
 * @returns {{ priceLevel: "cheap"|"mid"|"expensive", confidence: number, source: string }}
 */
export function classifyPrice(place) {
  if (!place || typeof place !== "object") {
    return { priceLevel: "mid", confidence: 0.2, source: "default" };
  }

  // 1. Google priceLevel (0-4) — highest authority
  const gl = place.priceLevel ?? place.googlePriceLevel ?? place.price_level;
  if (gl != null) {
    let level;
    const n = parseInt(gl, 10);
    if (!Number.isNaN(n)) {
      if (n <= 1) level = "cheap";
      else if (n === 2) level = "mid";
      else level = "expensive";
    } else if (typeof gl === "string") {
      const s = gl.toLowerCase();
      if (s.includes("inexp") || s.includes("free")) level = "cheap";
      else if (s.includes("mod")) level = "mid";
      else if (s.includes("exp")) level = "expensive";
    }
    if (level) return { priceLevel: level, confidence: 0.85, source: "google_price_level" };
  }

  const text = gatherText(place);

  // 2. Brand / luxury keywords — very specific, high confidence
  for (const brand of EXPENSIVE_BRANDS) {
    if (text.includes(brand)) {
      return { priceLevel: "expensive", confidence: 0.90, source: `brand:${brand}` };
    }
  }
  for (const kw of EXPENSIVE_KEYWORDS) {
    if (text.includes(kw)) {
      return { priceLevel: "expensive", confidence: 0.80, source: `luxury_keyword:${kw}` };
    }
  }

  // 3. Cheap keywords — also distinctive
  for (const kw of CHEAP_KEYWORDS) {
    if (text.includes(kw)) {
      return { priceLevel: "cheap", confidence: 0.75, source: `cheap_keyword:${kw}` };
    }
  }

  // 4. Area reputation (medium confidence — can be overridden by rating)
  const areaTier = matchArea(text);

  // 5. Rating heuristic
  const rating = parseFloat(place.rating) || null;
  const reviews = parseInt(place.userRatingsTotal ?? place.user_ratings_total ?? 0, 10) || 0;

  let ratingTier = null;
  let ratingConf = 0.35;
  if (rating !== null) {
    if (rating >= 4.5 && reviews >= 500) { ratingTier = "expensive"; ratingConf = 0.50; }
    else if (rating >= 4.3 && reviews >= 150) { ratingTier = "mid"; ratingConf = 0.40; }
    else if (rating <= 3.2) { ratingTier = "cheap"; ratingConf = 0.35; }
  }

  // Combine area + rating signals: agree → boost confidence; disagree → use area
  if (areaTier && ratingTier && areaTier === ratingTier) {
    return { priceLevel: areaTier, confidence: 0.60, source: "area+rating" };
  }
  if (areaTier) {
    return { priceLevel: areaTier, confidence: 0.50, source: `area:${areaTier}` };
  }
  if (ratingTier) {
    return { priceLevel: ratingTier, confidence: ratingConf, source: "rating" };
  }

  // 6. Default — unknown → mid
  return { priceLevel: "mid", confidence: 0.20, source: "default" };
}

/**
 * Budget tier number for comparison (cheap=1, mid=2, expensive=3).
 * @param {"cheap"|"mid"|"expensive"|string|null} tier
 * @returns {number}
 */
export function tierToNumber(tier) {
  switch ((tier || "").toLowerCase()) {
    case "cheap":     return 1;
    case "mid":       return 2;
    case "expensive": return 3;
    default:          return 2; // unknown → treat as mid
  }
}

/**
 * Convert user's budget signal to canonical tier string.
 * @param {object} profile — user profile object
 * @returns {"cheap"|"mid"|"expensive"}
 */
export function userBudgetTier(profile) {
  if (!profile) return "mid";
  // Prefer numeric weeklyBudget (ETB) — aligned with onboarding tiers:
  //   Cheap: 1–2000 ETB  |  Middle: 2001–10000 ETB  |  Flexible/Expensive: >10000 ETB
  const weekly = profile.weeklyBudget;
  if (typeof weekly === "number" && weekly > 0) {
    if (weekly <= 2000)  return "cheap";
    if (weekly <= 10000) return "mid";
    return "expensive";
  }
  // Fall back to budgetRange label
  const label = (profile.budgetRange || "").toLowerCase().trim();
  if (["cheap", "low", "budget", "affordable"].includes(label)) return "cheap";
  if (["expensive", "high", "luxury", "premium", "flexible"].includes(label)) return "expensive";
  return "mid";  // default
}

/**
 * Determines the denomination of a place (only for religious venues).
 * Delegates to the full denomination classifier for high-accuracy results.
 *
 * Returns:
 *   "muslim"     — mosque / islamic prayer hall
 *   "orthodox"   — Ethiopian Orthodox church
 *   "protestant" — protestant / evangelical church
 *   "catholic"   — Roman/Ethiopian Catholic church
 *   "christian"  — generic Christian (denomination unclear)
 *   null         — not a religious place
 *
 * @param {object} place
 * @returns {string|null}
 */
export function getPlaceReligionType(place) {
  if (!place) return null;
  return _classifyReligion(place);
}

/**
 * Returns true if the place is allowed for the given user religion.
 *
 * Rules:
 *   - Non-religious places → always allowed
 *   - orthodox  user → orthodox churches only (strict — no generic christian)
 *   - protestant user → protestant churches only
 *   - muslim    user → mosques only
 *   - catholic  user → catholic churches only
 *   - other / prefer_not_to_say / null → all places (no filter)
 *
 * @param {object}      place        — place object
 * @param {string|null} userReligion — user's religion from profile
 * @returns {boolean}
 */
export function placeAllowedByReligion(place, userReligion) {
  return _denominationAllowed(place, userReligion);
}
