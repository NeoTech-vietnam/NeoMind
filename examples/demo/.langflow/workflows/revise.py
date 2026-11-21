"""Series memory: revise the same document over several runs (v1, v2, v3 ...); each run uses what earlier runs learned.

  langflow start revise v1 doc=product-note topic="a smart water bottle"
  langflow approve v1 --note "too salesy; no exclamation marks; mention the battery life"
  langflow start revise v2 doc=product-note topic="a smart water bottle"     <- sees v1's memory and the gate note
Series = the doc name, so runs with the same doc share memory (MEMORY_SERIES = "{doc}").
"""
from _common import TEXT, save
from langflow import ai, gate

META = {"description": "series memory: write, reviewer gate, remember across v1, v2, v3 runs"}
REQUIRED = ["doc", "topic"]
MEMORY_SERIES = "{doc}"


def steps(args):
    return [
        ai("draft", "Write a 3-sentence product note about {topic}. Follow every reviewer request and decision in the "
                    "workflow memory below, if any. Remember (scope series) any style rule you applied.",
           TEXT, memory=["run", "series"]),
        gate("review", lambda s: "Draft: " + s["results"]["draft"]["text"][:300] + " — approve (note = changes for "
                                 "the next version)?"),
        save("note", lambda s: s["results"]["draft"]["text"] + "\n"),
    ]
