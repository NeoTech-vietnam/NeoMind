"""Parallelization: pros (Claude), cons (Codex) and risks (Claude) at the same time, then one merge step.

  langflow start parallel <run> topic="moving a team from Jira to GitHub Issues"
"""
from _common import listof, save, TEXT
from langflow import ai, parallel

META = {"description": "parallelization: pros, cons, risks in parallel (Claude and Codex), then merge"}
REQUIRED = ["topic"]


def steps(args):
    return [
        parallel("views", [
            ai("pros", "List 3 short advantages of {topic}.", listof("items", 3, 3)),
            ai("cons", "List 3 short disadvantages of {topic}. Do not run any command.", listof("items", 3, 3),
               agent="codex"),
            ai("risks", "List 3 short risks to manage for {topic}.", listof("items", 3, 3)),
        ]),
        ai("merge", lambda s: (f"Topic: {s['args']['topic']}. Pros: {s['results']['pros']['items']}. "
                               f"Cons: {s['results']['cons']['items']}. Risks: {s['results']['risks']['items']}. "
                               "Write a 3-sentence recommendation."), TEXT),
        save("recommendation", lambda s: s["results"]["merge"]["text"] + "\n"),
    ]
