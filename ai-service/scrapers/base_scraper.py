"""
base_scraper.py — Abstract base class for all event scrapers.

Every scraper must implement `scrape() -> list[dict]` and return
normalised event dicts matching the shared schema.
"""

import re
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone

from .image_helpers import sanitize_image_url

logger = logging.getLogger(__name__)

VALID_CATEGORIES = {
    "music", "tech", "church", "fitness", "business",
    "food", "art", "sports", "education", "social", "other",
}

_EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"
    "\U0001F300-\U0001F5FF"
    "\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF"
    "\U00002702-\U000027B0"
    "\U000024C2-\U0001F251"
    "]+",
    flags=re.UNICODE,
)
_WHITESPACE_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = _EMOJI_RE.sub("", text)
    text = _WHITESPACE_RE.sub(" ", text)
    return text.strip()


def normalise_category(raw: str) -> str:
    """
    Classify event text into one of VALID_CATEGORIES using a weighted scoring
    approach so context (e.g. "tech conference") wins over a single keyword.
    Returns the highest-scoring category, or "other" when nothing matches.
    """
    if not raw:
        return "other"
    r = raw.lower()

    # Hard-block: clearly sports venue + sports keywords
    if any(k in r for k in ("gymnasium", "stadium", "arena", "pitch", "court")):
        if any(k in r for k in ("basketball", "football", "volleyball", "tennis",
                                 "match", "league", "tournament", "athletics")):
            return "sports"

    # Hard-block: mental health / wellbeing  → education (not music/tech)
    if any(k in r for k in ("healing", "therapy", "psychological", "psychology",
                             "counsell", "mental health", "behavioural addiction")):
        return "education"

    # Hard-block: explicitly religious terms
    if any(k in r for k in ("debre", "kidus", "kidist", "timkat", "meskel",
                             "masjid", "mesjid", "quran", "salah")):
        return "church"

    # Weighted scoring — each (keyword, category, weight) tuple
    WEIGHTED: list[tuple[str, str, int]] = [
        # Music
        ("concert", "music", 5), ("live music", "music", 6), ("dj set", "music", 6),
        ("dj", "music", 3), ("band", "music", 4), ("festival", "music", 3),
        ("afrobeats", "music", 6), ("jazz", "music", 6), ("hip hop", "music", 5),
        ("open mic", "music", 5), ("musician", "music", 4), ("singer", "music", 4),
        ("performance", "music", 2), ("choir", "music", 5), ("album", "music", 4),
        # Tech
        ("hackathon", "tech", 7), ("developer", "tech", 6), ("software", "tech", 6),
        ("coding", "tech", 6), ("programming", "tech", 6), ("startup", "tech", 5),
        ("tech conference", "tech", 8), ("ai summit", "tech", 8), ("cloud", "tech", 4),
        ("cybersecurity", "tech", 7), ("data science", "tech", 7), ("python", "tech", 5),
        ("machine learning", "tech", 7), ("devops", "tech", 6), ("fintech", "tech", 5),
        ("aws", "tech", 5), ("google", "tech", 3), ("blockchain", "tech", 5),
        ("open source", "tech", 5), ("github", "tech", 5),
        # Business
        ("networking", "business", 5), ("entrepreneurship", "business", 6),
        ("pitch", "business", 5), ("investor", "business", 6), ("conference", "business", 3),
        ("seminar", "business", 3), ("summit", "business", 3), ("expo", "business", 3),
        ("trade fair", "business", 6), ("leadership", "business", 5),
        ("management", "business", 4), ("career fair", "business", 6),
        # Education
        ("workshop", "education", 4), ("seminar", "education", 3), ("training", "education", 4),
        ("masterclass", "education", 6), ("webinar", "education", 5), ("class", "education", 3),
        ("lecture", "education", 5), ("course", "education", 5), ("learn", "education", 3),
        ("skill", "education", 3), ("certification", "education", 6),
        # Sports
        ("marathon", "sports", 7), ("football", "sports", 6), ("basketball", "sports", 6),
        ("volleyball", "sports", 6), ("tennis", "sports", 6), ("athletics", "sports", 6),
        ("cycling race", "sports", 7), ("swimming", "sports", 6), ("league", "sports", 5),
        ("tournament", "sports", 5), ("match", "sports", 4), ("boxing", "sports", 7),
        ("karate", "sports", 7), ("taekwondo", "sports", 7), ("sport", "sports", 4),
        # Fitness
        ("yoga", "fitness", 7), ("gym", "fitness", 5), ("pilates", "fitness", 7),
        ("zumba", "fitness", 7), ("aerobics", "fitness", 7), ("run club", "fitness", 7),
        ("5k", "fitness", 6), ("10k", "fitness", 6), ("workout", "fitness", 5),
        ("fitness", "fitness", 6), ("wellness retreat", "fitness", 7),
        ("boot camp", "fitness", 6), ("crossfit", "fitness", 7),
        # Church / Religious
        ("worship", "church", 6), ("gospel", "church", 6), ("prayer", "church", 6),
        ("church service", "church", 8), ("sunday service", "church", 8),
        ("fasting", "church", 5), ("revival", "church", 6), ("crusade", "church", 7),
        ("islamic", "church", 6), ("ramadan", "church", 6), ("eid", "church", 5),
        ("friday prayer", "church", 8), ("mosque", "church", 7), ("cathedral", "church", 6),
        ("protestant", "church", 6), ("orthodox", "church", 6), ("catholic", "church", 6),
        # Food
        ("food festival", "food", 8), ("wine tasting", "food", 8), ("brunch", "food", 7),
        ("restaurant", "food", 5), ("dining", "food", 5), ("coffee", "food", 4),
        ("cafe", "food", 4), ("culinary", "food", 7), ("chef", "food", 5),
        ("baking", "food", 6), ("cocktail", "food", 5), ("beer", "food", 4),
        # Art
        ("gallery", "art", 7), ("exhibition", "art", 7), ("art show", "art", 8),
        ("museum", "art", 6), ("painting", "art", 7), ("sculpture", "art", 7),
        ("photography", "art", 6), ("film", "art", 4), ("fashion show", "art", 6),
        ("design", "art", 4), ("creative", "art", 3), ("theater", "art", 6),
        ("theatre", "art", 6), ("poetry", "art", 6), ("spoken word", "art", 7),
        ("dance", "art", 4),
        # Social
        ("networking event", "social", 8), ("community", "social", 4),
        ("meetup", "social", 5), ("social", "social", 4), ("party", "social", 5),
        ("celebration", "social", 5), ("gathering", "social", 4),
        ("speed dating", "social", 8), ("board game", "social", 6),
        ("book club", "social", 7),
    ]

    scores: dict[str, int] = {}
    for keyword, category, weight in WEIGHTED:
        if keyword in r:
            scores[category] = scores.get(category, 0) + weight

    if scores:
        best = max(scores, key=lambda c: scores[c])
        # Require a minimum confidence gap for ambiguous matches
        sorted_scores = sorted(scores.values(), reverse=True)
        if len(sorted_scores) == 1 or sorted_scores[0] >= sorted_scores[1] + 2:
            return best
        # Tiebreak: prefer the higher-weighted category
        return best

    # Exact VALID_CATEGORIES match as last resort
    for cat in VALID_CATEGORIES:
        if cat in r:
            return cat

    return "other"


