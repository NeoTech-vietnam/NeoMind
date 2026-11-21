"""Schemas and helpers shared by the demo workflows."""
from langflow import current, write

TEXT = {"type": "object", "additionalProperties": False, "required": ["text"],
        "properties": {"text": {"type": "string"}}}


def listof(key, n_min=2, n_max=5):
    return {"type": "object", "additionalProperties": False, "required": [key],
            "properties": {key: {"type": "array", "minItems": n_min, "maxItems": n_max, "items": {"type": "string"}}}}


def save(name, text_fn):
    """Write the final text to .langflow/state/out/<run> - <name>.md."""
    return write(name, lambda s, run: current().state_dir / "out" / f"{run} - {name}.md", text_fn)
