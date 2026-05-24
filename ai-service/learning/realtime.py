"""
learning/realtime.py — Online updates to the bandit + preference vectors + auto-persist.

The Python AI service previously only learned during full /train
batches. This module lets a single interaction update the bandit
immediately:

    apply_feedback({
        "user_id": "abc",
        "place_id": "p_42",
        "place_type": "coffee",
        "action_type": "save",
        "hour": 9,          # optional: local hour (0-23) for time-aware learning
        "day_type": "weekday" # optional: "weekday" | "weekend"
    })

After every successful update we schedule an asynchronous flush of the
bandit state to disk (debounced, so a burst of interactions writes only
once every BANDIT_PERSIST_INTERVAL_SEC).

Time-aware learning: interactions are bucketed into time_of_day slots
(morning / afternoon / evening / night) and separately for weekday /
weekend.  The preference vector for each user is updated accordingly.

Sequence model state isn't updated incrementally (training the GRU on
single examples is unstable); instead, it's refreshed during the
periodic /train cycle.  However the *recent_types* list used at
inference time is always derived from the live interaction stream, so
sequence predictions still reflect new behaviour immediately.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from models.bandit import get_bandit
from store.model_store import save_all, get_meta

logger = logging.getLogger(__name__)

# How often to persist bandit state to disk (debounced).
_PERSIST_INTERVAL_SEC = float(os.getenv("BANDIT_PERSIST_INTERVAL_SEC", "30"))

# ─── In-memory preference vector store ──────────────────────────────────────
# {user_id: {"category": float, ...}}  — category affinity confidence in [0,1]
_preference_vectors: dict[str, dict[str, float]] = {}
_pref_lock = threading.Lock()

# Time-of-day slot mapping
def _time_slot(hour: int) -> str:
    if 5 <= hour < 12:   return "morning"
    if 12 <= hour < 17:  return "afternoon"
    if 17 <= hour < 22:  return "evening"
    return "night"

# Weights mapping action_type → signal strength for preference vectors.
# These shape how fast the in-memory affinity vector adapts.
_PREF_SIGNAL: dict[str, float] = {
    # Positive — engagement
    "view":             0.02,
    "view_long":        0.10,   # was 0.08 — long stays are strong taste signal
    "click":            0.04,
    "directions":       0.15,   # was 0.12
    "call":             0.12,   # was 0.10
    "share":            0.10,   # was 0.08
    "like":             0.12,   # was 0.09
    "save":             0.22,   # was 0.18
    "mark_interested":  0.08,   # was 0.06
    "revisit":          0.25,   # was 0.20 — strongest single signal
    "open_event":       0.04,
    "join_event":       0.22,   # was 0.18
    "schedule_complete": 0.20,
    "activity_complete": 0.20,
    # Explicit feedback (NEW)
    "feedback_excellent":   0.25,
    "feedback_good":        0.10,
    "feedback_neutral":     0.00,
    # Negative — rejection
    "dislike":         -0.20,   # was -0.14
    "dismiss":         -0.14,   # was -0.10
    "skip":            -0.08,   # was -0.06
    "not_interested":  -0.25,   # was -0.14 — STRONG: stop suggesting this
    "remove_save":     -0.08,   # was -0.05
    "quick_exit":      -0.10,   # NEW — left detail page quickly
    "feedback_poor":        -0.18,
    "feedback_not_relevant": -0.30,
}


def update_preference_vector(user_id: str, place_type: str, action_type: str,
                              hour: int | None = None, day_type: str = "weekday") -> dict:
    """
    Update the in-memory preference vector for a user.
    Returns the updated preference snapshot for this category.
    """
    delta = _PREF_SIGNAL.get(action_type, 0.0)
    if delta == 0.0:
        return {}

    with _pref_lock:
        if user_id not in _preference_vectors:
            _preference_vectors[user_id] = {}
        vec = _preference_vectors[user_id]

        # Base category affinity
        old = vec.get(place_type, 0.5)
        vec[place_type] = max(0.0, min(1.0, old + delta))

        # Time-aware sub-key: category_morning, category_weekend, etc.
        if hour is not None:
            slot = _time_slot(hour)
            tkey = f"{place_type}_{slot}"
            vec[tkey] = max(0.0, min(1.0, vec.get(tkey, 0.5) + delta * 0.7))

        if day_type == "weekend":
            wkey = f"{place_type}_weekend"
            vec[wkey] = max(0.0, min(1.0, vec.get(wkey, 0.5) + delta * 0.8))

        return {"category": place_type, "affinity": round(vec[place_type], 4)}


def get_preference_vector(user_id: str) -> dict[str, float]:
    """Return a copy of the user's current preference vector."""
    with _pref_lock:
        return dict(_preference_vectors.get(user_id, {}))


