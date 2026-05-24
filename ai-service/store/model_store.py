"""
store/model_store.py — Unified save/load/versioning for all AI model artefacts.

Persisted artefacts (all under DATA_DIR):
  bandit_state.json    — BanditModel._state dict
  sequence_model.json  — SequenceModel weights (serialised to plain lists for
                          portability without full PyTorch deserialization)
  model_meta.json      — version, timestamps, performance metrics, data size

Versioning:
  versionNumber auto-increments on every save.
  version string = "v{versionNumber}".
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

import config
from models.bandit   import BanditModel, get_bandit,   set_bandit
from models.sequence import SequenceModel, get_sequence_model, set_sequence_model

logger = logging.getLogger(__name__)

# ─── File paths ───────────────────────────────────────────────────────────────

_BANDIT_PATH   = os.path.join(config.DATA_DIR, "bandit_state.json")
_SEQ_PATH      = os.path.join(config.DATA_DIR, "sequence_model.json")
_META_PATH     = os.path.join(config.DATA_DIR, "model_meta.json")
# v18 — Adaptive preference vector per user, persisted across restarts so the
# AI's learned category affinity is not wiped every time the service redeploys.
_PREF_VEC_PATH = os.path.join(config.DATA_DIR, "preference_vectors.json")

# ─── Default metadata ────────────────────────────────────────────────────────

def _default_meta() -> dict[str, Any]:
    return {
        "version":        "v0",
        "versionNumber":  0,
        "lastTrainedAt":  None,
        "dataSize":       0,
        "performanceMetrics": {
            "bandit_arms":          len(config.PLACE_TYPES),
            "lstm_trained":         False,
            "embedding_cache_size": {"places": 0, "users": 0},
            "bandit_users":         0,
            "sequence_final_loss":  None,
        },
    }


# ─── Internal helpers ────────────────────────────────────────────────────────

def _read_json(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("[store] failed to read %s: %s", path, exc)
        return None


def _write_json(path: str, data: Any) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _tensor_to_list(sd: dict) -> dict:
    """Converts a PyTorch state_dict (tensor values) to plain Python lists."""
    result = {}
    for k, v in sd.items():
        try:
            result[k] = v.tolist()
        except AttributeError:
            result[k] = v
    return result


# ─── Public API ──────────────────────────────────────────────────────────────

def load_all() -> dict[str, Any]:
    """
    Loads all model artefacts from disk into the module-level singletons.
    Called once at server startup.

    Returns the current metadata dict.
    """
    os.makedirs(config.DATA_DIR, exist_ok=True)

    # Bandit
    bandit_state = _read_json(_BANDIT_PATH)
    if bandit_state:
        set_bandit(BanditModel.from_state_dict(bandit_state))
        logger.info("[store] bandit loaded — %d users", len(bandit_state))
    else:
        logger.info("[store] bandit — no saved state; using fresh priors")

    # Sequence model
    seq_sd = _read_json(_SEQ_PATH)
    if seq_sd:
        sm = SequenceModel()
        sm.load_state_dict(seq_sd)
        set_sequence_model(sm)
        logger.info("[store] sequence model loaded")
    else:
        logger.info("[store] sequence model — no saved weights; model untrained")

    # v18 — Preference vectors (real-time adaptive memory).
    # Imported lazily to avoid a circular import at module load time.
    pref_state = _read_json(_PREF_VEC_PATH)
    if pref_state and isinstance(pref_state, dict):
        try:
            from learning import realtime as _rt
            _rt.hydrate_preference_vectors(pref_state)
            logger.info("[store] preference vectors loaded — %d users", len(pref_state))
        except Exception as exc:
            logger.warning("[store] preference vector hydrate failed: %s", exc)
    else:
        logger.info("[store] preference vectors — no saved state; starting cold")

    # Metadata
    meta = _read_json(_META_PATH) or _default_meta()
    return meta


def save_all(
    data_size: int,
    seq_metrics: Optional[dict] = None,
    emb_cache_size: Optional[dict] = None,
) -> dict[str, Any]:
    """
    Persists bandit state and sequence model weights to disk.
    Increments model version and writes updated metadata.

    Returns the new metadata dict.
    """
    # Bandit
    bandit = get_bandit()
    _write_json(_BANDIT_PATH, bandit.state_dict())

    # Sequence model
    sm = get_sequence_model()
    if sm.is_trained():
        sd = sm.state_dict()
        if sd is not None:
            _write_json(_SEQ_PATH, _tensor_to_list(sd))

    # v18 — Preference vectors (per-user adaptive memory).
    try:
        from learning import realtime as _rt
        snapshot = _rt.snapshot_preference_vectors()
        if snapshot:
            _write_json(_PREF_VEC_PATH, snapshot)
    except Exception as exc:
        logger.warning("[store] preference vector persist failed: %s", exc)

    # Bump version
    existing_meta = _read_json(_META_PATH) or _default_meta()
    new_version_n = existing_meta.get("versionNumber", 0) + 1

    meta = {
        "version":       f"v{new_version_n}",
        "versionNumber": new_version_n,
        "lastTrainedAt": datetime.now(tz=timezone.utc).isoformat(),
        "dataSize":      data_size,
        "performanceMetrics": {
            "bandit_arms":         len(config.PLACE_TYPES),
            "lstm_trained":        sm.is_trained(),
            "embedding_cache_size": emb_cache_size or {"places": 0, "users": 0},
            "bandit_users":        len(bandit.state_dict()),
            "sequence_final_loss": (seq_metrics or {}).get("final_loss"),
        },
    }

    _write_json(_META_PATH, meta)
    logger.info("[store] saved — version=%s  dataSize=%d", meta["version"], data_size)
    return meta


def get_meta() -> dict[str, Any]:
    """Returns current metadata without loading models."""
    return _read_json(_META_PATH) or _default_meta()
