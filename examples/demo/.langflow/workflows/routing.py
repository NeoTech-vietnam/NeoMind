"""Routing: classify a ticket, then run only the branch for its type.

  langflow start routing <run> ticket="The app crashes when I upload a 2 GB file"
"""
from _common import TEXT, save
from langflow import ai, route

META = {"description": "routing: classify, then bug / question / feature branch"}
REQUIRED = ["ticket"]
CLASSIFY = {"type": "object", "additionalProperties": False, "required": ["category", "why"],
            "properties": {"category": {"enum": ["bug", "question", "feature"]}, "why": {"type": "string"}}}
BRANCH_OUT = ("bug_triage", "answer", "feature_spec")


def steps(args):
    return [
        ai("classify", "Classify this support ticket as bug, question or feature, with one short reason: {ticket}",
           CLASSIFY),
        route("by_type", lambda s: s["results"]["classify"]["category"], {
            "bug": [ai("bug_triage", "Ticket: {ticket}\nWrite 3 short reproduction steps and a severity "
                                     "(low/medium/high), as plain text.", TEXT)],
            "question": [ai("answer", "Ticket: {ticket}\nAnswer the user's question in at most 3 sentences.", TEXT)],
            "feature": [ai("feature_spec", "Ticket: {ticket}\nWrite a 3-line feature request: need, users, "
                                           "acceptance criterion.", TEXT)],
        }),
        save("reply", lambda s: f"type: {s['results']['classify']['category']} ({s['results']['classify']['why']})\n\n"
                                + next(s["results"][k]["text"] for k in BRANCH_OUT if k in s["results"]) + "\n"),
    ]