# ─── Price / organizer extraction (run after scrape, before persist) ──────────

_FREE_RE = re.compile(
    r"\b(free\s+(?:entry|admission|event)|no\s+cover|gratis|free\s+for\s+all|complimentary)\b",
    re.IGNORECASE,
)

# ETB 500 · 500 ETB · 500 birr · Br 500 · $20 · 20 USD · 1,500 ETB
_PRICE_RE = re.compile(
    r"(?:(?:ETB|BIRR|BR|USD|EUR)\s*[:\-]?\s*([\d][\d,\.]{0,9}))"
    r"|(?:([\d][\d,\.]{0,9})\s*(?:ETB|BIRR|BR|USD|EUR)\b)"
    r"|(?:\$\s*([\d][\d,\.]{0,9}))",
    re.IGNORECASE,
)

# Luxury / premium venue hints — bump price tier up
_LUXURY_HINTS = (
    "sheraton", "hyatt", "hilton", "marriott", "skylight",
    "ramada", "intercontinental", "elilly", "rooftop", "vip",
    "premium", "luxury", "gala", "fine dining", "private jet",
)
# Cheap venue / community hints — bump price tier down
_CHEAP_HINTS = (
    "community", "youth", "church", "mosque", "campus", "library",
    "park", "free", "open mic", "potluck", "meetup", "hackerspace",
    "school", "university hall",
)


