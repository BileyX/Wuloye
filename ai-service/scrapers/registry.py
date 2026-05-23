"""
registry.py — Ordered list of event scraper classes with priority hints.

Higher *priority* numbers win when merging duplicate events (better metadata).
Failures are isolated per scraper in scraper_manager.
"""

from __future__ import annotations

from typing import Callable

from .alladdis_scraper import AllAddisScraper
from .eventbrite_scraper import EventbriteScraper
from .whatsupaddis_scraper import WhatsUpAddisScraper
from .telegram_scraper import TelegramScraper

# Optional / env-driven scrapers imported lazily to avoid hard deps at import time
from .meetup_scraper import MeetupEthiopiaScraper
from .rss_feed_scraper import RssFeedScraper
from .culture_venue_scraper import CultureVenueScraper
from .facebook_public_scraper import FacebookPublicLinkScraper
from .instagram_public_scraper import InstagramPublicLinkScraper
from .eth_local_scraper import EthLocalEventsScraper
from .eth_rss_scraper import EthRssScraper
from .chapa_scraper import ChapaEventsScraper

ScraperFactory = Callable[[], object]

# (priority, factory) — factory returns a scraper instance with .run()
# Higher priority = more authoritative source (wins on duplicate merge).
SCRAPER_FACTORIES: list[tuple[int, ScraperFactory]] = [
    (105, lambda: ChapaEventsScraper()),        # Chapa Events — Ethiopian ticketing platform (highest trust)
    (100, lambda: EventbriteScraper()),         # Eventbrite — structured global event platform
    (95, lambda: EthLocalEventsScraper()),      # Ethiopian institution websites
    (92, lambda: MeetupEthiopiaScraper()),      # Meetup.com Ethiopia groups
    (90, lambda: EthRssScraper()),              # Ethiopian news & event RSS feeds
    (88, lambda: AllAddisScraper()),            # AllAddisEvents
    (88, lambda: WhatsUpAddisScraper()),        # WhatsUpAddis
    (82, lambda: CultureVenueScraper()),        # British Council, ICC Addis, etc.
    (75, lambda: RssFeedScraper()),             # Custom env-configured RSS feeds
    (70, lambda: FacebookPublicLinkScraper()),  # Facebook public event pages
    (68, lambda: InstagramPublicLinkScraper()),
    # Broad Telegram harvest — lowest priority, highest volume
    (55, lambda: TelegramScraper()),
]


def iter_scraper_factories_ordered() -> list[tuple[int, ScraperFactory]]:
    return sorted(SCRAPER_FACTORIES, key=lambda x: -x[0])
