"""Comprehension gate: what a gate must cover, and the record of each gate.

    python .aikit/competency/gate.py scope --project main          # core changes not yet gated
    python .aikit/competency/gate.py scope --project main --json
    python .aikit/competency/gate.py record --project main --input result.json [--person NAME]

A gate covers, for one project of `<competency>/gate_config.json`: the commits touching its core paths after the last
code gate (or after `baseline`), plus the uncommitted core changes. A code gate stores HEAD, the tree it saw (HEAD
plus the working tree of the core paths, built in a scratch index) and a `state` fingerprint of the core content, so
gated work that is committed afterwards is not asked again. A document gate (`"kind": "doc"`) covers a file the
person is about to send or sign, and does not move the code scope.

record input (JSON): {"kind": "code"|"doc", "doc": "<path, for doc>", "session": "<id>", "support": "independent|...",
"questions": [{"q": "...", "key": "A".."E", "given": "A".."E"|""}], "map_items": ["..."], "notes": "..."}.
Writes one line to `<competency>/people/<person>/gates.jsonl`. The project root comes from kit.json (or the
AIKIT_PROJECT_ROOT environment variable); the person defaults to `people.default`; scratch files go to
`<cache>/gate/`. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compkit  # noqa: E402
import ids  # noqa: E402

CHOICES = "ABCDE"


class GateError(ValueError):
    pass


def load_project(ctx, name: str) -> dict:
    cfg = compkit.read_json(ctx.comp / "gate_config.json")
    proj = cfg.get("projects", {}).get(name)
    if proj is None:
        raise GateError(f"unknown project {name!r}; known: {', '.join(cfg.get('projects', {}))}")
    return dict(proj, name=name, max_files=cfg.get("max_core_files_per_step", 5))


def git(repo: Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise GateError(f"git {' '.join(args)}: {out.stderr.strip()}")
    return out.stdout


def gates_path(ctx, person: str) -> Path:
    return ctx.comp / "people" / person / "gates.jsonl"


def last_code_gate(ctx, person: str, project: str):
    path = gates_path(ctx, person)
    if not path.is_file():
        return None
    last = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("project") == project and rec.get("kind") == "code":
            last = rec
    return last


def worktree_tree(ctx, repo: Path, core: list) -> str:
    """Tree id of HEAD with the working-tree state of the core paths (tracked, deleted, untracked) staged
    into a scratch index; the real index is not touched. The scratch index lives under <cache>/gate/."""
    scratch = ctx.cache / "gate"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))
        for args in (["read-tree", "HEAD"], ["add", "-A", "--", *core], ["write-tree"]):
            out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                                 encoding="utf-8", env=env)
            if out.returncode != 0:
                raise GateError(f"git {' '.join(args)}: {out.stderr.strip()}")
        return out.stdout.strip()


def core_state(repo: Path, tree: str, core: list) -> str:
    """Fingerprint of the core paths in a tree: the same content gives the same value, committed or not."""
    found = []
    for p in core:
        out = subprocess.run(["git", "-C", str(repo), "rev-parse", f"{tree}:{p.rstrip('/')}"],
                             capture_output=True, text=True)
        found.append(out.stdout.strip() if out.returncode == 0 else "-")
    return hashlib.sha1("\n".join(found).encode("utf-8")).hexdigest()[:12]


def empty_tree(repo: Path) -> str:
    """The empty tree of this repo's hash format: the start point when there is no baseline and no gate yet."""
    return subprocess.run(["git", "-C", str(repo), "hash-object", "-t", "tree", "--stdin"], input="",
                          capture_output=True, text=True).stdout.strip()


def has_object(repo: Path, obj: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "cat-file", "-e", obj], capture_output=True).returncode == 0


def scope(ctx, project: str, person: str) -> dict:
    proj = load_project(ctx, project)
    if not proj.get("repo") or not proj.get("core"):
        raise GateError(f"project {project!r} has no repo or core paths yet ({proj.get('open', '')}); "
                        "use a document gate")
    repo = ctx.root / proj["repo"]
    core = proj["core"]
    last = last_code_gate(ctx, person, project)
    start = last["head"] if last else proj["baseline"]
    head = git(repo, "rev-parse", "--short", "HEAD").strip()
    tree = worktree_tree(ctx, repo, core)
    state = core_state(repo, tree, core)
    gated = bool(last) and last.get("state") == state
    # Compare with the tree the last gate saw when git still has it, so a commit of gated work is not shown again.
    base = last["tree"] if last and last.get("tree") and has_object(repo, last["tree"]) else start
    base = base or empty_tree(repo)  # No baseline and no gate yet: the whole core history is in scope.
    span = f"{start}..HEAD" if start else "HEAD"
    files = [] if gated else sorted(f for f in git(repo, "diff", "--name-only", base, tree, "--", *core)
                                    .splitlines() if f)
    commits = [] if gated else [ln.split("\t", 1) for ln in
                                git(repo, "log", "--format=%h\t%s", span, "--", *core).splitlines() if ln]
    head_tree = git(repo, "rev-parse", "HEAD^{tree}").strip()
    uncommitted = [] if gated else sorted(f for f in git(repo, "diff", "--name-only", head_tree, tree, "--", *core)
                                          .splitlines() if f)
    return {"project": project, "repo": proj["repo"], "from": start, "head": head, "tree": tree, "state": state,
            "from_last_gate": bool(last), "commits": [{"hash": h, "subject": s} for h, s in commits],
            "uncommitted": uncommitted, "files": files, "max_files": proj["max_files"],
            "gated": gated or not files}


