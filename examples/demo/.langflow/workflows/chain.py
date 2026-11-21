"""Prompt chaining: outline -> gate (a person checks the outline) -> expand -> file.

  langflow start chain <run> topic="why unit tests matter"      then: langflow approve <run> [--note "..."]
"""
from _common import TEXT, listof, save
from langflow import ai, gate

META = {"description": "prompt chaining: outline, gate, expand"}
REQUIRED = ["topic"]


def points(s):
    return s["results"]["outline"]["points"]


def steps(args):
    return [
        ai("outline", "Give 3 short outline points (max 10 words each) for a one-paragraph explainer about: {topic}. "
                      "Answer only with the JSON.", listof("points", 3, 3)),
        gate("outline_ok", lambda s: "Outline: " + " | ".join(points(s)) + ". Write the paragraph?"),
        ai("expand", lambda s: (f"Write one paragraph (max 100 words) about {s['args']['topic']} following this "
                                f"outline: {points(s)}. Reviewer note: "
                                f"{(s['decisions'].get('outline_ok') or {}).get('note') or 'none'}."), TEXT),
        save("paragraph", lambda s: s["results"]["expand"]["text"] + "\n"),
    ]
