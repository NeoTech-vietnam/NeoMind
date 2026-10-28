#!/usr/bin/env python3
"""KB hook: remind the session of the KB, guard store-owned files, ask for re-import.

  SessionStart  - add a short note: groups, records, how to query, any unavailable group.
  PreToolUse    - Edit/Write/MultiEdit of a store journal or a store export: deny (use
                  `kb.py store propose`). Of `kb.json`: ask (use add-group/remove-group).
  PostToolUse   - Edit/Write/MultiEdit of a read-only group's source: remind to review and
                  `kb.py import --group <name>`.

Contract: reads the hook JSON on stdin, prints a JSON decision or context on stdout, exits 0.
It never blocks other work: on any internal error it prints nothing (PreToolUse/PostToolUse)
or a one-line "KB unavailable" note (SessionStart). Shell writes (sed, scripts) are not seen.
The project root: KB_HOOK_ROOT, else CLAUDE_PROJECT_DIR, else the folder holding kit.json above
this script. The KB code is the `kb` folder next to this one (engine/kb).
"""

import json
import os
from pathlib import Path
import sys

HOOKS_DIR = Path(__file__).resolve().parent
TOOL_DIR = HOOKS_DIR.parent / 'kb'
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import hook_paths  # noqa: E402
from hook_paths import EDIT_TOOLS  # noqa: E402,F401  (apply_patch: Codex, see hook_paths.py)


def workspace():
    return hook_paths.project_root()


def emit(event, **fields):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, **fields}}, ensure_ascii=False))


def same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def session_note(kb, root, cfg=None):
    cfg = cfg or hook_paths.load_config(root)
    name = hook_paths.project_name(cfg)
    try:
        lint = kb.lint(root, allow_drift=True, strict=False)
    except Exception as e:  # noqa: BLE001 - a broken KB must not stop the session
        return f'{name} KB unavailable ({e}). Read the memory files as usual.'
    who = hook_paths.reviewer(cfg)
    cli = hook_paths.kb_cli(cfg)
    scopes = '|'.join(cfg['kb']['scopes']) if cfg else 'project'
    groups = ', '.join(f'{g["group"]} ({g["scope"]}, {g["records"]})' for g in lint['groups'])
    stores = [g['group'] for g in lint['groups'] if g['mode'] == 'store']
    lines = [
        f'{name} KB: {len(lint["groups"])} groups, {lint["records"]} records: {groups}.',
        f'Look up an ID or topic before asking {who} or rereading whole files: '
        f'`{cli} get <ID>` or '
        f'`... search "<words>" --scope {scopes} --type <TYPE>`. '
        'An empty search is not proof of absence.',
        f'Store groups (the KB is the source; change only via `store propose`, {who} reviews): '
        + (', '.join(stores) or 'none') + '. Every other group cites its source document.',
    ]
    for item in lint.get('unavailable_groups', []):
        lines.append(f'Unavailable: {item["error"]}')
    return '\n'.join(lines)


def guarded(kb, root, target):
    """Return (decision, reason) for an edit of target, or None."""
    who = hook_paths.reviewer(hook_paths.load_config(root))
    for cfg in kb.load_groups(root):
        source = kb.inside(root, cfg['source'])
        if cfg['mode'] == 'store':
            if same(target, kb.inside(root, cfg['store'])) or same(target, source):
                return ('deny', f'{target.name} belongs to the KB store group {cfg["group"]}. Change it with '
                        f'`kb.py store propose ... --group {cfg["group"]}`; {who} reviews, then `store apply` '
                        'rewrites the export. A hand edit shows as EXPORT DRIFT.')
    if same(target, root / kb.kbpaths.registry(root)):
        return ('ask', 'kb.json is the KB group config. Prefer `kb.py add-group` / `remove-group` '
                '(they snapshot the config); a hand edit needs a reason.')
    return None


def reminder(kb, root, target):
    cli = hook_paths.kb_cli(hook_paths.load_config(root))
    for cfg in kb.load_groups(root):
        if cfg['mode'] == 'read-only' and same(target, kb.inside(root, cfg['source'])):
            return (f'{target.name} is the source of the read-only KB group {cfg["group"]}. After the edit '
                    f'is final, run `{cli} import --group {cfg["group"]}`; '
                    'a new or removed ID needs the group entry updated (remove-group, then add-group).')
    return None


def load_kb():
    try:
        if str(TOOL_DIR) not in sys.path:
            sys.path.insert(0, str(TOOL_DIR))
        import kb
        return kb
    except Exception:  # noqa: BLE001
        return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    event = payload.get('hook_event_name')
    root = workspace()
    kb = load_kb()
    if event == 'SessionStart':
        if kb:
            note = session_note(kb, root)
        else:
            note = f'{hook_paths.project_name(hook_paths.load_config(root))} KB unavailable (tool not found).'
        emit('SessionStart', additionalContext=note)
        return
    if kb is None:
        return
    try:
        targets = hook_paths.edited_paths(payload, root)
        if event == 'PreToolUse':
            # One patch can touch several files: deny wins over ask.
            results = [r for r in (guarded(kb, root, t) for t in targets) if r]
            if results:
                result = next((r for r in results if r[0] == 'deny'), results[0])
                emit('PreToolUse', permissionDecision=result[0], permissionDecisionReason=result[1])
        elif event == 'PostToolUse':
            notes = [n for n in (reminder(kb, root, t) for t in targets) if n]
            if notes:
                emit('PostToolUse', additionalContext='\n'.join(notes))
    except Exception:  # noqa: BLE001 - never block an edit because the KB is broken
        return


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    hook_paths.run_logged('kb_guard', main, workspace())  # Logs each call to <paths.cache>/hooks/calls.log.
    sys.exit(0)