def extract_organizer(text: str) -> str:
    """Find an "Organised by", "Hosted by", "Presented by" line in description text."""
    if not text:
        return ""
    for pat in (
        r"(?:organi[sz]ed|presented|hosted|brought to you)\s+by[\s:]+([^\n\.]{3,80})",
        r"\borganizer[:\-]\s*([^\n\.]{3,80})",
    ):
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return clean_text(m.group(1)).strip(" .,-")
    return ""


def extract_ticket_price(text: str) -> tuple[bool, str]:
    """Returns (is_paid, display_price). Detects free events and numeric prices."""
    if not text:
        return False, ""
    if _FREE_RE.search(text):
        return False, "Free"
    m = _PRICE_RE.search(text)
    if not m:
        return False, ""
    raw = next((g for g in m.groups() if g), "")
    if not raw:
        return False, ""
    cleaned = raw.replace(",", "").rstrip(".")
    try:
        value = float(cleaned)
    except ValueError:
        return True, raw
    if value <= 0:
        return False, "Free"
    upper = text.upper()
    if "$" in text or "USD" in upper:
        return True, f"USD {int(round(value))}"
    return True, f"ETB {int(round(value))}"


def estimate_price_tier(*, ticket_price: str, location: str, description: str,
                        category: str, source: str) -> str:
    """Heuristic budget tier (cheap | mid | expensive) using price + venue + category."""
    text = f"{location} {description} {category} {source}".lower()
    price_etb: float | None = None
    if ticket_price:
        if ticket_price.lower().startswith("free"):
            price_etb = 0.0
        else:
            m = re.search(r"([\d][\d,\.]*)", ticket_price)
            if m:
                try:
                    val = float(m.group(1).replace(",", ""))
                    if "usd" in ticket_price.lower() or "$" in ticket_price:
                        val *= 130.0  # rough conversion for tier purposes only
                    price_etb = val
                except ValueError:
                    pass

    if price_etb is not None:
        if price_etb <= 0:
            return "cheap"
        if price_etb < 500:
            return "cheap"
        if price_etb < 2500:
            return "mid"
        return "expensive"

    if any(h in text for h in _LUXURY_HINTS):
        return "expensive"
    if any(h in text for h in _CHEAP_HINTS):
        return "cheap"
    if category in ("tech", "education", "social", "business"):
        return "mid"
    return "mid"


_DEFAULT_FUTURE_DAYS = 7   # When date is completely missing, assume event is ~1 week away
_MAX_PAST_DAYS = 1         # Reject events more than 1 day in the past

