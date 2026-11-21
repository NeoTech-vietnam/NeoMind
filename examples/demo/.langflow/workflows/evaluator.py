"""Evaluator-optimizer: a writer and a strict judge loop until the judge passes it (max 3 rounds).

The writer does not know the judge's rules in round 1, so the first draft usually fails and the loop shows a fix.
  langflow start evaluator <run> topic="a bicycle repair shop"
"""
from _common import TEXT, save
from langflow import ai, loop

META = {"description": "evaluator-optimizer: write, judge, rewrite until it passes"}
REQUIRED = ["topic"]
JUDGE = {"type": "object", "additionalProperties": False, "required": ["passed", "score", "feedback"],
         "properties": {"passed": {"type": "boolean"}, "score": {"type": "integer", "minimum": 1, "maximum": 10},
                        "feedback": {"type": "string"}}}
RULES = ("at most 6 words; no exclamation mark; must not use the words 'best', 'quality' or 'great'; "
         "must name the kind of business")


def write_prompt(s):
    prev = s["results"].get("judge")
    base = f"Write one advertising slogan for {s['args']['topic']}."
    if prev and not prev["passed"]:
        base += (f" Your previous slogan was: \"{s['results']['write']['text']}\". The judge rejected it: "
                 f"{prev['feedback']} Write a new one that fixes this.")
    return base + " Put only the slogan itself in 'text', in English."


def judge_prompt(s):
    return (f"You are a strict judge. Slogan: \"{s['results']['write']['text']}\". Rules: {RULES}. passed = true only "
            "if every rule holds. Give a score 1-10 and one sentence of feedback naming each broken rule.")


def steps(args):
    return [
        loop("polish", [ai("write", write_prompt, TEXT), ai("judge", judge_prompt, JUDGE)],
             until=lambda s: s["results"]["judge"]["passed"], max_rounds=3),
        save("slogan", lambda s: f"{s['results']['write']['text']}\n\njudge: {s['results']['judge']}\n"
                                 f"rounds: {s['results']['polish']['round']}\n"),
    ]
