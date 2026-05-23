"""
eth_local_scraper.py — Scraper for Ethiopian local event listing pages.

Covers Ethiopian university pages, cultural organisations, city event listings,
and hospitality venues that publish HTML event calendars. All targets use simple
HTML (no JavaScript rendering required) and are scraped with a polite delay.
"""

from __future__ import annotations

import logging
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from .base_scraper import BaseScraper, clean_text, normalise_category, parse_iso_date
from .image_helpers import (
    extract_image_from_img_tag,
    pick_best_image_from_container,
    sanitize_image_url,
    is_usable_event_image,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Curated list of Ethiopian event pages.
# Format: (source_key, listing_url, selector_hints)
# selector_hints — CSS selectors tried in order to find event cards / entries.
# ---------------------------------------------------------------------------
ETH_SOURCES: list[tuple[str, str, list[str]]] = [
    (
        "addis_chamber",
        "https://addischamber.com/events/",
        ["article.event", ".event-card", "article", ".tribe-event", ".type-tribe_events"],
    ),
    (
        "aau_events",
        "https://www.aau.edu.et/events/",
        ["article", ".event", ".events-list li", ".tribe-event", ".type-tribe_events"],
    ),
    (
        "ebs_events",
        "https://ebstv.net/category/events/",
        ["article", ".post", ".card"],
    ),
    (
        "zehabesha_events",
        "https://www.zehabesha.com/category/events/",
        ["article", ".post", "h2 a", ".entry-title a"],
    ),
    (
        "ethiopian_reporter_events",
        "https://www.thereporterethiopia.com/category/events",
        ["article", ".post", ".news-item"],
    ),
    (
        "sheger_news",
        "https://shegerfm.com/entertainment/",
        ["article", ".post", ".entry"],
    ),
    (
        "british_council_et",
        "https://www.britishcouncil.et/en/events",
        ["article", ".event", ".event-card", ".views-row"],
    ),
    (
        "icc_addis",
        "https://iccaddis.org/events/",
        ["article", ".event", ".tribe_events_cat", ".type-tribe_events"],
    ),
    (
        "giz_ethiopia",
        "https://www.giz.de/en/worldwide/369.html",
        ["article", ".event-teaser", ".teaser-item"],
    ),
    (
        "un_ethiopia_events",
        "https://ethiopia.un.org/en/events",
        ["article", ".views-row", ".event", "li.event"],
    ),
]

KNOWN_VENUES: dict[str, dict] = {
    "millennium hall":  {"lat": 9.0168, "lng": 38.7619},
    "skylight hotel":   {"lat": 9.0200, "lng": 38.7550},
    "sheraton":         {"lat": 9.0194, "lng": 38.7624},
    "hyatt":            {"lat": 9.0134, "lng": 38.7614},
    "hilton":           {"lat": 9.0097, "lng": 38.7624},
    "intercontinental": {"lat": 9.0145, "lng": 38.7622},
    "national theatre": {"lat": 9.0236, "lng": 38.7465},
    "unity park":       {"lat": 9.0271, "lng": 38.7636},
    "elilly":           {"lat": 9.0240, "lng": 38.7740},
    "ramada":           {"lat": 9.0192, "lng": 38.7814},
    "addis ababa":      {"lat": 9.0320, "lng": 38.7469},
    "bole":             {"lat": 9.0096, "lng": 38.7978},
    "piassa":           {"lat": 9.0397, "lng": 38.7529},
    "4 kilo":           {"lat": 9.0376, "lng": 38.7611},
    "megenagna":        {"lat": 9.0218, "lng": 38.8125},
}


def _resolve_coords(text: str) -> dict:
    lower = text.lower()
    for kw, coords in KNOWN_VENUES.items():
        if kw in lower:
            return coords
    return {"lat": 9.0320, "lng": 38.7469}


def _base_url(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


class EthLocalEventsScraper(BaseScraper):
    SOURCE_NAME = "eth_local"

    def scrape(self) -> list[dict]:
        all_events: list[dict] = []
        for src_key, url, selectors in ETH_SOURCES:
            try:
                batch = self._scrape_source(src_key, url, selectors)
                logger.info("[eth_local/%s] %d events", src_key, len(batch))
                all_events.extend(batch)
            except Exception as exc:
                logger.info("[eth_local/%s] skip (%s): %s", src_key, url, exc)
            time.sleep(float(1.5))

        logger.info("[eth_local] Total: %d events", len(all_events))
        return all_events

    def _scrape_source(self, src_key: str, page_url: str, selectors: list[str]) -> list[dict]:
        resp = requests.get(page_url, headers=self.DEFAULT_HEADERS, timeout=18)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        base = _base_url(page_url)

        cards = []
        for sel in selectors:
            cards = soup.select(sel)
            if cards:
                break

        if not cards:
            logger.debug("[eth_local/%s] No cards found with selectors %s", src_key, selectors)
            return []

        events: list[dict] = []
        for card in cards[:20]:
            try:
                ev = self._parse_card(card, page_url, base, src_key)
                if ev:
                    events.append(ev)
            except Exception as exc:
                logger.debug("[eth_local/%s] card parse error: %s", src_key, exc)

        return events

    def _parse_card(self, card, page_url: str, base: str, src_key: str) -> dict | None:
        # Title
        title_el = (
            card.select_one("h1") or card.select_one("h2") or card.select_one("h3")
            or card.select_one(".title") or card.select_one(".entry-title")
            or card.select_one("a")
        )
        title = clean_text(title_el.get_text()) if title_el else ""
        if len(title) < 5:
            return None

        # Source URL
        link_el = card.select_one("a[href]")
        source_url = page_url
        if link_el and link_el.get("href"):
            href = link_el["href"].strip()
            source_url = href if href.startswith("http") else urljoin(base + "/", href.lstrip("/"))

        # Date
        date_el = (
            card.select_one("time") or card.select_one(".event-date")
            or card.select_one(".date") or card.select_one("[class*='date']")
            or card.select_one("[datetime]")
        )
        raw_date = ""
        if date_el:
            raw_date = date_el.get("datetime") or clean_text(date_el.get_text())

        # Location
        loc_el = (
            card.select_one(".event-location") or card.select_one(".location")
            or card.select_one("[class*='location']") or card.select_one("[class*='venue']")
        )
        location = clean_text(loc_el.get_text()) if loc_el else "Addis Ababa"

        # Description
        desc_el = (
            card.select_one(".event-description") or card.select_one(".description")
            or card.select_one("p") or card.select_one(".entry-content")
            or card.select_one(".excerpt")
        )
        description = clean_text(desc_el.get_text()) if desc_el else ""

        # Image
        img_el = card.select_one("img")
        image = extract_image_from_img_tag(img_el, base) if img_el else ""
        if not image:
            image = pick_best_image_from_container(card, base)

        # OG image for link cards that have no embedded image
        if not is_usable_event_image(image) and source_url and source_url != page_url:
            og_meta = card.select_one("meta[property='og:image']")
            if og_meta and og_meta.get("content"):
                image = sanitize_image_url(og_meta["content"], base)

        category = normalise_category(f"{title} {description}")
        coords = _resolve_coords(location)

        return {
            "title": title,
            "description": description[:500],
            "location": location or "Addis Ababa",
            "coordinates": coords,
            "date": parse_iso_date(raw_date) if raw_date else "",
            "category": category,
            "image": image,
            "source_url": source_url,
            "source": f"eth_local_{src_key}",
        }
