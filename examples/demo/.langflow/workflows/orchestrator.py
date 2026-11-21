"""Orchestrator-worker: a planner splits the topic, one worker per part runs in parallel (Send), a synthesizer merges.

  langflow start orchestrator <run> topic="how a heat pump works"
"""
from _common import TEXT, listof, save
from langflow import ai, fanout

META = {"description": "orchestrator-worker: plan parts, one worker per part (Send), synthesize"}
REQUIRED = ["topic"]


def worker(part, i):
    return ai(f"research[{i}]", lambda s: (f"In 2 sentences, explain this part of '{s['args']['topic']}': "
                                           f"{s['item']}"), TEXT)


def steps(args):
    return [
        ai("plan", "Split the topic '{topic}' into 3 parts a beginner should learn in order. "
                   "Answer with 3 short part titles.", listof("parts", 3, 3)),
        fanout("research", lambda s: s["results"]["plan"]["parts"], worker, limit=5),
        ai("synthesize", lambda s: ("Write a short explainer (max 120 words) from these parts, in order: "
                                    + " ".join(f"[{r['item']}] {r['result']['text']}"
                                               for r in s["results"]["research_join"]["results"])), TEXT),
        save("explainer", lambda s: s["results"]["synthesize"]["text"] + "\n"),
    ]