def print_scope(s: dict) -> None:
    since = "last gate" if s["from_last_gate"] else "baseline"
    print(f"project {s['project']} ({s['repo']}): {since} {s['from'] or '(start of history)'} .. HEAD {s['head']}")
    if s["gated"]:
        print("nothing to gate: no core change since then")
        return
    for c in s["commits"]:
        print(f"  commit {c['hash']} {c['subject']}")
    for f in s["uncommitted"]:
        print(f"  uncommitted {f}")
    over = " (over the limit for one step)" if len(s["files"]) > s["max_files"] else ""
    print(f"{len(s['files'])} core files changed{over}; core state {s['state']}")


def check_input(data: dict) -> None:
    kind = data.get("kind")
    if kind not in ("code", "doc"):
        raise GateError('"kind" must be "code" or "doc"')
    if kind == "doc" and not data.get("doc"):
        raise GateError('a doc gate needs "doc"')
    qs = data.get("questions") or []
    if not qs:
        raise GateError('"questions" is empty')
    for i, q in enumerate(qs, 1):
        if not q.get("q"):
            raise GateError(f"question {i}: no text")
        if q.get("key") not in tuple(CHOICES[:4]):
            raise GateError(f"question {i}: key must be A-D")
        if q.get("given", "") not in ("",) + tuple(CHOICES):
            raise GateError(f"question {i}: given must be A-E or empty")
    if ids.normalize("support", data.get("support", ids.SUPPORT[0])) not in ids.SUPPORT:
        raise GateError(f'"support" must be one of {", ".join(ids.SUPPORT)}')


def record(ctx, project: str, person: str, data: dict, now: dt.datetime) -> dict:
    load_project(ctx, project)
    data = dict(data, support=ids.normalize("support", data.get("support", ids.SUPPORT[0])))  # legacy id read once
    check_input(data)
    qs = [dict(q, ok=(q.get("given", "") == q["key"])) for q in data["questions"]]
    rec = {"date": now.date().isoformat(), "time": now.strftime("%H:%M"), "project": project,
           "kind": data["kind"], "session": data.get("session", ""), "support": data["support"],
           "score": f"{sum(q['ok'] for q in qs)}/{len(qs)}", "questions": qs,
           "map_items": data.get("map_items", []), "notes": data.get("notes", "")}
    if data["kind"] == "code":
        s = scope(ctx, project, person)
        rec.update({"from": s["from"], "head": s["head"], "tree": s["tree"], "state": s["state"],
                    "commits": [c["hash"] for c in s["commits"]], "files": s["files"]})
    else:
        rec["doc"] = data["doc"]
    path = gates_path(ctx, person)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("scope")
    sp.add_argument("--project", required=True)
    sp.add_argument("--person", default=None, help="default: people.default of kit.json")
    sp.add_argument("--json", action="store_true")
    rp = sub.add_parser("record")
    rp.add_argument("--project", required=True)
    rp.add_argument("--person", default=None, help="default: people.default of kit.json")
    rp.add_argument("--input", required=True, help="JSON file with the gate result")
    a = ap.parse_args(argv)
    try:
        ctx = compkit.load_context()
        person = a.person or ctx.person
        if a.cmd == "scope":
            s = scope(ctx, a.project, person)
            print(json.dumps(s, ensure_ascii=False, indent=2)) if a.json else print_scope(s)
        else:
            data = json.loads(Path(a.input).read_text(encoding="utf-8"))
            rec = record(ctx, a.project, person, data, dt.datetime.now())
            print(f"recorded {rec['kind']} gate {rec['score']} in "
                  f"{gates_path(ctx, person).relative_to(ctx.root).as_posix()}")
    except (GateError, compkit.ConfigError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    finally:
        ids.flush_warning()
    return 0


if __name__ == "__main__":
    sys.exit(main())
