"""English ids for levels, support kinds and item kinds, plus the legacy ids that are accepted when reading.

Reading a legacy id returns the English id and remembers it; the CLI prints one warning at the end of the run
(`flush_warning`). Writing always uses English ids. Standard library only.
"""

from __future__ import annotations

import sys

LEVELS = ["unassessed", "aware", "understand", "apply", "apply-advanced"]
SUPPORT = ["independent", "hint-direction", "hint-specific", "taught-first", "saw-solution"]
KINDS = ["module", "foundation", "change", "open-question", "decision"]

# Legacy ids, used only when reading. Each maps to the English id of the same category.
LEGACY = {
    "level": {
        "chua-danh-gia": "unassessed",
        "biet": "aware",
        "hieu": "understand",
        "van-dung": "apply",
        "van-dung-cao": "apply-advanced",
    },
    "support": {
        "doc-lap": "independent",
        "goi-y-huong": "hint-direction",
        "goi-y-cu-the": "hint-specific",
        "giang-truoc": "taught-first",
        "xem-loi-giai": "saw-solution",
    },
    "kind": {
        "module": "module",
        "nen": "foundation",
        "thay-doi": "change",
        "nghi-van": "open-question",
        "quyet-dinh": "decision",
    },
}

UNDERSTOOD = LEVELS.index("understand")

_seen: list[tuple[str, str]] = []


def normalize(category: str, value):
    """English id for value. A legacy id is converted and counted; anything else is returned unchanged."""
    if isinstance(value, str):
        new = LEGACY[category].get(value)
        if new is not None and new != value:
            _seen.append((value, new))
            return new
    return value


def level_index(value) -> int:
    """Position of a level id (legacy or English) in LEVELS; unknown or missing means 0 (unassessed)."""
    value = normalize("level", value)
    return LEVELS.index(value) if value in LEVELS else 0


def normalize_record(rec: dict) -> dict:
    """Copy of one person record with level, self and the evidence level and support in English ids."""
    out = dict(rec)
    for key in ("level", "self"):
        if key in out:
            out[key] = normalize("level", out[key])
    if isinstance(out.get("evidence"), list):
        evidence = []
        for ev in out["evidence"]:
            if isinstance(ev, dict):
                ev = dict(ev)
                if "level" in ev:
                    ev["level"] = normalize("level", ev["level"])
                if "support" in ev:
                    ev["support"] = normalize("support", ev["support"])
            evidence.append(ev)
        out["evidence"] = evidence
    return out


def legacy_warning() -> str | None:
    if not _seen:
        return None
    old, new = _seen[0]
    return f"warning: {len(_seen)} legacy ids read (e.g. '{old}' -> '{new}'); run migrate_ids.py"


def flush_warning(stream=None) -> None:
    """Print the one warning of this run (if any legacy id was read) and reset the counter."""
    text = legacy_warning()
    if text:
        print(text, file=stream or sys.stderr)
    _seen.clear()


def reset() -> None:
    _seen.clear()