def snapshot_preference_vectors() -> dict[str, dict[str, float]]:
    """
    Returns a deep-ish copy of every user's preference vector, suitable for
    JSON serialisation. Used by store.model_store.save_all to persist adaptive
    memory across service restarts.
    """
    with _pref_lock:
        return {uid: dict(vec) for uid, vec in _preference_vectors.items()}


def hydrate_preference_vectors(state: dict[str, dict[str, float]]) -> None:
    """
    Replaces the in-memory preference vector store with the supplied snapshot.
    Called once at startup from store.model_store.load_all so previously-learned
    affinity isn't wiped on every redeploy.
    """
    if not isinstance(state, dict):
        return
    with _pref_lock:
        _preference_vectors.clear()
        for uid, vec in state.items():
            if not isinstance(vec, dict):
                continue
            _preference_vectors[uid] = {
                str(k): float(v) for k, v in vec.items()
                if isinstance(v, (int, float))
            }


def get_top_categories(user_id: str, n: int = 5) -> list[tuple[str, float]]:
    """Return the top-N categories by affinity score (highest first)."""
    vec = get_preference_vector(user_id)
    # Only base keys (not time-slotted sub-keys)
    base = {k: v for k, v in vec.items() if "_" not in k}
    return sorted(base.items(), key=lambda x: x[1], reverse=True)[:n]


def generate_explanation(user_id: str, place_type: str) -> str | None:
    """
    Generate a natural-language explanation for why a place is recommended,
    based on the user's learned preference vector + interaction history.

    Returns None when there's not enough signal yet (cold-start fallback to
    the LLM/template explanation instead).
    """
    vec = get_preference_vector(user_id)
    if not vec:
        return None

    top = get_top_categories(user_id, 3)
    affinity = vec.get(place_type, 0.5)

    # Strong direct affinity — phrase based on intensity
    if affinity >= 0.85:
        return f"You consistently engage with {place_type} places — this is one of your top categories."
    if affinity >= 0.70:
        return f"Recommended because you've shown a strong preference for {place_type}."
    if affinity >= 0.60:
        return f"Matches your interest in {place_type} based on recent activity."

    # Cross-category — top categories suggest a related place
    if top:
        top_cat, top_score = top[0]
        if top_score >= 0.75 and top_cat != place_type:
            return f"Based on your frequent interest in {top_cat}, you may enjoy this {place_type} too."
        if top_score >= 0.65 and top_cat == place_type:
            return f"You often save {place_type} places — here's another worth checking out."

    # Mild signal — neutral phrasing
    if affinity >= 0.55:
        return f"Aligns with your interest in {place_type}."

    return None

_state_lock     = threading.Lock()
_dirty          = False
_last_persisted = 0.0
_persist_timer: threading.Timer | None = None


def _schedule_persist() -> None:
    """Debounced background save — runs once per _PERSIST_INTERVAL_SEC."""
    global _persist_timer

    def _flush() -> None:
        global _dirty, _last_persisted, _persist_timer
        with _state_lock:
            if not _dirty:
                _persist_timer = None
                return
            _dirty = False
            _last_persisted = time.time()
            _persist_timer = None
        try:
            meta = get_meta()
            save_all(
                data_size=meta.get("dataSize", 0),
                seq_metrics=None,
                emb_cache_size=meta.get("performanceMetrics", {}).get("embedding_cache_size"),
            )
            logger.info("[learning] bandit state flushed to disk (real-time update)")
        except Exception as exc:
            logger.warning("[learning] bandit persist failed: %s", exc)

    with _state_lock:
        if _persist_timer is None:
            _persist_timer = threading.Timer(_PERSIST_INTERVAL_SEC, _flush)
            _persist_timer.daemon = True
            _persist_timer.start()


