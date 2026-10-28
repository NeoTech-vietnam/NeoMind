#!/usr/bin/env python3
"""Action guard (PreToolUse): rules for shell commands, and protection of the grant files.

Bash: walk kit.json `guard_rules` in order; the first rule whose `match` regex is found in the command wins.
  allow               nothing happens (the command runs).
  ask                 the person is asked first (Codex cannot ask: the command is denied there).
  deny-without-grant  the command runs while the grant named in the rule is valid (see grant.py), else it
                      is denied with the exact command the person runs to start the grant.
Always denied, whatever the rules say: a Bash command that would create or extend a grant (it runs grant.py
with `grant`, or writes into `.claude/grants/`). `grant.py <name> status` and `revoke` pass.
Edit/Write/MultiEdit/apply_patch: changes to `.claude/grants/**`, `<engine>/hooks/grant.py` and
`<engine>/hooks/action_guard.py` are denied.

This is a guard against the AI acting by habit or by mistake. It reads command text, so it is not a sandbox: it
does not stop a command built to hide its own text. Keep the permission deny entries that `init.py harness`
writes, and keep the person's own terminal as the only place a grant is made.

Contract: reads the hook JSON on stdin, prints a JSON decision or nothing, exits 0.
"""

import json
import os
from pathlib import Path
import re
import sys

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import hook_paths  # noqa: E402
import grant  # noqa: E402

GRANTS_DIR = grant.GRANTS_DIR
READ_ONLY_VERBS = {'cat', 'ls', 'dir', 'type', 'head', 'tail', 'grep', 'rg', 'stat', 'wc', 'file', 'test',
                   'get-content', 'get-childitem', 'select-string', 'git'}
GIT_READ = {'status', 'diff', 'log', 'show', 'check-ignore', 'ls-files'}
UNSAFE_SHELL = re.compile(r'[>;&`]|\$\(|\|\s*(?:tee|sh|bash|zsh|python3?|py|pwsh|powershell|cmd|xargs|dd)\b', re.I)
INLINE_CODE = re.compile(r'\s-c\s|\bexec\s*\(|\beval\s*\(|__import__|\brunpy\b|\bimportlib\b|\bimport\s', re.I)


def workspace():
    return hook_paths.project_root()


def emit(event, **fields):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event, **fields}}, ensure_ascii=False))


def _norm(text):
    return text.replace('\\', '/')


def _real(path):
    return os.path.normcase(os.path.realpath(path))


def protected_paths(root, cfg):
    engine = hook_paths.engine_rel(cfg)
    return {'grants': Path(root) / GRANTS_DIR,
            'files': [Path(root) / engine / 'hooks' / 'grant.py', Path(root) / engine / 'hooks' / 'action_guard.py']}


def is_protected(root, cfg, target):
    """True when target is a grant file or one of the two guard files."""
    prot = protected_paths(root, cfg)
    real, folder = _real(target), _real(prot['grants'])
    if real == folder or real.startswith(folder + os.sep):
        return True
    return any(real == _real(p) for p in prot['files'])


def creates_grant(command):
    """True when the command would create or extend a grant, or edit the grant folder."""
    c = _norm(command)
    m = re.search(r'grant\.py', c, re.I)
    if m:
        # `grant.py <name> status` and `revoke` pass; anything that says `grant` after the file name does not.
        if re.search(r'\bgrant\b', c[m.end():], re.I) or INLINE_CODE.search(c):
            return True
    if re.search(r'\b(?:import|from)\s+grant\b|-m\s+\S*grant\b', c, re.I):
        return True
    if re.search(re.escape(GRANTS_DIR), c, re.I):
        words = c.strip().split()
        verb = words[0].lower() if words else ''
        verb = verb.rsplit('/', 1)[-1]
        read_only = verb in READ_ONLY_VERBS and not UNSAFE_SHELL.search(c)
        if verb == 'git':
            read_only = read_only and len(words) > 1 and words[1] in GIT_READ
        if not read_only:
            return True
    return False


GRANT_ADMIN = re.compile(r'''^\s*(?:python3?|py)(?:\.exe)?\s+(?:-X\s+\w+\s+)?["']?[^\s"']*grant\.py["']?'''
                         r'''\s+[\w-]+(?:\s+(?:status|revoke))?\s*$''', re.I)


def decide_bash(root, cfg, command):
    """(decision, reason) for a shell command, or None to let it run."""
    engine = hook_paths.engine_rel(cfg)
    if creates_grant(command):
        return ('deny', f'[action-guard] Only the person grants rights, from their own terminal '
                        f'(`python {engine}/hooks/grant.py <name> grant [MINUTES]`). The agent must not create, '
                        'edit or extend a grant.')
    if GRANT_ADMIN.match(_norm(command)):
        return None  # `grant.py <name> status` and `revoke` are never held back by a rule
    if cfg is None:
        return ('ask', '[action-guard] kit.json cannot be read, so the guard rules are not applied. '
                       'Fix kit.json, or confirm this command.')
    who = hook_paths.reviewer(cfg)
    for i, rule in enumerate(cfg.get('guard_rules', [])):
        try:
            if not re.search(rule['match'], command):
                continue
            action = rule['action']
            reason = rule.get('reason') or f'The command matches guard rule {i + 1}.'
            if action == 'allow':
                return None
            if action == 'ask':
                return ('ask', f'[action-guard] {reason}')
            if action == 'deny-without-grant':
                name = rule['grant']
                if grant.read_grant(root, name):
                    return None
                cap = next((g['max_minutes'] for g in cfg.get('grants', []) if g.get('name') == name), 5)
                return ('deny', f'[action-guard] {reason} It needs the grant "{name}". Ask {who} to run in their own '
                                f'terminal: `python {engine}/hooks/grant.py {name} grant {min(5, cap)}`. '
                                'The agent must not create, edit or extend a grant.')
            raise ValueError(f'unknown action {action!r}')
        except (re.error, KeyError, TypeError, ValueError) as e:
            return ('ask', f'[action-guard] guard rule {i + 1} in kit.json is broken ({e}); '
                           'the command is not checked against the rules. Fix kit.json, or confirm this command.')
    return None


def decide_edit(root, cfg, targets):
    """(decision, reason) when one of the files may not be changed by the AI, else None."""
    engine = hook_paths.engine_rel(cfg)
    for target in targets:
        if is_protected(root, cfg, target):
            return ('deny', f'[action-guard] {Path(target).name} is part of the grant guard '
                            f'({GRANTS_DIR}/ and {engine}/hooks/grant.py, action_guard.py). '
                            'Only the person changes these.')
    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return
    if not isinstance(payload, dict) or payload.get('hook_event_name') != 'PreToolUse':
        return
    root = workspace()
    cfg = hook_paths.load_config(root)
    tool = payload.get('tool_name')
    try:
        if tool == 'Bash':
            tool_input = payload.get('tool_input') or {}
            command = tool_input.get('command', '') if isinstance(tool_input, dict) else str(tool_input)
            result = decide_bash(root, cfg, command or '')
        elif tool in hook_paths.EDIT_TOOLS:
            result = decide_edit(root, cfg, hook_paths.edited_paths(payload, root))
        else:
            result = None
    except Exception as e:  # noqa: BLE001
        result = ('ask', f'[action-guard] internal error ({e}); the action was not checked.')
    if result:
        emit('PreToolUse', permissionDecision=result[0], permissionDecisionReason=result[1])


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    hook_paths.run_logged('action_guard', main, workspace())
    sys.exit(0)
