#!/usr/bin/env python3
"""KB context hook: bring KB records to the work, run plugin callbacks after a shell command, remind to log.

  PreToolUse  (Edit|Write|MultiEdit) - add the KB records that name the file being edited
              (lessons, module map, requirements, rules) to the model's context.
  PostToolUse (Bash) - call every plugin callback registered with `api.on('post_bash', fn)` as
              `fn(kb, root, command)`; a returned string becomes additional context.
  SessionStart / Stop - at the first Stop after files changed in the watched repos (kit.json `repos` with
              `"watch": true`) with no new test-log or lessons proposal, show the user one reminder per session.
              The test log is `kb.tests.group`, the lessons log is `kb.lessons_group`; a part whose group is
              not set in kit.json is left out.

Contract: reads the hook JSON on stdin, prints JSON or nothing, always exits 0; an internal error
prints nothing. Overrides for tests: KB_HOOK_ROOT, KB_HOOK_REPOS (os.pathsep list).
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

HOOKS_DIR = Path(__file__).resolve().parent
TOOL_DIR = HOOKS_DIR.parent / 'kb'
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import hook_paths  # noqa: E402
from hook_paths import EDIT_TOOLS  # noqa: E402  (apply_patch: Codex, see hook_paths.py)

MAX_RECORDS = 6


def workspace():
    return hook_paths.project_root()


def repos(root, cfg=None):
    if os.environ.get('KB_HOOK_REPOS'):
        return [Path(p) for p in os.environ['KB_HOOK_REPOS'].split(os.pathsep) if p]
    cfg = cfg or hook_paths.load_config(root)
    return [Path(root) / r['path'] for r in (cfg or {}).get('repos', []) if r.get('watch') is True]


def emit(event, **fields):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, **fields}}, ensure_ascii=False))


def git(repo, *args):
    r = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, encoding='utf-8', timeout=30)
    return r.stdout if r.returncode == 0 else ''


# ---------------------------------------------------------------- edit context

def file_context(kb, root, path):
    found = kb.file_records(root, path)['records']
    if not found:
        return None
    lines = [f'KB records that name {Path(path).name}; read them before editing (LES = lesson, MOD = module, '
             f'REQ = requirement, RULE = rule):']
    for r in found[:MAX_RECORDS]:
        text = ' '.join(r['text'].split())
        lines.append(f'- {r["id"]} ({r["type"]}, {r["citation"]}): {text[:240]}')
    if len(found) > MAX_RECORDS:
        lines.append(f'- … {len(found) - MAX_RECORDS} more: `kb.py file "{path}"`')
    return '\n'.join(lines)


# ---------------------------------------------------------------- plugin callbacks after a shell command

def post_bash(kb, root, command):
    """Run each plugin callback for post_bash; return their strings joined, or None."""
    notes = []
    for fn in kb.plugins(root).hooks.get('post_bash', []):
        try:
            note = fn(kb, root, command)
        except Exception:  # noqa: BLE001 - a plugin must never block work
            continue
        if isinstance(note, str) and note.strip():
            notes.append(note)
    return '\n'.join(notes) or None


# ---------------------------------------------------------------- session reminder

def log_groups(cfg):
    """(tests group, lessons group), each None when kit.json does not set it."""
    kbcfg = (cfg or {}).get('kb', {})
    tests = (kbcfg.get('tests') or {}).get('group') or None
    lessons = kbcfg.get('lessons_group') or None
    return tests, lessons


def level_text(tests_cfg):
    """`V0..V3` when add_levels is a run of levels, else the levels joined with `|`."""
    add, levels = tests_cfg['add_levels'], tests_cfg['levels']
    run = bool(add) and add[0] in levels and levels[levels.index(add[0]):][:len(add)] == add
    return f'{add[0]}..{add[-1]}' if run and len(add) > 1 else '|'.join(add)


def state_path(root, session, cfg=None):
    cfg = cfg or hook_paths.load_config(root)
    safe = re.sub(r'[^A-Za-z0-9_-]', '_', session or 'unknown')
    return cfg['paths']['cache'] / 'hooks' / f'session-{safe}.json'


def snapshot(kb, root, cfg=None):
    cfg = cfg or hook_paths.load_config(root)
    changed = {str(r): sorted(git(r, 'status', '--porcelain').splitlines()) for r in repos(root, cfg) if r.exists()}
    journals = {}
    # A new entry in any of these store groups counts as "logged": the test log, the lessons log, and any
    # extra store groups named in kit.json kb.log_groups (e.g. a second lessons list).
    watched = [g for g in log_groups(cfg) if g] + list(((cfg or {}).get('kb', {}).get('log_groups') or []))
    for group in kb.load_groups(root):
        if group['mode'] == 'store' and group['group'] in watched:
            path = kb.inside(root, group['store'])
            journals[group['group']] = kb.sha(path.read_bytes()) if path.exists() else ''
    return {'changed': changed, 'journals': journals}


def remember(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding='utf-8')


def stop_reminder(kb, root, session):
    cfg = hook_paths.load_config(root)
    tests, lessons = log_groups(cfg)
    if not tests and not lessons:
        return None
    path = state_path(root, session, cfg)
    now = snapshot(kb, root, cfg)
    if not path.exists():
        remember(path, {**now, 'reminded': False})
        return None
    start = json.loads(path.read_text(encoding='utf-8'))
    if start.get('reminded'):
        return None
    new = {repo: [line for line in lines if line not in start['changed'].get(repo, [])]
           for repo, lines in now['changed'].items()}
    new = {repo: lines for repo, lines in new.items() if lines}
    if not new or now['journals'] != start['journals']:
        return None
    remember(path, {**start, 'reminded': True})
    files = '; '.join(f'{Path(repo).name}: ' + ', '.join(line[3:] for line in lines[:5])
                      + (f' (+{len(lines) - 5})' if len(lines) > 5 else '') for repo, lines in new.items())
    cli = hook_paths.kb_cli(cfg)
    kinds, advice = [], []
    if tests:
        tc = kb.tests_cfg(root)
        kinds.append(tc['id_prefix'].rstrip('-') or 'TST')
        advice.append(f'If the change was checked, record it with `{cli} test add --req <REQ-ID> '
                      f'--level {level_text(tc)} ...`')
    if lessons:
        kinds.append('LES')
        advice.append(f'if something was learned, propose a LES row (`{cli} store propose add LES-NNN '
                      f'--group {lessons}`)')
    return (f'KB reminder: files changed this session with no new {" or ".join(kinds)} proposal ('
            + files + '). ' + '; '.join(advice) + '.')


def load_kb():
    if str(TOOL_DIR) not in sys.path:
        sys.path.insert(0, str(TOOL_DIR))
    import kb
    return kb


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    event, root = payload.get('hook_event_name'), workspace()
    try:
        kb = load_kb()
        if event == 'SessionStart':
            if any(log_groups(hook_paths.load_config(root))):
                remember(state_path(root, payload.get('session_id')), {**snapshot(kb, root), 'reminded': False})
        elif event == 'Stop':
            message = stop_reminder(kb, root, payload.get('session_id'))
            if message:
                print(json.dumps({'systemMessage': message}, ensure_ascii=False))
        elif event == 'PreToolUse' and payload.get('tool_name') in EDIT_TOOLS:
            contexts = [c for c in (file_context(kb, root, str(p)) for p in hook_paths.edited_paths(payload, root))
                        if c]
            if contexts:
                emit('PreToolUse', additionalContext='\n'.join(contexts))
        elif event == 'PostToolUse' and payload.get('tool_name') == 'Bash':
            command = (payload.get('tool_input') or {}).get('command', '')
            context = post_bash(kb, root, command)
            if context:
                emit('PostToolUse', additionalContext=context)
    except Exception:  # noqa: BLE001 - the KB must never block work
        return


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    hook_paths.run_logged('kb_context', main, workspace())  # Logs each call to <paths.cache>/hooks/calls.log.
    sys.exit(0)
