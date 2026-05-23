/**
 * denominationClassifier.js — Denomination-aware church classifier for the backend.
 *
 * Mirrors the logic of ai-service/denomination/classifier.py so the same
 * quality filtering runs at the Node/Express layer without a round-trip.
 *
 * Scoring sources (in descending weight):
 *   1. Place name keyword match     — weight 3.0 (authoritative)
 *   2. Tags / place-type match      — weight 2.0
 *   3. Description keyword match    — weight 1.5
 *   4. Review text match            — weight 1.0
 *   5. Website URL domain match     — weight 1.5
 *
 * Returns a { denomination, confidence, scores, evidence, isReligious } object.
 * Confidence is scores[best] / sum(scores) — between 0.25 and 1.0.
 *
 * Public API:
 *   classifyDenomination(place)              → DenominationResult
 *   denominationAllowedForUser(place, religion) → boolean
 *   getPlaceReligionType(place)              → string|null
 */

// ─── Keyword lists ────────────────────────────────────────────────────────────
// Each entry: [keyword, weight]

const ORTHODOX_NAME = [
  ["tewahedo",          4.0],
  ["tewahido",          4.0],
  ["medhanealem",       3.5],
  ["medhane alem",      3.5],
  ["medhane-alem",      3.5],
  ["debre",             3.0],
  ["kidus",             3.0],
  ["kidist",            3.0],
  ["kiddis",            3.0],
  ["qidus",             3.0],
  ["qiddis",            3.0],
  ["bete christian",    3.0],
  ["bete kristiyan",    3.0],
  ["giorgis",           2.5],
  ["gebriel",           2.5],
  ["mikael",            2.5],
  ["mikail",            2.5],
  ["urael",             2.5],
  ["gabriel orthodox",  4.0],
  ["mariam orthodox",   4.0],
  ["mariam church",     2.5],
  ["selassie",          2.5],
  ["kidane mehret",     3.5],
  ["kidane mehrete",    3.5],
  ["kidane-mehret",     3.5],
  ["gedam",             2.5],
  ["abune",             2.5],
  // Amharic script
  ["ቅዱስ",              4.0],
  ["ቅድስት",             4.0],
  ["ማርያም",             3.0],
  ["ቅዱሳን",             3.0],
  ["መድሀኒዓለም",          4.0],
  ["ደብረ",              3.5],
  ["ቤተ ክርስቲያን",        2.5],
  // General English
  ["orthodox",          3.5],
  ["ethiopian orthodox",4.0],
  ["st. mariam",        3.0],
  ["saint mariam",      3.0],
  ["kidane",            2.5],
  ["medhane",           2.5],
];

const ORTHODOX_REVIEW = [
  ["kidase",            3.0],
  ["qidase",            3.0],
  ["timket",            3.0],
  ["meskel",            2.5],
  ["holy water",        2.0],
  ["liturgy",           2.0],
  ["incense",           1.5],
  ["chanting",          1.5],
  ["deacon",            2.0],
  ["tsebel",            2.5],
];

const PROTESTANT_NAME = [
  ["eecmy",              4.5],  // Ethiopian Evangelical Church Mekane Yesus
  ["eec my",             4.5],
  ["evangelical church", 4.0],
  ["mekane yesus",       4.0],
  ["mekane-yesus",       4.0],
  ["kale heywet",        4.0],
  ["kale hiwot",         4.0],
  ["meserete kristos",   4.0],
  ["meseret kristos",    4.0],
  ["meseret kirstos",    4.0],
  ["beteseb",            3.0],
  ["full gospel",        3.5],
  ["evangelical",        3.5],
  ["latter-day saints",  4.5],
  ["latter day saints",  4.5],
  ["latter-day",         4.0],
  ["latter day",         4.0],
  ["jesus christ of",    3.5],  // LDS full name pattern
  ["mormon",             3.5],
  ["lds church",         4.0],
  ["pentecostal",        3.5],
  ["pentecost",          3.5],
  ["assemblies of god",  4.0],
  ["assembly of god",    4.0],
  ["baptist",            3.5],
  ["lutheran",           3.5],
  ["adventist",          3.5],
  ["seventh day",        3.0],
  ["sda church",         4.0],
  ["methodist",          3.5],
  ["reformed church",    3.0],
  ["protestant",         4.0],
  ["worship center",     2.0],
  ["worship centre",     2.0],
  ["salvation army",     3.5],
];

