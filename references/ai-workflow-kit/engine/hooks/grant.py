#!/usr/bin/env python3
"""Time-limited grants: permission for the AI to run a command that action_guard otherwise denies.

A grant is declared in kit.json `grants` (`name`, `max_minutes`) and used by a `guard_rules` entry with
`"action": "deny-without-grant"`. The person starts it from their own terminal; action_guard lets the
command through only while the grant is valid, and refuses every attempt by the AI to create one.

    python <engine>/hooks/grant.py <name> grant [MINUTES]   # default 5, at most max_minutes
    python <engine>/hooks/grant.py <name> revoke
    python <engine>/hooks/grant.py <name> status

The grant is the file `.claude/grants/<name>.json` in the project root.
Exit codes: 0 ok; 1 bad input (minutes out of range); 2 unknown grant or unreadable kit.json.
"""

import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import hook_paths  # noqa: E402

GRANTS_DIR = '.claude/grants'
DEFAULT_MINUTES = 5
NAME_OK = re.compile(r'[A-Za-z0-9_-]+')


def grant_file(root, name):
    """Path of the grant file, or None when the name is not a plain word (no path tricks)."""
    if not isinstance(name, str) or not NAME_OK.fullmatch(name):
        return None
    return Path(root) / GRANTS_DIR / f'{name}.json'


def read_grant(root, name):
    """The grant if it exists and has not expired, else None. Never raises."""
    try:
        path = grant_file(root, name)
        if path is None:
            return None
        with open(path, encoding='utf-8') as f:
            g = json.load(f)
        if float(g.get('expires_epoch', 0)) > time.time():
            return g
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None


def remaining_text(g):
    """'4m left, until 11:57' - rounded up, so a live grant never shows 0m."""
    left_min = -(-int(float(g['expires_epoch']) - time.time()) // 60)
    h, m = divmod(left_min, 60)
    left = f'{h}h{m:02d}m' if h else f'{m}m'
    return f'{left} left, until {datetime.fromtimestamp(float(g["expires_epoch"])):%H:%M}'


def declared(cfg, name):
    for g in cfg.get('grants', []):
        if isinstance(g, dict) and g.get('name') == name:
            return g
    return None


def main(argv, root=None):
    root = Path(root) if root else hook_paths.project_root()
    cfg = hook_paths.load_config(root)
    if cfg is None:
        print(f'kit.json in {root} cannot be read.')
        return 2
    if len(argv) < 2:
        print(__doc__)
        return 2
    name, cmd = argv[1], (argv[2] if len(argv) > 2 else 'status')
    spec = declared(cfg, name)
    path = grant_file(root, name)
    if spec is None or path is None:
        names = ', '.join(g.get('name', '?') for g in cfg.get('grants', [])) or 'none'
        print(f'Grant "{name}" is not declared in kit.json grants (declared: {names}).')
        return 2
    cap = spec['max_minutes']
    if cmd == 'grant':
        try:
            minutes = int(argv[3]) if len(argv) > 3 else min(DEFAULT_MINUTES, cap)
        except ValueError:
            print('MINUTES must be a whole number, for example 5.')
            return 1
        if not 1 <= minutes <= cap:
            print(f'MINUTES must be between 1 and {cap} for grant "{name}".')
            return 1
        now = time.time()
        g = {'granted_epoch': now, 'expires_epoch': now + minutes * 60, 'minutes': minutes,
             'granted_local': f'{datetime.fromtimestamp(now):%Y-%m-%d %H:%M}'}
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(g, f, indent=2)
        print(f'Grant "{name}" GRANTED to the AI for {minutes} min - {remaining_text(g)}.')
        print(f'Revoke any time: python {hook_paths.engine_rel(cfg)}/hooks/grant.py {name} revoke')
        return 0
    if cmd == 'revoke':
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        print(f'Grant "{name}" REVOKED - the AI cannot run the guarded command.')
        return 0
    if cmd == 'status':
        g = read_grant(root, name)
        print(f'Grant "{name}" ACTIVE - {remaining_text(g)}.' if g
              else f'No grant "{name}" - the AI cannot run the guarded command.')
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv))
