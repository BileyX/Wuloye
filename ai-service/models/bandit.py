"""
models/bandit.py — Contextual Bandit with Thompson Sampling.

Arms = place types (gym, coffee, yoga, …).
Per-user, per-type Beta(alpha, beta) parameters track engagement history.

Thompson Sampling:
  For each arm draw a sample θ ~ Beta(α, β).
  The arm with the highest sample is predicted "best".

Updates:
  positive interaction (view/click/save) → α += reward_delta
  dismiss                                → β += 1

banditScore is the posterior mean E[θ] = α / (α + β) in [0, 1].
It is NOT a random draw (that would be non-deterministic per request);
we return the mean for stable, repeatable ranking.

For cold-start users (fewer than COLD_START_THRESHOLD interactions)
the prior Beta(1,1) = uniform → banditScore = 0.5 for all arms.
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Optional

import numpy as np

import config

logger = logging.getLogger(__name__)

# ─── Reward deltas (scale into meaningful Beta increments) ────────────────────
# Positive actions increase α (probability of reward).
# Dismiss/negative actions increase β (probability of failure).
# Zero-delta actions have no effect on the arm; β-only negative actions
# are handled in the update() method via the `_BETA_BUMP` map below.

_REWARD_DELTAS: dict[str, float] = {
    # ── Passive ───────────────────────────────────────────────────────────────
    "view":             0.5,
    "view_long":        3.5,    # was 2.5 — long detail-page stays are strong signal
    # ── Navigation intent ─────────────────────────────────────────────────────
    "click":            1.2,    # was 1.0
    "directions":       4.0,    # was 3.0 — opening directions = high intent
    "call":             2.5,    # was 2.0
    "share":            2.5,    # was 2.0
    # ── Affinity ──────────────────────────────────────────────────────────────
    "like":             3.0,    # was 2.0
    "save":             5.5,    # was 4.0 — saves are the strongest taste signal
    "mark_interested":  2.0,    # was 1.5
    "revisit":          6.5,    # was 5.0 — repeat visit is the highest signal
    # ── Events ────────────────────────────────────────────────────────────────
    "open_event":       1.2,
    "join_event":       5.5,    # was 4.5
    # ── Completions ───────────────────────────────────────────────────────────
    "schedule_complete": 5.0,   # was 4.0
    "activity_complete": 5.0,   # was 4.0
    # ── Explicit feedback (NEW) — direct user rating signals ─────────────────
    "feedback_excellent": 7.0,
    "feedback_good":      3.0,
    "feedback_neutral":   0.0,
    # ── Negative (α delta ignored, β handled separately) ──────────────────────
    "dislike":          0.0,
    "dismiss":          0.0,
    "skip":             0.0,
    "not_interested":   0.0,
    "remove_save":      0.0,
    "feedback_poor":         0.0,
    "feedback_not_relevant": 0.0,
    "quick_exit":            0.0,
    # ── Neutral ───────────────────────────────────────────────────────────────
    "search":           0.0,
    "filter_use":       0.0,
}

# How much to bump β for negative signals.
# Larger β = arm gets ranked lower for this user, faster.
_BETA_BUMPS: dict[str, float] = {
    "dismiss":         1.5,    # was 1.0
    "dislike":         3.0,    # was 2.0 — explicit dislike trains hard
    "skip":            1.0,    # was 0.7
    "not_interested":  3.5,    # was 2.0 — strongest "stop showing me this" signal
    "remove_save":     1.0,    # was 0.5
    "quick_exit":      0.8,    # NEW — opened detail but left in <3s
    "feedback_poor":         2.5,
    "feedback_not_relevant": 4.0,
}

# ─── Types ────────────────────────────────────────────────────────────────────

# arm state: {"alpha": float, "beta": float}
ArmState = dict[str, float]
# user state: {place_type: ArmState}
UserState = dict[str, ArmState]


def _default_arm() -> ArmState:
    return {"alpha": 1.0, "beta": 1.0}


def _default_user_state() -> UserState:
    return {t: _default_arm() for t in config.PLACE_TYPES}


# ─── BanditModel ──────────────────────────────────────────────────────────────

class BanditModel:
    """
    In-memory contextual bandit.

    State is a dict: user_id → {place_type → {alpha, beta}}.
    State is persisted/loaded by store.model_store.
    """

    def __init__(self, state: Optional[dict[str, UserState]] = None) -> None:
        # user_id → {place_type → ArmState}
        self._state: dict[str, UserState] = state or {}

    # ── Public API ────────────────────────────────────────────────────────────

    def bandit_score(self, user_id: str, place_type: str) -> float:
        """
        Returns the posterior mean E[θ] = α / (α + β) for the given arm.

        This is a deterministic ranking signal in [0, 1].
        Defaults to 0.5 (uniform prior) for unseen users / types.
        """
        arm = self._get_arm(user_id, place_type)
        a, b = arm["alpha"], arm["beta"]
        return a / (a + b)

    def update(self, user_id: str, place_type: str, action_type: str) -> None:
        """
        Updates the Beta distribution for a user-arm pair based on an
        observed interaction.

        Positive signals increase α (engagement probability).
        Negative signals increase β (rejection probability).
        """
        arm = self._get_arm(user_id, place_type, create=True)
        beta_bump = _BETA_BUMPS.get(action_type, 0.0)
        if beta_bump > 0:
            arm["beta"] = min(arm["beta"] + beta_bump, 1000.0)
        else:
            delta = _REWARD_DELTAS.get(action_type, 0.0)
            if delta > 0:
                arm["alpha"] = min(arm["alpha"] + delta, 1000.0)

    def bulk_update(self, interactions: list[dict], places: dict[str, dict]) -> int:
        """
        Trains the bandit from a list of interaction dicts.

        interactions: [{userId, placeId, actionType, …}, …]
        places:       {placeId: {type, …}, …}

        Returns number of updates applied.
        """
        _all_known = set(_REWARD_DELTAS) | set(_BETA_BUMPS)
        count = 0
        for ix in interactions:
            uid    = ix.get("userId") or ix.get("user_id")
            pid    = ix.get("placeId") or ix.get("place_id")
            action = ix.get("actionType") or ix.get("action_type")
            if not uid or not pid or action not in _all_known:
                continue
            place = places.get(pid)
            if not place:
                continue
            ptype = place.get("type") or ix.get("place_type")
            if not ptype:
                continue
            self.update(uid, ptype, action)
            count += 1
        return count

    def state_dict(self) -> dict:
        return deepcopy(self._state)

    @classmethod
    def from_state_dict(cls, state: dict) -> "BanditModel":
        return cls(state=state)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _get_arm(
        self, user_id: str, place_type: str, create: bool = False
    ) -> ArmState:
        if user_id not in self._state:
            if not create:
                return _default_arm()
            self._state[user_id] = _default_user_state()
        user_state = self._state[user_id]
        if place_type not in user_state:
            if not create:
                return _default_arm()
            user_state[place_type] = _default_arm()
        return user_state[place_type]


# ─── Module-level singleton (loaded by model_store) ───────────────────────────

_bandit: Optional[BanditModel] = None


def get_bandit() -> BanditModel:
    global _bandit
    if _bandit is None:
        _bandit = BanditModel()
    return _bandit


def set_bandit(model: BanditModel) -> None:
    global _bandit
    _bandit = model