const PROTESTANT_REVIEW = [
  ["pastor",             2.0],
  ["sermon",             2.0],
  ["worship team",       2.5],
  ["praise and worship", 2.5],
  ["gospel teaching",    2.0],
  ["fellowship",         1.5],
];

const CATHOLIC_NAME = [
  ["catholic",           4.0],
  ["roman catholic",     4.5],
  ["basilica",           3.5],
  ["parish",             3.0],
  ["diocese",            3.5],
  ["sacred heart",       3.5],
  ["immaculate",         3.5],
  ["our lady",           3.0],
  ["notre dame",         3.0],
  ["franciscan",         3.5],
  ["jesuit",             3.5],
  ["dominican",          3.5],
  ["capuchin",           3.5],
];

const CATHOLIC_REVIEW = [
  ["mass",               2.0],
  ["confession",         2.0],
  ["eucharist",          2.5],
  ["rosary",             2.5],
  ["adoration",          2.0],
];

const MUSLIM_NAME = [
  ["mosque",             4.0],
  ["masjid",             4.0],
  ["mesjid",             4.0],
  ["jami",               3.0],
  ["jamia",              3.0],
  ["islamic",            4.0],
  ["muslim",             4.0],
  ["salah",              3.0],
  ["musalla",            3.5],
  ["juma",               3.0],
];

const MUSLIM_REVIEW = [
  ["salat",              2.5],
  ["jummah",             2.5],
  ["imam",               2.0],
  ["friday prayer",      3.0],
  ["quran",              2.5],
];

// Quick presence check — must contain at least one of these to be considered
// a religious venue at all (prevents false positives on "Grace Coffee" etc.)
const RELIGIOUS_ANCHORS = new Set([
  "church", "chapel", "mosque", "masjid", "mesjid", "temple",
  "synagogue", "hindu_temple", "cathedral", "parish", "monastery",
  "jami", "jamia", "musalla", "prayer hall", "worship hall",
  "worship center", "worship centre",
  "tewahedo", "tewahido", "orthodox", "protestant", "catholic",
  "mekane yesus", "kale heywet", "kale hiwot",
  "meserete kristos", "meseret kristos", "full gospel",
  "evangelical", "pentecostal", "adventist", "islamic",
  "gedam", "kidane", "debre",
  "ቅዱስ", "ቅድስት", "ደብረ", "ቤተ ክርስቲያን",
]);

const MIN_SCORE = 1.0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {object} place
 * @returns {{ name: string, tagsType: string, desc: string, reviews: string, website: string }}
 */
function gatherTexts(place) {
  const name    = (place.name    || "").toLowerCase();
  const tags    = (Array.isArray(place.tags) ? place.tags.join(" ") : "").toLowerCase();
  const ptype   = (place.type    || place.category || "").toLowerCase();
  const desc    = (place.description || place.summary || "").toLowerCase();
  const website = (place.website || "").toLowerCase();

  const reviewParts = [];
  const reviews = place.reviews || [];
  for (const r of reviews.slice(0, 8)) {
    if (typeof r === "string")  reviewParts.push(r.toLowerCase());
    else if (r?.text)           reviewParts.push(String(r.text).toLowerCase());
  }

  return {
    name,
    tagsType: `${tags} ${ptype}`,
    desc,
    reviews:  reviewParts.join(" "),
    website,
  };
}

function scoreKeywords(text, kwList) {
  let total = 0;
  const matched = [];
  for (const [kw, w] of kwList) {
    if (text.includes(kw)) {
      total += w;
      matched.push(kw);
    }
  }
  return { score: total, matched };
}

function isReligiousVenueText(name, tagsType) {
  const combined = `${name} ${tagsType}`;
  for (const anchor of RELIGIOUS_ANCHORS) {
    if (combined.includes(anchor)) return true;
  }
  return false;
}

// ─── Main classifier ─────────────────────────────────────────────────────────

/**
 * @typedef {{ denomination: string, confidence: number, scores: object, evidence: string[], isReligious: boolean }} DenominationResult
 */

/**
 * Classify the denomination of a place.
 * Always returns a result — never throws.
 *
 * @param {object} place
 * @returns {DenominationResult}
 */
