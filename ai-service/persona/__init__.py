"""
persona/ — User & Place Persona Intelligence.

Infers a user's lifestyle "persona" (working professional, student, religious,
quiet/productivity-focused, social/nightlife-oriented, family-oriented, etc.)
from their onboarding profile + interaction history, and classifies places by
the persona archetype they best serve.

Then exposes a single function:

    persona_alignment_score(user_persona, place_persona) -> float in [-0.5, +0.15]

…that the recommendation scorer uses to boost aligned places and heavily
penalise contradictory ones (e.g. "student cafe" surfaced to a working
professional).

This is the layer that makes the AI feel deeply personalized rather than
generic.
"""

from .user_persona import infer_user_persona, UserPersona
from .place_persona import classify_place_persona, PlacePersona
from .alignment import persona_alignment_score, persona_match_label

__all__ = [
    "infer_user_persona",
    "classify_place_persona",
    "persona_alignment_score",
    "persona_match_label",
    "UserPersona",
    "PlacePersona",
]
