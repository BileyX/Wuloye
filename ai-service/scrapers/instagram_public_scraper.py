"""
instagram_public_scraper.py — OG/meta scrape for explicit Instagram post/reel URLs.

Instagram blocks anonymous scraping of profile feeds, but individual public
post / reel URLs expose limited metadata via og:image / og:description for
preview generation. This scraper reads URLs from:

  INSTAGRAM_PUBLIC_EVENT_URLS — newline-separated full post / reel URLs

Each is treated as a single event candidate. Empty env → scraper returns [].
"""

from __future__ import annotations

import logging
import os
import re
import time

import requests
from bs4 import BeautifulSoup

from .base_scraper import BaseScraper, clean_text, normalise_category
from .image_helpers import sanitize_image_url

logger = logging.getLogger(__name__)

_INSTAGRAM_HOSTS = ("instagram.com", "www.instagram.com")
_HANDLE_RE = re.compile(r"@([A-Za-z0-9._]{2,})")


class InstagramPublicLinkScraper(BaseScraper):
    SOURCE_NAME = "instagram_public"

    def scrape(self) -> list[dict]:
        raw = os.getenv("INSTAGRAM_PUBLIC_EVENT_URLS", "").strip()
        if not raw:
            logger.info("[instagram] INSTAGRAM_PUBLIC_EVENT_URLS not set — skipping")
            return []

        urls: list[str] = []
        for line in raw.splitlines():
            u = line.strip()
            if not u.startswith("http"):
                continue
            if not any(host in u for host in _INSTAGRAM_HOSTS):
                continue
            urls.append(u.split("?")[0])

        seen: set[str] = set()
        uniq = [u for u in urls if u not in seen and not seen.add(u)]  # type: ignore[func-returns-value]

        events: list[dict] = []
        for url in uniq[:25]:
            ev = self._fetch_public_post(url)
            if ev:
                events.append(ev)
            time.sleep(1.0)

        logger.info("[instagram] Parsed %d post-event(s)", len(events))
        return events

    def _fetch_public_post(self, url: str) -> dict | None:
        try:
            resp = requests.get(url, headers=self.DEFAULT_HEADERS, timeout=14)
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.debug("[instagram] fetch failed %s: %s", url, exc)
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        def meta(prop: str) -> str:
            tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
            return clean_text(tag.get("content") or "") if tag else ""

        title = meta("og:title")
        description = meta("og:description")
        image = sanitize_image_url(meta("og:image"), url)

        # Title for Instagram is typically "X on Instagram: 'caption…'"
        if "on Instagram" in title and ":" in title:
            handle_part, caption = title.split(":", 1)
            handle = handle_part.split(" on Instagram")[0].strip()
            caption_text = caption.strip().strip("\"'“”")
            if caption_text:
                title = caption_text[:160]
            if handle and not description:
                description = f"Posted by {handle}"

        if not title:
            return None

        organizer = ""
        m = _HANDLE_RE.search(description or "")
        if m:
            organizer = f"@{m.group(1)}"

        category = normalise_category(f"{title} {description}")

        out = {
            "title": title,
            "description": (description or "")[:800],
            "location": "Ethiopia",
            "date": "",  # IG posts don't expose a structured date
            "category": category,
            "image": image,
            "source_url": url,
            "source": self.SOURCE_NAME,
        }
        if organizer:
            out["organizer"] = organizer
        return out
