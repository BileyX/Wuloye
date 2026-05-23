/**
 * scrapeEvents.js — Scheduled event scraping job.
 *
 * Calls the AI service's POST /scrape endpoint on a cron schedule.
 * The AI service runs all scrapers (AllAddis, WhatsUpAddis, Telegram),
 * deduplicates results, and stores new events in Firestore.
 *
 * Schedule: every 8 hours (configurable via SCRAPE_CRON env var).
 *
 * Safety:
 *   - 1 concurrent run enforced (skip if previous run is still going).
 *   - Errors are caught and logged; never crash the server process.
 *   - Optional X-Scraper-Key header for AI service auth.
 */

import { logger } from "../utils/logger.js";
import { invalidateEventsCache, warmEventsCache } from "../services/event.service.js";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai-service:8000";
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";
const SCRAPE_CRON = process.env.SCRAPE_CRON || "0 */8 * * *"; // every 8h
const SCRAPING_ENABLED = process.env.SCRAPING_ENABLED !== "false";

let _isRunning = false;

/**
 * Triggers one scraping cycle via the AI service HTTP endpoint.
 * Safe to call manually from a dev endpoint or cron.
 *
 * @returns {Promise<object>} summary returned by the AI service
 */
export const runScrapingCycle = async () => {
  if (_isRunning) {
    logger.info("[scrapeEvents] Previous cycle still running — skipping this trigger");
    return { skipped: true, reason: "already_running" };
  }

  _isRunning = true;
  const start = Date.now();

  try {
    logger.info("[scrapeEvents] Starting scraping cycle…");

    const headers = { "Content-Type": "application/json" };
    if (SCRAPER_API_KEY) {
      headers["X-Scraper-Key"] = SCRAPER_API_KEY;
    }

    const resp = await fetch(`${AI_SERVICE_URL}/scrape`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5-minute timeout
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(`[scrapeEvents] AI service responded ${resp.status}: ${body}`);
      return { error: `AI service error: ${resp.status}` };
    }

    const result = await resp.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.info(
      `[scrapeEvents] Cycle complete in ${elapsed}s — ` +
      `inserted=${result.inserted ?? 0}  upgraded=${result.upgraded ?? 0}  ` +
      `skipped=${result.skipped_duplicates ?? 0}  ` +
      `cleaned_up=${result.cleaned_up ?? 0}  total_scraped=${result.total_scraped ?? 0}  ` +
      `sources=${JSON.stringify(result.sources ?? {})}`
    );

    // Fresh Chapa / Eventbrite rows must appear immediately — bust list caches.
    if ((result.inserted ?? 0) > 0 || (result.upgraded ?? 0) > 0) {
      await warmEventsCache();
    }

    return result;
  } catch (err) {
    logger.error(`[scrapeEvents] Cycle failed: ${err.message}`);
    return { error: err.message };
  } finally {
    _isRunning = false;
  }
};

/**
 * Start the background cron scheduler for event scraping.
 *
 * Dynamically imports node-cron so the dependency is optional;
 * if not installed, logs a warning and returns.
 *
 * @returns {Promise<void>}
 */
export const startScrapeScheduler = async () => {
  if (!SCRAPING_ENABLED) {
    logger.info("[scrapeEvents] Scraping disabled (SCRAPING_ENABLED=false)");
    return;
  }

  let cron;
  try {
    cron = (await import("node-cron")).default;
  } catch {
    logger.warn(
      "[scrapeEvents] node-cron not installed — automatic scraping disabled. " +
      "Run: npm install node-cron  in the backend directory."
    );
    return;
  }

  if (!cron.validate(SCRAPE_CRON)) {
    logger.warn(`[scrapeEvents] Invalid cron expression "${SCRAPE_CRON}" — skipping scheduler`);
    return;
  }

  logger.info(`[scrapeEvents] Scheduler started (${SCRAPE_CRON}) — will trigger AI service scraping`);

  cron.schedule(SCRAPE_CRON, () => {
    runScrapingCycle().catch((err) =>
      logger.error(`[scrapeEvents] Unhandled error in cycle: ${err.message}`)
    );
  });

  // Run once on startup (after a short delay to let services initialise).
  setTimeout(() => {
    runScrapingCycle().catch((err) =>
      logger.warn(`[scrapeEvents] Startup scrape failed: ${err.message}`)
    );
  }, 30_000); // 30-second warm-up delay
};
