/**
 * Trusted event source ordering — higher number = show first in feeds.
 * Must stay in sync with ai-service scrapers/scraper_manager.py priorities.
 */
export const SOURCE_TRUST_SCORE = (source) => {
  const s = String(source || "").toLowerCase();
  if (s.includes("chapa_events") || s === "chapa_events") return 105;
  if (s.includes("eventbrite")) return 100;
  if (s.includes("eth_local")) return 95;
  if (s.startsWith("meetup")) return 92;
  if (s.includes("eth_rss")) return 90;
  if (s.includes("alladdis")) return 88;
  if (s.includes("whatsup")) return 88;
  if (s.includes("culture_venue")) return 82;
  if (s.startsWith("rss_feed")) return 75;
  if (s.includes("facebook_public")) return 72;
  if (s.includes("instagram_public")) return 70;
  if (s.startsWith("telegram_")) return 55;
  return 45;
};

/** Sort events: trusted sources first, then soonest date, then newest scrape. */
export const sortEventsByTrustAndDate = (events) => {
  if (!Array.isArray(events) || events.length < 2) return events || [];

  return [...events].sort((a, b) => {
    const trustDiff = SOURCE_TRUST_SCORE(b.source) - SOURCE_TRUST_SCORE(a.source);
    if (trustDiff !== 0) return trustDiff;

    const aDate = String(a.date || a.created_at || "");
    const bDate = String(b.date || b.created_at || "");
    const dateCmp = aDate.localeCompare(bDate);
    if (dateCmp !== 0) return dateCmp;

    const aScraped = String(a.scraped_at || a.created_at || "");
    const bScraped = String(b.scraped_at || b.created_at || "");
    return bScraped.localeCompare(aScraped);
  });
};

/** Pin Chapa (and other top-trust) events to the front while preserving relative order. */
export const prioritizeTrustedSources = (events, minTrust = 90) => {
  if (!Array.isArray(events) || events.length < 2) return events || [];

  const trusted = [];
  const rest = [];
  for (const ev of events) {
    if (SOURCE_TRUST_SCORE(ev.source) >= minTrust) {
      trusted.push(ev);
    } else {
      rest.push(ev);
    }
  }
  return [...sortEventsByTrustAndDate(trusted), ...rest];
};
