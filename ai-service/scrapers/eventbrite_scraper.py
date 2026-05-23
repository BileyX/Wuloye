"""
eventbrite_scraper.py — Scrapes public Eventbrite event listings for Ethiopia.

Uses the public search page (no API key required) and parses structured JSON-LD
data embedded in each event page. Falls back to HTML parsing when JSON-LD is
not available.
"""

import json
import logging
import re
import time

import requests
from bs4 import BeautifulSoup

from .base_scraper import BaseScraper, clean_text, normalise_category, parse_iso_date
from .image_helpers import sanitize_image_url

logger = logging.getLogger(__name__)

# Eventbrite public search pages for Ethiopian cities
SEARCH_URLS = [
    "https://www.eventbrite.com/d/ethiopia--addis-ababa/events/",
    "https://www.eventbrite.com/d/ethiopia/events/",
]

MAX_PAGES = 2        # pages per search URL
EVENTS_PER_PAGE = 20
DETAIL_TIMEOUT = 10  # seconds per detail fetch


class EventbriteScraper(BaseScraper):
    SOURCE_NAME = "eventbrite"

    def scrape(self) -> list[dict]:
        event_urls: list[str] = []
        for search_url in SEARCH_URLS:
            event_urls.extend(self._collect_listing_urls(search_url))
            time.sleep(1)

        # Deduplicate
        seen: set[str] = set()
        unique_urls = [u for u in event_urls if u not in seen and not seen.add(u)]  # type: ignore[func-returns-value]

        events: list[dict] = []
        for url in unique_urls[:40]:          # cap at 40 detail fetches
            event = self._fetch_event_detail(url)
            if event:
                events.append(event)
            time.sleep(0.8)

        logger.info("[eventbrite] Collected %d events from %d URLs", len(events), len(unique_urls))
        return events

    # ── Listing page ──────────────────────────────────────────────────────────

    def _collect_listing_urls(self, search_url: str) -> list[str]:
        urls: list[str] = []
        for page in range(1, MAX_PAGES + 1):
            page_url = search_url if page == 1 else f"{search_url}?page={page}"
            try:
                resp = requests.get(page_url, headers=self.DEFAULT_HEADERS, timeout=15)
                resp.raise_for_status()
            except requests.RequestException as exc:
                logger.warning("[eventbrite] Listing fetch failed (%s): %s", page_url, exc)
                break

            soup = BeautifulSoup(resp.text, "html.parser")

            # Eventbrite embeds a __NEXT_DATA__ JSON blob with event listings
            script = soup.find("script", id="__NEXT_DATA__")
            if script and script.string:
                try:
                    data = json.loads(script.string)
                    events_list = (
                        data.get("props", {})
                        .get("pageProps", {})
                        .get("serverPayload", {})
                        .get("events", [])
                    )
                    for ev in events_list:
                        link = ev.get("url", "")
                        if link and "eventbrite.com/e/" in link:
                            urls.append(link)
                    if urls:
                        logger.info("[eventbrite] Found %d URLs on page %d via __NEXT_DATA__", len(urls), page)
                        continue
                except (json.JSONDecodeError, AttributeError):
                    pass

            # Fallback: look for <a href> links to eventbrite event pages
            for a in soup.select("a[href*='/e/']"):
                href = a.get("href", "")
                if href and "eventbrite.com/e/" in href:
                    urls.append(href.split("?")[0])

            time.sleep(1)
        return urls

    # ── Detail page ───────────────────────────────────────────────────────────

    def _fetch_event_detail(self, url: str) -> dict | None:
        try:
            resp = requests.get(url, headers=self.DEFAULT_HEADERS, timeout=DETAIL_TIMEOUT)
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.debug("[eventbrite] Detail fetch failed (%s): %s", url, exc)
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        # Prefer JSON-LD structured data
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                ld = json.loads(script.string or "")
                if ld.get("@type") == "Event":
                    return self._parse_jsonld(ld, url)
            except (json.JSONDecodeError, AttributeError):
                continue

        # Fallback: parse HTML meta tags
        return self._parse_html_meta(soup, url)

    def _parse_jsonld(self, ld: dict, url: str) -> dict | None:
        title = clean_text(ld.get("name", ""))
        if not title:
            return None

        description = clean_text(ld.get("description", ""))
        date_str = ld.get("startDate", "")
        image = ""
        img = ld.get("image", "")
        if isinstance(img, list):
            image = img[0] if img else ""
        elif isinstance(img, str):
            image = img
        image = sanitize_image_url(image, url)

        location = "Addis Ababa"
        loc_obj = ld.get("location", {}) or {}
        if isinstance(loc_obj, dict):
            venue_name = loc_obj.get("name", "")
            addr = loc_obj.get("address", {})
            city = addr.get("addressLocality", "") if isinstance(addr, dict) else ""
            location = venue_name or city or "Addis Ababa"

        coords: dict = {}
        geo = loc_obj.get("geo", {}) if isinstance(loc_obj, dict) else {}
        if geo:
            try:
                coords = {"lat": float(geo["latitude"]), "lng": float(geo["longitude"])}
            except (KeyError, ValueError, TypeError):
                pass

        organizer = ""
        org_obj = ld.get("organizer") or {}
        if isinstance(org_obj, dict):
            organizer = clean_text(org_obj.get("name") or "")
        elif isinstance(org_obj, list) and org_obj:
            first = org_obj[0]
            if isinstance(first, dict):
                organizer = clean_text(first.get("name") or "")

        # JSON-LD Offer (https://schema.org/Offer)
        offers = ld.get("offers") or []
        if isinstance(offers, dict):
            offers = [offers]
        ticket_price = ""
        is_paid = False
        if isinstance(offers, list):
            for off in offers:
                if not isinstance(off, dict):
                    continue
                price = off.get("price")
                currency = (off.get("priceCurrency") or "").upper()
                if price not in (None, "", 0, "0", "0.0", "0.00"):
                    try:
                        pnum = float(price)
                        if pnum > 0:
                            is_paid = True
                            ticket_price = f"{currency or 'ETB'} {pnum:.0f}".strip()
                            break
                    except (TypeError, ValueError):
                        is_paid = True
                        ticket_price = str(price)
                        break

        category = normalise_category(f"{title} {description}")

        out = {
            "title": title,
            "description": description[:500],
            "location": location,
            "coordinates": coords,
            "date": parse_iso_date(date_str),
            "category": category,
            "image": image,
            "source_url": url,
            "source": self.SOURCE_NAME,
        }
        if organizer:
            out["organizer"] = organizer
        if ticket_price:
            out["ticket_price"] = ticket_price
        if is_paid:
            out["is_paid"] = True
        return out

    def _parse_html_meta(self, soup: BeautifulSoup, url: str) -> dict | None:
        def meta(name: str) -> str:
            tag = soup.find("meta", {"property": name}) or soup.find("meta", {"name": name})
            return clean_text(tag.get("content", "") if tag else "")

        title = meta("og:title") or clean_text(soup.title.string if soup.title else "")
        if not title:
            return None

        description = meta("og:description")
        image = sanitize_image_url(meta("og:image"), url)
        category = normalise_category(f"{title} {description}")

        return {
            "title": title,
            "description": description[:500],
            "location": "Addis Ababa",
            "date": "",
            "category": category,
            "image": image,
            "source_url": url,
            "source": self.SOURCE_NAME,
        }
