"""
eth_rss_scraper.py — Pre-configured RSS/Atom feeds for Ethiopian events and news.

Unlike rss_feed_scraper.py (which is purely env-driven), this scraper ships with
a built-in list of known Ethiopian feeds. Additional feeds can be appended via
the ETH_RSS_EXTRA_FEEDS environment variable (comma-separated URLs).

Only items that look event-like (contain event keywords or have a future date)
are kept. Items older than 21 days are silently dropped.
"""

from __future__ import annotations

import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from html import unescape

import requests

from .base_scraper import BaseScraper, clean_text, normalise_category, parse_iso_date
from .image_helpers import sanitize_image_url

logger = logging.getLogger(__name__)

# ─── Built-in Ethiopian RSS/Atom feeds ────────────────────────────────────────
BUILTIN_FEEDS: list[tuple[str, str]] = [
    ("zehabesha",          "https://www.zehabesha.com/category/news/feed/"),
    ("ethiopian_reporter", "https://www.thereporterethiopia.com/feed"),
    ("addis_standard",     "https://addisstandard.com/feed/"),
    ("fana_broadcast",     "https://www.fanabc.com/english/feed/"),
    ("sheger_news",        "https://shegerfm.com/feed/"),
    ("2merkato",           "https://www.2merkato.com/rss.xml"),
]

# Keywords that suggest an RSS item describes a real event (not just a news article)
EVENT_KEYWORDS = re.compile(
    r"\b(event|concert|festival|conference|workshop|seminar|summit|expo|fair|"
    r"ceremony|gala|show|performance|exhibition|lecture|hackathon|meetup|"
    r"tournament|match|game|competition|race|run|marathon|church|sunday|"
    r"service|prayer|worship|vigil|fasting|celebration|inauguration|launch)\b",
    re.IGNORECASE,
)

URL_IN_TEXT_RE = re.compile(r"https?://[^\s<>\"]+", re.I)


def _local(tag: str) -> str:
    return tag.split("}")[-1] if tag else ""


def _strip_tags(html: str) -> str:
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    return clean_text(unescape(text))


def _looks_like_event(title: str, description: str) -> bool:
    combined = f"{title} {description}"
    return bool(EVENT_KEYWORDS.search(combined))


def _is_recent(date_iso: str, max_days: int = 21) -> bool:
    if not date_iso:
        return True  # keep if no date
    try:
        dt = datetime.fromisoformat(date_iso.replace("Z", "+00:00"))
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_days)
        return dt >= cutoff
    except (ValueError, TypeError):
        return True


class EthRssScraper(BaseScraper):
    SOURCE_NAME = "eth_rss"

    def scrape(self) -> list[dict]:
        feeds: list[tuple[str, str]] = list(BUILTIN_FEEDS)

        extra_raw = os.getenv("ETH_RSS_EXTRA_FEEDS", "").strip()
        if extra_raw:
            for url in extra_raw.split(","):
                url = url.strip()
                if url.startswith("http"):
                    feeds.append(("extra", url))

        events: list[dict] = []
        for key, feed_url in feeds:
            try:
                batch = self._parse_feed(key, feed_url)
                logger.info("[eth_rss/%s] %d items kept", key, len(batch))
                events.extend(batch)
            except Exception as exc:
                logger.info("[eth_rss/%s] failed: %s", key, exc)
            time.sleep(1.0)

        logger.info("[eth_rss] Total event-like items: %d", len(events))
        return events

    def _parse_feed(self, key: str, feed_url: str) -> list[dict]:
        resp = requests.get(feed_url, headers=self.DEFAULT_HEADERS, timeout=18)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)

        items: list[dict] = []
        channel_title = key

        # RSS channel
        channel = None
        for el in root.iter():
            if _local(el.tag) == "channel":
                channel = el
                break

        if channel is not None:
            for child in channel:
                ln = _local(child.tag)
                if ln == "title" and child.text:
                    channel_title = clean_text(child.text)
                    break
            for child in channel:
                if _local(child.tag) == "item":
                    ev = self._rss_item(child, feed_url, key)
                    if ev:
                        items.append(ev)
            return items

        # Atom
        for entry in root.iter():
            if _local(entry.tag) == "entry":
                ev = self._atom_entry(entry, feed_url, key)
                if ev:
                    items.append(ev)

        return items

    def _rss_item(self, item, feed_url: str, key: str) -> dict | None:
        title = link = raw_desc = img = date_str = ""
        for child in item:
            ln = _local(child.tag)
            if ln == "title" and child.text:
                title = clean_text(child.text)
            elif ln == "link":
                link = (child.text or child.get("href") or "").strip()
            elif ln in ("description", "encoded"):
                raw_desc = child.text or ""
            elif ln in ("pubDate", "published", "date") and child.text:
                date_str = parse_iso_date(child.text.strip())
            elif ln == "thumbnail" and child.get("url"):
                img = sanitize_image_url(child.get("url", ""), link or feed_url)

        if not title or len(title) < 5:
            return None

        description = _strip_tags(raw_desc)[:600]

        if not _looks_like_event(title, description):
            return None
        if not _is_recent(date_str):
            return None

        if not img and raw_desc:
            m = re.search(r'src=["\'](https?://[^"\']+)["\']', raw_desc, re.I)
            if m:
                img = sanitize_image_url(m.group(1), link or feed_url)

        if not link:
            m = URL_IN_TEXT_RE.search(description)
            if m:
                link = m.group(0).rstrip(").,;")

        return {
            "title": title,
            "description": description,
            "location": "Ethiopia",
            "date": date_str,
            "category": normalise_category(f"{title} {description}"),
            "image": img,
            "source_url": link or feed_url,
            "source": f"eth_rss_{key}",
        }

    def _atom_entry(self, entry, feed_url: str, key: str) -> dict | None:
        title = link = summary = date_str = ""
        for child in entry:
            ln = _local(child.tag)
            if ln == "title" and child.text:
                title = clean_text(child.text)
            elif ln == "link" and child.get("href"):
                if not link or child.get("rel") in (None, "alternate"):
                    link = child.get("href") or ""
            elif ln in ("summary", "content"):
                summary = child.text or ""
            elif ln in ("published", "updated") and child.text:
                date_str = parse_iso_date(child.text.strip())

        if not title or len(title) < 5:
            return None

        description = _strip_tags(summary)[:600]
        if not _looks_like_event(title, description):
            return None
        if not _is_recent(date_str):
            return None

        return {
            "title": title,
            "description": description,
            "location": "Ethiopia",
            "date": date_str,
            "category": normalise_category(f"{title} {description}"),
            "image": "",
            "source_url": link or feed_url,
            "source": f"eth_rss_{key}",
        }