def parse_iso_date(raw: str) -> str:
    """
    Parse an event date string to ISO-8601.

    Strategy:
    - Empty / missing date → default to now+7 days so the event stays "upcoming".
    - Parseable date → use as-is (even if past — caller can reject post-facto).
    - Unparseable non-empty string → default to now+3 days (some info existed).

    Never returns bare "now" because that immediately expires in Firestore queries.
    """
    now = datetime.now(timezone.utc)
    if not raw:
        return (now + timedelta(days=_DEFAULT_FUTURE_DAYS)).isoformat()

    # If the input already looks like an ISO string (from a previous parse),
    # validate it with fromisoformat first to avoid re-parsing and truncation.
    cleaned = clean_text(raw)
    if "T" in cleaned and len(cleaned) >= 10:
        try:
            dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except (ValueError, TypeError):
            pass

    formats = [
        "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
        "%d/%m/%Y", "%B %d, %Y", "%b %d, %Y",
        "%d %B %Y", "%d %b %Y",
        "%A, %B %d, %Y", "%A %d %B %Y",
        "%d-%m-%Y", "%m/%d/%Y",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(cleaned, fmt)
            return dt.replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue

    logger.debug("Could not parse date '%s' — using now+3d", raw)
    return (now + timedelta(days=3)).isoformat()


def is_past_event(date_iso: str, grace_days: int = _MAX_PAST_DAYS) -> bool:
    """True when the event date is earlier than now minus grace_days."""
    if not date_iso:
        return False
    try:
        dt = datetime.fromisoformat(date_iso.replace("Z", "+00:00"))
        cutoff = datetime.now(timezone.utc) - timedelta(days=grace_days)
        return dt < cutoff
    except (ValueError, TypeError):
        return False


class BaseScraper(ABC):
    SOURCE_NAME: str = "unknown"

    DEFAULT_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    @abstractmethod
    def scrape(self) -> list[dict]:
        """Fetch and return a list of raw event dicts."""

    def _normalise(self, raw: dict) -> dict | None:
        title = clean_text(raw.get("title", ""))
        if not title:
            return None

        location = clean_text(raw.get("location", "Addis Ababa")) or "Addis Ababa"
        date_str = parse_iso_date(raw.get("date", ""))
        category = normalise_category(raw.get("category", ""))
        description = clean_text(raw.get("description", ""))
        source_url = raw.get("source_url", "") or ""
        base_for_img = source_url if isinstance(source_url, str) and source_url.startswith("http") else ""
        image = sanitize_image_url(raw.get("image", "") or "", base_for_img)

        coords = raw.get("coordinates") or {}
        coordinates = {
            "lat": float(coords.get("lat", 9.0320)),
            "lng": float(coords.get("lng", 38.7469)),
        }

        # Scrapers can set a more specific "source" per-event (e.g. per Telegram
        # channel); fall back to the class-level SOURCE_NAME when not provided.
        source = clean_text(raw.get("source", "")) or self.SOURCE_NAME

        # Organizer — prefer explicit field, then sniff prose
        organizer = clean_text(raw.get("organizer", "")) or extract_organizer(
            f"{title}\n{description}"
        )

        # Ticket price — prefer explicit field, then sniff prose
        is_paid = bool(raw.get("is_paid"))
        ticket_price = clean_text(raw.get("ticket_price", ""))
        if not ticket_price:
            sniffed_paid, sniffed_price = extract_ticket_price(
                f"{title}\n{description}"
            )
            if sniffed_price:
                ticket_price = sniffed_price
                is_paid = sniffed_paid or is_paid

        price_tier = clean_text(raw.get("price_tier", "")) or estimate_price_tier(
            ticket_price=ticket_price,
            location=location,
            description=description,
            category=category,
            source=source,
        )

        doc = {
            "title": title,
            "description": description,
            "location": location,
            "coordinates": coordinates,
            "date": date_str,
            "category": category,
            "image": image,
            "source_url": source_url,
            "source": source,
            "is_paid": bool(is_paid),
            "price_tier": price_tier,
        }
        if ticket_price:
            doc["ticket_price"] = ticket_price
        if organizer:
            doc["organizer"] = organizer

        # Pass through optional extended fields from high-fidelity scrapers
        booking_url = raw.get("booking_url") or ""
        if booking_url and booking_url.startswith("http"):
            doc["booking_url"] = booking_url
        end_date = raw.get("end_date") or ""
        if end_date:
            doc["end_date"] = end_date
        chapa_ref = raw.get("chapa_ref_id") or ""
        if chapa_ref:
            doc["chapa_ref_id"] = chapa_ref
        if raw.get("is_featured"):
            doc["is_featured"] = True

        return doc

    # Words that suggest a message is not a real event (ad, forward, spam)
    _NON_EVENT_WORDS = frozenset([
        "click here", "subscribe", "follow us", "dm us", "send us",
        "check out our", "buy now", "order now", "promo code", "discount",
        "giveaway winner", "repost", "share this", "spread the word",
        "telegram channel", "join our channel", "مباشر", "يوتيوب",
    ])

    def _is_quality_event(self, event: dict) -> bool:
        """Return True only when the event passes minimum quality checks."""
        title = event.get("title", "")
        if len(title) < 5:
            return False
        if len(title) > 300:
            return False
        text_lower = f"{title} {event.get('description', '')}".lower()
        if any(w in text_lower for w in self._NON_EVENT_WORDS):
            return False
        # Reject if the "title" is just a URL
        if title.strip().startswith("http"):
            return False
        # Reject events whose date is more than 1 day in the past
        date = event.get("date", "")
        if date and is_past_event(date, grace_days=1):
            logger.debug("[%s] Skipping past event: %s (date=%s)", self.SOURCE_NAME, title[:50], date[:10])
            return False
        return True

    def run(self) -> list[dict]:
        try:
            raw_events = self.scrape()
        except Exception as exc:
            logger.error("[%s] scrape() failed: %s", self.SOURCE_NAME, exc)
            return []

        normalised = []
        for raw in raw_events:
            event = self._normalise(raw)
            if event and self._is_quality_event(event):
                normalised.append(event)

        logger.info("[%s] scraped %d valid event(s)", self.SOURCE_NAME, len(normalised))
        return normalised
