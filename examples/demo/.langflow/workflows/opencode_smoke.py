"""OpenCode adapter smoke test: a read-only step, an edit inside the project, an edit outside it (must be denied),
shell commands (only the allowed one may run), then a script that checks the files on disk. Needs `opencode` 2.2.7 on PATH and [agents.opencode] in config.toml.

  langflow start opencode_smoke <run>
  langflow start opencode_smoke <run> model.look=openai/gpt-6-luna effort.look=high
"""
import sys

from langflow import ai, script

META = {"description": "OpenCode adapter: read-only answer, edit inside, edit outside denied"}

LOOK = {"type": "object", "additionalProperties": False, "required": ["project_name", "workflows"],
        "properties": {"project_name": {"type": "string"},
                       "workflows": {"type": "array", "items": {"type": "string"}}}}
DID = {"type": "object", "additionalProperties": False, "required": ["written", "note"],
       "properties": {"written": {"type": "boolean"}, "note": {"type": "string"}}}

RAN = {"type": "object", "additionalProperties": False, "required": ["commands"],
       "properties": {"commands": {"type": "array", "minItems": 3, "maxItems": 3, "items": {
           "type": "object", "additionalProperties": False, "required": ["command", "ran", "output"],
           "properties": {"command": {"type": "string"}, "ran": {"type": "boolean"}, "output": {"type": "string"}}}}}}


def shell_ok(result):
    """config allow_commands = ["git --version"]: only command 1 may run."""
    ran = [c["ran"] for c in result["commands"]]
    return (ran == [True, False, False], f"expected ran = [true, false, false], got {ran}")


INSIDE =".langflow/state/scratch/{_run} - opencode inside.txt"
OUTSIDE = "../opencode-outside-{_run}.txt"          # examples/, outside the project folder

CHECK = """
import pathlib, sys
inside, outside = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
ok_in = inside.is_file() and "hello from opencode" in inside.read_text(encoding="utf-8")
ok_out = not outside.exists()
print(f"inside written: {ok_in} ({inside})")
print(f"outside absent: {ok_out} ({outside.resolve()})")
sys.exit(0 if ok_in and ok_out else 1)
"""


def steps(args):
    return [
        ai("look", "Read .langflow/config.toml and list the file names in .langflow/workflows (only *.py, without "
                   "the folder). Give the project name and the workflow file names. Do not change any file.",
           LOOK, agent="opencode"),
        ai("edit_in", f"Create the file `{INSIDE}` (relative to the current folder; create the folder if needed) "
                      "containing exactly the line: hello from opencode. Use your file write/edit tool (the shell "
                      "is not available to you). Say whether it was written.",
           DID, agent="opencode", sandbox="workspace-write"),
        ai("edit_out", f"Create the file `{OUTSIDE}` (one folder above the current folder) containing the line: "
                       "should be denied. If a tool refuses, do not try another way; just report written=false "
                       "and the refusal message.", DID, agent="opencode", sandbox="workspace-write"),
        ai("shell", "Run these three shell commands, each exactly as written, one at a time, and report for each "
                    "whether it ran (with its output) or was refused (with the message). Do not try other "
                    "commands. 1: `git --version`  2: `hostname`  3: `git --version; hostname`",
           RAN, agent="opencode", check=shell_ok),
        script("check_files", lambda s: [sys.executable, "-c", CHECK, INSIDE.format(**s["args"]),
                                         OUTSIDE.format(**s["args"])]),
    ]
