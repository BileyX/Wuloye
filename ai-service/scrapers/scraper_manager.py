"""
scraper_manager.py — Orchestrates registered scrapers with isolation, dedup,
source-aware merging, and og:image back-fill for missing thumbnails.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from store.firebase_client import get_firestore

from .base_scraper import clean_text, is_past_event
from .image_helpers import fetch_og_image, is_usable_event_image
from .registry import iter_scraper_factories_ordered

logger = logging.getLogger(__name__)

EVENTS_COLLECTION = "events"

REG_URL_RE = re.compile(r"https?://[^\s)\]>]+", re.I)
REG_HINTS = (
    "ticket",
    "register",
    "rsvp",
    "eventbrite",
    "luma.",
    "meetup.com",
    "booking",
    "checkout",
    "seat",
)


def _norm_title(title: str) -> str:
    t = clean_text(title).lower()
    t = re.sub(r"[^\w\s]", " ", t)
    return " ".join(t.split())


def _norm_loc(location: str) -> str:
    return " ".join(clean_text(location).lower().split())[:120]


def _date_bucket(date_iso: str) -> str:
    if not date_iso:
        return ""
    return date_iso[:10] if len(date_iso) >= 10 else ""


def _make_hash(title: str, date: str, location: str) -> str:
    raw = f"{_norm_title(title)}|{_date_bucket(date)}|{_norm_loc(location)}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _event_identity_hash(event: dict) -> str:
    """Stable hash for dedup — Chapa ref_id gets its own key to avoid Telegram collisions."""
    ref = clean_text(event.get("chapa_ref_id") or "")
    if ref:
        return hashlib.md5(f"chapa:{ref}".encode("utf-8")).hexdigest()
    return _make_hash(
        event.get("title", ""),
        event.get("date", ""),
        event.get("location", ""),
    )


def _legacy_make_hash(title: str, date: str, location: str) -> str:
    """Previous Firestore hash — matches older rows so we avoid duplicate inserts."""
    raw = f"{title.lower().strip()}|{date[:10]}|{location.lower().strip()}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _source_priority(source: str) -> int:
    s = (source or "").lower()
    if "chapa_events" in s:
        return 105
    if "eventbrite" in s:
        return 100
    if "eth_local" in s:
        return 95
    if s.startswith("meetup"):
        return 92
    if "eth_rss" in s:
        return 90
    if "alladdis" in s:
        return 88
    if "whatsup" in s:
        return 88
    if "culture_venue" in s:
        return 82
    if s.startswith("rss_feed"):
        return 75
    if "facebook_public" in s:
        return 72
    if "instagram_public" in s:
        return 70
    if s.startswith("telegram_"):
        return 55
    return 45


def extract_registration_urls(description: str, source_url: str) -> list[str]:
    text = description or ""
    found = REG_URL_RE.findall(text)
    out: list[str] = []
    for u in found:
        low = u.lower().rstrip(").,;")
        if any(h in low for h in REG_HINTS):
            out.append(u.rstrip(").,;"))
    if source_url and source_url.startswith("http"):
        su = source_url.rstrip(").,;")
        if su not in out:
            out.insert(0, su)
    dedup: list[str] = []
    seen: set[str] = set()
    for u in out:
        if u not in seen:
            seen.add(u)
            dedup.append(u)
    return dedup[:6]


def _merge_event_group(group: list[dict]) -> dict:
    """Pick highest-priority row; fill gaps in image / URLs from others."""
    group = sorted(
        group,
        key=lambda e: _source_priority(str(e.get("source", ""))),
        reverse=True,
    )
    best = dict(group[0])
    for other in group[1:]:
        if not is_usable_event_image(best.get("image")):
            if is_usable_event_image(other.get("image")):
                best["image"] = other["image"]
        if not (best.get("source_url") or "").startswith("http"):
            ou = other.get("source_url") or ""
            if ou.startswith("http"):
                best["source_url"] = ou
        # Prefer longer description
        if len(other.get("description") or "") > len(best.get("description") or ""):
            best["description"] = other["description"]

    return best


def _dedupe_merge_events(events: list[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for ev in events:
        h = _make_hash(ev.get("title", ""), ev.get("date", ""), ev.get("location", ""))
        buckets[h].append(ev)

    merged: list[dict] = []
    for group in buckets.values():
        merged.append(_merge_event_group(group))
    return merged


def _enrich_missing_images(events: list[dict], headers: dict) -> None:
    max_fetch = int(os.getenv("SCRAPER_ENRICH_IMAGE_MAX", "40"))
    delay_s = float(os.getenv("SCRAPER_ENRICH_IMAGE_DELAY_S", "0.35"))
    count = 0
    for ev in events:
        if count >= max_fetch:
            break
        if is_usable_event_image(ev.get("image")):
            continue
        page = ev.get("source_url") or ""
        if not page.startswith("http"):
            continue
        img = fetch_og_image(page, headers)
        if img:
            ev["image"] = img
            count += 1
            logger.debug("[manager] Enriched image via og:%s", page[:60])
        time.sleep(delay_s)


def _get_existing_index(db) -> dict[str, dict]:
    """
    Map event hash → { doc_id, source, hash, legacy_hash } for upsert decisions.
    """
    try:
        snap = db.collection(EVENTS_COLLECTION).select(["hash", "legacy_hash", "source"]).get()
        index: dict[str, dict] = {}
        for doc in snap:
            d = doc.to_dict()
            entry = {
                "doc_id": doc.id,
                "source": str(d.get("source") or ""),
                "hash": d.get("hash") or "",
                "legacy_hash": d.get("legacy_hash") or "",
            }
            for key in (entry["hash"], entry["legacy_hash"]):
                if key and key not in index:
                    index[key] = entry
        return index
    except Exception as exc:
        logger.warning("[manager] Could not load existing index: %s", exc)
        return {}


def _get_existing_hashes(db) -> set[str]:
    """Backward-compatible hash set derived from the index."""
    index = _get_existing_index(db)
    out: set[str] = set()
    for entry in index.values():
        if entry.get("hash"):
            out.add(entry["hash"])
        if entry.get("legacy_hash"):
            out.add(entry["legacy_hash"])
    return out


def _cleanup_expired_events(db) -> int:
    """
    Delete Firestore events that are clearly expired.

    An event is expired when BOTH of the following are true:
      - Its `date` is more than 2 days in the past (if the date exists and is parseable), OR
        its `created_at` is older than 21 days (stale, no valid date).
      - It is NOT featured.

    Returns the number of documents deleted.
    """
    try:
        snap = db.collection(EVENTS_COLLECTION).select(["date", "created_at", "featured"]).get()
    except Exception as exc:
        logger.warning("[manager] cleanup: could not fetch documents: %s", exc)
        return 0

    now = datetime.now(timezone.utc)
    cutoff_created_at = (now - timedelta(days=21)).isoformat()
    to_delete: list[str] = []

    for doc in snap:
        d = doc.to_dict()
        if d.get("featured"):
            continue
        date_str = d.get("date") or ""
        created_at_str = d.get("created_at") or d.get("scraped_at") or ""

        expired_by_date = bool(date_str) and is_past_event(date_str, grace_days=2)
        stale_no_date   = (not date_str) and bool(created_at_str) and created_at_str < cutoff_created_at
        stale_with_date = bool(date_str) and bool(created_at_str) and created_at_str < cutoff_created_at

        if expired_by_date or stale_no_date or stale_with_date:
            to_delete.append(doc.id)

    if not to_delete:
        logger.info("[manager] cleanup: nothing to delete")
        return 0

    # Batch delete (max 500 per Firestore batch)
    deleted = 0
    for i in range(0, len(to_delete), 450):
        batch = db.batch()
        chunk = to_delete[i : i + 450]
        for doc_id in chunk:
            batch.delete(db.collection(EVENTS_COLLECTION).document(doc_id))
        try:
            batch.commit()
            deleted += len(chunk)
        except Exception as exc:
            logger.warning("[manager] cleanup batch failed: %s", exc)

    logger.info("[manager] cleanup: deleted %d expired event(s)", deleted)
    return deleted


def run_all_scrapers() -> dict:
    """Run all registered scrapers; merge duplicates; persist new docs."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    all_events: list[dict] = []
    source_errors: dict[str, str] = {}

    for priority, factory in iter_scraper_factories_ordered():
        scraper = None
        try:
            scraper = factory()
            name = getattr(scraper, "SOURCE_NAME", type(scraper).__name__)
            logger.info("[manager] Running scraper %s (prio=%s)", name, priority)
            batch = scraper.run()
            all_events.extend(batch)
        except Exception as exc:
            key = getattr(scraper, "SOURCE_NAME", type(scraper).__name__) if scraper else repr(factory)
            source_errors[key] = str(exc)
            logger.error("[manager] Scraper failed (%s): %s", key, exc)
        time.sleep(float(os.getenv("SCRAPER_DELAY_BETWEEN_SOURCES_S", "1.5")))

    logger.info("[manager] Raw events collected: %d", len(all_events))

    if not all_events:
        return {
            "total_scraped": 0,
            "inserted": 0,
            "skipped_duplicates": 0,
            "sources": {},
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "errors": source_errors,
        }

    merged = _dedupe_merge_events(all_events)
    logger.info("[manager] After dedupe merge: %d", len(merged))

    _enrich_missing_images(merged, headers)

    db = get_firestore()

    # Purge expired events before inserting new ones — keeps the collection lean.
    cleanup_count = _cleanup_expired_events(db)

    existing_index = _get_existing_index(db)
    existing_hashes: set[str] = set()
    for entry in existing_index.values():
        if entry.get("hash"):
            existing_hashes.add(entry["hash"])
        if entry.get("legacy_hash"):
            existing_hashes.add(entry["legacy_hash"])

    inserted = 0
    upgraded = 0
    skipped = 0
    sources: dict[str, int] = {}
    now = datetime.now(timezone.utc).isoformat()

    for event in merged:
        event_hash = _event_identity_hash(event)
        legacy_hash = _legacy_make_hash(
            event.get("title", ""),
            event.get("date", ""),
            event.get("location", ""),
        )

        existing = existing_index.get(event_hash) or existing_index.get(legacy_hash)
        if existing:
            new_prio = _source_priority(str(event.get("source", "")))
            old_prio = _source_priority(existing.get("source", ""))
            if new_prio > old_prio:
                reg = extract_registration_urls(
                    event.get("description", ""), event.get("source_url", "")
                )
                patch = {
                    **event,
                    "hash": event_hash,
                    "legacy_hash": legacy_hash,
                    "scraped_at": now,
                    "updated_at": now,
                }
                if reg:
                    patch["registration_urls"] = reg
                try:
                    db.collection(EVENTS_COLLECTION).document(existing["doc_id"]).update(patch)
                    upgraded += 1
                    src = event.get("source", "unknown")
                    sources[src] = sources.get(src, 0) + 1
                    logger.info(
                        "[manager] Upgraded event '%s' → source=%s (prio %d > %d)",
                        event.get("title", "")[:50],
                        src,
                        new_prio,
                        old_prio,
                    )
                except Exception as exc:
                    logger.warning("[manager] Upgrade failed '%s': %s", event.get("title"), exc)
            else:
                skipped += 1
            continue

        reg = extract_registration_urls(event.get("description", ""), event.get("source_url", ""))
        doc = {
            **event,
            "hash": event_hash,
            "legacy_hash": legacy_hash,
            "created_at": now,
            "scraped_at": now,
        }
        if reg:
            doc["registration_urls"] = reg

        try:
            db.collection(EVENTS_COLLECTION).add(doc)
            existing_hashes.add(event_hash)
            existing_hashes.add(legacy_hash)
            existing_index[event_hash] = {
                "doc_id": "(new)",
                "source": event.get("source", ""),
                "hash": event_hash,
                "legacy_hash": legacy_hash,
            }
            inserted += 1
            src = event.get("source", "unknown")
            sources[src] = sources.get(src, 0) + 1
        except Exception as exc:
            logger.warning("[manager] Failed to insert '%s': %s", event.get("title"), exc)

    logger.info(
        "[manager] Done — inserted=%d upgraded=%d skipped=%d merged_in=%d cleaned_up=%d",
        inserted, upgraded, skipped, len(merged), cleanup_count,
    )

    return {
        "total_scraped": len(all_events),
        "merged_unique": len(merged),
        "inserted": inserted,
        "upgraded": upgraded,
        "skipped_duplicates": skipped,
        "cleaned_up": cleanup_count,
        "sources": sources,
        "ran_at": now,
        "errors": source_errors,
    }