export function classifyDenomination(place) {
  if (!place) return { denomination: "other", confidence: 1.0, scores: {}, evidence: [], isReligious: false };

  const { name, tagsType, desc, reviews, website } = gatherTexts(place);
  const isReligious = isReligiousVenueText(name, tagsType);

  if (!isReligious) {
    return { denomination: "other", confidence: 1.0, scores: {}, evidence: [], isReligious: false };
  }

  const scores  = { orthodox: 0, protestant: 0, catholic: 0, muslim: 0 };
  const evidence = [];

  const kwSets = {
    orthodox:   { name: ORTHODOX_NAME,   review: ORTHODOX_REVIEW },
    protestant: { name: PROTESTANT_NAME, review: PROTESTANT_REVIEW },
    catholic:   { name: CATHOLIC_NAME,   review: CATHOLIC_REVIEW },
    muslim:     { name: MUSLIM_NAME,     review: MUSLIM_REVIEW },
  };

  for (const [denom, { name: nameKw, review: revKw }] of Object.entries(kwSets)) {
    // Name (full weight)
    const n = scoreKeywords(name, nameKw);
    scores[denom] += n.score;
    n.matched.forEach((k) => evidence.push(`name:${k}`));

    // Tags/type (70% of name weight)
    const t = scoreKeywords(tagsType, nameKw);
    scores[denom] += t.score * 0.7;

    // Description (50%)
    const d = scoreKeywords(desc, nameKw);
    scores[denom] += d.score * 0.5;

    // Reviews (40%)
    const r = scoreKeywords(reviews, revKw);
    scores[denom] += r.score * 0.4;
    r.matched.forEach((k) => evidence.push(`review:${k}`));
  }

  // Website signals
  if (website.includes("orthodox") || website.includes("tewahedo") || website.includes("eotc"))
    { scores.orthodox += 1.5; evidence.push("website:orthodox"); }
  if (website.includes("mekane") || website.includes("kale") || website.includes("evangelical"))
    { scores.protestant += 1.5; evidence.push("website:protestant"); }
  if (website.includes("catholic") || website.includes("diocese"))
    { scores.catholic += 1.5; evidence.push("website:catholic"); }
  if (website.includes("mosque") || website.includes("islamic") || website.includes("masjid"))
    { scores.muslim += 1.5; evidence.push("website:muslim"); }

  // Pick winner
  const bestDenom  = Object.keys(scores).reduce((a, b) => scores[a] >= scores[b] ? a : b);
  const bestScore  = scores[bestDenom];
  const totalScore = Object.values(scores).reduce((s, v) => s + v, 0);
  const confidence = totalScore > 0 ? bestScore / totalScore : 0;

  const finalDenom = bestScore >= MIN_SCORE ? bestDenom : "christian";

  return {
    denomination: finalDenom,
    confidence:   +confidence.toFixed(3),
    scores:       Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, +v.toFixed(2)])),
    evidence:     evidence.slice(0, 20),
    isReligious:  true,
  };
}

/**
 * Returns true when the place is allowed for a user with the given religion.
 * Non-religious places always pass.
 *
 * @param {object}      place
 * @param {string|null} userReligion — from user profile (onboarding)
 * @returns {boolean}
 */
export function denominationAllowedForUser(place, userReligion) {
  if (!userReligion || ["", "other", "prefer_not_to_say"].includes(userReligion.toLowerCase())) {
    return true;
  }

  const result = classifyDenomination(place);
  if (!result.isReligious) return true;

  const u = userReligion.toLowerCase().trim();
  const d = result.denomination;

  // Strict: users with a specific faith only see that exact denomination.
  // Generic "christian" / unknown churches are never shown to avoid mixing.
  switch (u) {
    case "orthodox":   return d === "orthodox";
    case "protestant": return d === "protestant";
    case "catholic":   return d === "catholic";
    case "muslim":     return d === "muslim";
    default:           return true;
  }
}

/**
 * Returns a denomination string compatible with the legacy placeAllowedByReligion API.
 * Returns null for non-religious places.
 *
 * @param {object} place
 * @returns {string|null}
 */
export function getPlaceReligionType(place) {
  const result = classifyDenomination(place);
  return result.isReligious ? result.denomination : null;
}
