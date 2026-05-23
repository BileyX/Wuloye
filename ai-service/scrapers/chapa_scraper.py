"""
chapa_scraper.py — Scraper for Chapa Events (chapa.events).

Chapa Events is an Ethiopian ticketing and events platform built on Inertia.js
(Laravel + Vue). It embeds all page data in a `data-page` HTML attribute as an
HTML-encoded JSON blob — no JavaScript execution needed.

Data extraction strategy:
  1. GET https://chapa.events?page={n}
  2. Parse the div[data-page] attribute → decode HTML entities → parse JSON.
  3. Events are in props.events.data[] — only keep status == "Available".
  4. Paginate up to MAX_PAGES to collect all upcoming events.

Key data fields extracted:
  - title (name)
  - description
  - image  → https://assets.chapa.co/customer-uploads/{image_filename}
  - place_name, place_link (Google Maps URL with ?q=lat,lng)
  - start_time / end_time (YYYY-MM-DD HH:MM:SS)
  - tickets_details[].price — lowest price = entry ticket price
  - slug → https://chapa.events/{slug}  (booking/detail URL)
  - status — "Available" or "Expired"
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup

from .base_scraper import BaseScraper, clean_text, normalise_category, is_past_event
from .image_helpers import sanitize_image_url

logger = logging.getLogger(__name__)

BASE_URL = "https://chapa.events"
IMAGE_CDN = "https://assets.chapa.co/customer-uploads"

# Maximum pages to scrape per run (9 events/page → 45 max events from Chapa)
MAX_PAGES = 5
# Coordinate extraction from Google Maps URL
COORDS_RE = re.compile(r"[?&]q=([-\d.]+),([-\d.]+)")


def _parse_coords(place_link: str) -> dict:
    """Extract {lat, lng} from a Google Maps ?q= URL, or return {}."""
    if not place_link:
        return {}
    m = COORDS_RE.search(place_link)
    if m:
        try:
            return {"lat": float(m.group(1)), "lng": float(m.group(2))}
        except ValueError:
            pass
    return {}


def _lowest_price(tickets_details: list) -> tuple[str, bool]:
    """
    Return (ticket_price_str, is_paid) from the tickets_details array.
    Picks the lowest non-zero price.
    """
    prices: list[float] = []
    for t in tickets_details or []:
        try:
            p = float(t.get("price") or 0)
            if p > 0:
                prices.append(p)
        except (TypeError, ValueError):
            pass
    if not prices:
        return ("", False)
    lowest = min(prices)
    return (f"ETB {lowest:,.0f}", True)


def _parse_chapa_datetime(dt_str: str) -> str:
    """
    Convert "2026-06-05 17:00:00" → ISO-8601 UTC string.
    Chapa stores times in Africa/Addis_Ababa (EAT = UTC+3).
    """
    if not dt_str:
        return ""
    formats = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"]
    for fmt in formats:
        try:
            # Treat as local EAT (UTC+3) and convert to UTC
            naive = datetime.strptime(dt_str.strip(), fmt)
            # Subtract 3 hours to get UTC, then make UTC-aware
            from datetime import timedelta
            utc_dt = naive - timedelta(hours=3)
            return utc_dt.replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return dt_str  # return as-is if unparseable


def _extract_page_events(soup: BeautifulSoup) -> tuple[list[dict], int]:
    """
    Parse Inertia.js data-page attribute.
    Returns (events_list, last_page_number).
    """
    div = soup.find("div", attrs={"data-page": True})
    if not div:
        logger.warning("[chapa] No div[data-page] found on page")
        return [], 1

    raw = div.get("data-page", "")
    if not raw:
        return [], 1

    try:
        data = json.loads(unescape(raw))
    except (json.JSONDecodeError, Exception) as exc:
        logger.warning("[chapa] Failed to parse data-page JSON: %s", exc)
        return [], 1

    props = data.get("props", {})
    events_paginated = props.get("events", {})

    if not isinstance(events_paginated, dict):
        return [], 1

    event_data = events_paginated.get("data", [])
    last_page = int(events_paginated.get("last_page") or 1)
    return event_data, last_page


class ChapaEventsScraper(BaseScraper):
    """
    Scrapes chapa.events for upcoming Ethiopian events.
    Trusted source — high priority, rich structured data.
    """

    SOURCE_NAME = "chapa_events"

    def scrape(self) -> list[dict]:
        all_raw: list[dict] = []

        for page_num in range(1, MAX_PAGES + 1):
            url = f"{BASE_URL}?page={page_num}"
            try:
                resp = requests.get(url, headers=self.DEFAULT_HEADERS, timeout=20)
                resp.raise_for_status()
            except requests.RequestException as exc:
                logger.warning("[chapa] Page %d fetch failed: %s", page_num, exc)
                break

            soup = BeautifulSoup(resp.text, "html.parser")
            raw_events, last_page = _extract_page_events(soup)

            if not raw_events:
                logger.info("[chapa] Page %d returned no events — stopping", page_num)
                break

            # Filter: only keep "Available" (upcoming) events
            upcoming = [e for e in raw_events if e.get("status") == "Available"]
            logger.info(
                "[chapa] Page %d/%d: %d events, %d upcoming",
                page_num, last_page, len(raw_events), len(upcoming),
            )
            all_raw.extend(upcoming)

            # Stop early if no upcoming events found on this page
            # (listing is newest-first, so once we hit all-expired we can stop)
            if not upcoming and page_num > 1:
                logger.info("[chapa] No upcoming events on page %d — stopping early", page_num)
                break

            if page_num >= last_page:
                break

            time.sleep(1.5)

        logger.info("[chapa] Total upcoming events collected: %d", len(all_raw))
        return [self._transform(ev) for ev in all_raw if ev]

    def _transform(self, ev: dict) -> dict:
        """Convert a raw Chapa API event dict to our normalised schema."""
        title = clean_text(ev.get("name") or "")
        description = clean_text(ev.get("description") or "")
        slug = ev.get("slug") or ""
        ref_id = ev.get("ref_id") or ""

        # Image — request a large version via the Chapa CDN resize endpoint
        img_filename = (ev.get("image") or "").strip()
        if img_filename:
            # If the filename already contains a full URL or path prefix, use as-is
            if img_filename.startswith("http"):
                image = img_filename
            else:
                image = f"{IMAGE_CDN}/{img_filename}"
        else:
            image = ""

        # Location + coordinates
        place_name = clean_text(ev.get("place_name") or "Addis Ababa")
        place_link = ev.get("place_link") or ""
        coords = _parse_coords(place_link)

        # Dates
        start_iso = _parse_chapa_datetime(ev.get("start_time") or "")
        end_iso = _parse_chapa_datetime(ev.get("end_time") or "")

        # Skip if start date is in the past (belt-and-suspenders check)
        if start_iso and is_past_event(start_iso, grace_days=0):
            logger.debug("[chapa] Skipping past event: %s (%s)", title[:50], start_iso[:10])
            return {}

        # Price
        tickets = ev.get("tickets_details") or []
        ticket_price, is_paid = _lowest_price(tickets)

        # Booking URL
        source_url = f"{BASE_URL}/{slug}" if slug else BASE_URL

        # Organiser — Chapa doesn't expose organiser name directly; use contact info
        contact_info = clean_text(ev.get("contact_info") or "")

        # Category from title + description
        category = normalise_category(f"{title} {description}")

        return {
            "title": title,
            "description": description[:600],
            "location": place_name,
            "coordinates": coords,
            "date": start_iso,
            "end_date": end_iso,
            "category": category,
            "image": image,
            "source_url": source_url,
            "booking_url": source_url,
            "source": self.SOURCE_NAME,
            "is_paid": is_paid,
            "ticket_price": ticket_price,
            "organizer": contact_info[:120] if contact_info else "",
            "chapa_ref_id": ref_id,
            "is_featured": bool(ev.get("is_featured")),
        }

    def run(self) -> list[dict]:
        """Override run() to handle our custom _transform returning {} on skip."""
        try:
            raw_events = self.scrape()
        except Exception as exc:
            logger.error("[%s] scrape() failed: %s", self.SOURCE_NAME, exc)
            return []

        normalised = []
        for raw in raw_events:
            if not raw:
                continue
            event = self._normalise(raw)
            if event and self._is_quality_event(event):
                normalised.append(event)

        logger.info("[%s] scraped %d valid event(s)", self.SOURCE_NAME, len(normalised))
        return normalised