def _normalize_action(action: str) -> str:
    """Normalize legacy/alias action type strings to canonical ones."""
    a = (action or "").strip().lower()
    aliases = {
        # legacy compat
        "like":       "like",
        "favourite":  "save",
        "favorite":   "save",
        "tap":        "click",
        "open":       "click",
        "ignore":     "dismiss",
        "hide":       "dismiss",
        # mobile sends these verbatim
        "view_long":        "view_long",
        "directions":       "directions",
        "call":             "call",
        "share":            "share",
        "mark_interested":  "mark_interested",
        "revisit":          "revisit",
        "open_event":       "open_event",
        "join_event":       "join_event",
        "dislike":          "dislike",
        "skip":             "skip",
        "not_interested":   "not_interested",
        "remove_save":      "remove_save",
        "search":           "search",
        "filter_use":       "filter_use",
        "schedule_complete": "schedule_complete",
        "activity_complete": "activity_complete",
    }
    return aliases.get(a, a)


# All known canonical action types
_KNOWN_ACTIONS = frozenset({
    "view", "view_long", "click", "directions", "call", "share",
    "like", "save", "mark_interested", "revisit",
    "open_event", "join_event",
    "dislike", "dismiss", "skip", "not_interested", "remove_save",
    "quick_exit",
    "search", "filter_use", "schedule_complete", "activity_complete",
    # Explicit feedback ratings
    "feedback_excellent", "feedback_good", "feedback_neutral",
    "feedback_poor", "feedback_not_relevant",
})


def apply_feedback(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Apply a single interaction to the bandit and preference vector.

    Required keys:
      user_id     - string
      place_type  - string (e.g. 'gym', 'coffee')
      action_type - one of the canonical INTERACTION_TYPES or aliases

    Optional keys:
      place_id  - logged only
      hour      - local hour (0-23) for time-aware learning
      day_type  - "weekday" | "weekend"
      metadata  - ignored

    Returns:
      {
        "updated": True/False,
        "user_id": str,
        "place_type": str,
        "action_type": str,
        "alpha": float,
        "beta":  float,
        "bandit_score": float,
        "affinity": float,
        "explanation": str | None
      }
    """
    user_id    = str(payload.get("user_id") or payload.get("userId") or "")
    place_type = str(payload.get("place_type") or payload.get("placeType") or "")
    action     = _normalize_action(payload.get("action_type") or payload.get("actionType") or "")
    hour_raw   = payload.get("hour")
    day_type   = str(payload.get("day_type") or "weekday")

    try:
        hour = int(hour_raw) if hour_raw is not None else datetime.now(timezone.utc).hour
    except (TypeError, ValueError):
        hour = datetime.now(timezone.utc).hour

    if not user_id or not place_type or not action:
        return {
            "updated": False,
            "reason":  "missing_required_fields",
            "user_id": user_id,
            "place_type": place_type,
            "action_type": action,
        }
    if action not in _KNOWN_ACTIONS:
        return {
            "updated": False,
            "reason":  f"invalid_action_type:{action}",
            "user_id": user_id,
            "place_type": place_type,
            "action_type": action,
        }

    # ── 1. Bandit update ──────────────────────────────────────────────────────
    bandit = get_bandit()
    bandit.update(user_id, place_type, action)

    arm = bandit._get_arm(user_id, place_type)  # noqa: SLF001 — internal but stable
    a, b = arm["alpha"], arm["beta"]
    bandit_score = a / (a + b)

    # ── 2. Preference vector update ───────────────────────────────────────────
    pref_update = update_preference_vector(user_id, place_type, action, hour, day_type)

    # ── 3. Explanation ────────────────────────────────────────────────────────
    explanation = generate_explanation(user_id, place_type)

    global _dirty
    with _state_lock:
        _dirty = True
    _schedule_persist()

    logger.info(
        "[learning] uid=%s type=%s action=%s bandit=%.3f affinity=%.3f",
        user_id, place_type, action, bandit_score,
        pref_update.get("affinity", 0.0),
    )

    return {
        "updated":      True,
        "user_id":      user_id,
        "place_type":   place_type,
        "action_type":  action,
        "alpha":        round(a, 3),
        "beta":         round(b, 3),
        "bandit_score": round(bandit_score, 4),
        "affinity":     pref_update.get("affinity", 0.0),
        "explanation":  explanation,
    }


def apply_feedback_batch(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply many feedback events; one persistence flush at the end."""
    applied = 0
    failed  = 0
    for item in items:
        result = apply_feedback(item)
        if result.get("updated"):
            applied += 1
        else:
            failed += 1
    return {"applied": applied, "failed": failed}
