# scrapers package — registry-driven multi-source pipeline (see scraper_manager / registry)
from .alladdis_scraper import AllAddisScraper
from .chapa_scraper import ChapaEventsScraper
from .culture_venue_scraper import CultureVenueScraper
from .eth_local_scraper import EthLocalEventsScraper
from .eth_rss_scraper import EthRssScraper
from .eventbrite_scraper import EventbriteScraper
from .facebook_public_scraper import FacebookPublicLinkScraper
from .instagram_public_scraper import InstagramPublicLinkScraper
from .meetup_scraper import MeetupEthiopiaScraper
from .rss_feed_scraper import RssFeedScraper
from .telegram_scraper import TelegramScraper
from .whatsupaddis_scraper import WhatsUpAddisScraper

__all__ = [
    "AllAddisScraper",
    "ChapaEventsScraper",
    "CultureVenueScraper",
    "EthLocalEventsScraper",
    "EthRssScraper",
    "EventbriteScraper",
    "FacebookPublicLinkScraper",
    "InstagramPublicLinkScraper",
    "MeetupEthiopiaScraper",
    "RssFeedScraper",
    "TelegramScraper",
    "WhatsUpAddisScraper",
]
