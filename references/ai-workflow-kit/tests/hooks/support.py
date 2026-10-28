"""Helpers for the hook tests: run a hook script on a JSON payload in a temp project, build that project."""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.kb.project import Project

KIT_ROOT = Path(__file__).resolve().parents[2]
HOOKS = KIT_ROOT / 'engine' / 'hooks'
GROUPS = ('tracker-decisions', 'tracker-tests', 'tracker-lessons', 'tracker-modules', 'ops-rules')
STORES = ('tracker-decisions', 'tracker-tests', 'tracker-lessons')

RULES = [
    {'match': r'publish --dry-run', 'action': 'allow', 'reason': 'A dry run changes nothing.'},
    {'match': r'\bpublish\b', 'action': 'deny-without-grant', 'grant': 'deploy',
     'reason': 'Deploys change the live system.'},
    {'match': r'\bdrop table\b', 'action': 'ask', 'reason': 'This deletes data.'},
]
KIT = {
    'kb': {'lessons_group': 'tracker-lessons'},
    'repos': [{'name': 'main', 'path': '.'}, {'name': 'code', 'path': 'code', 'watch': True}],
    'grants': [{'name': 'deploy', 'max_minutes': 30}],
    'guard_rules': RULES,
}


def clean_env(root, **extra):
    env = {k: v for k, v in os.environ.items()
           if k not in ('CLAUDE_PROJECT_DIR', 'KB_HOOK_ROOT', 'KB_HOOK_REPOS', 'AIKIT_PROJECT_ROOT')}
    env['KB_HOOK_ROOT'] = str(root)
    env.update(extra)
    return env


def run_script(script, root, payload=None, *flags, raw=None, env=None, folder=HOOKS):
    """Run engine/hooks/<script>.py -> (exit code, parsed JSON or None, stdout, stderr)."""
    text = raw if raw is not None else json.dumps(payload)
    done = subprocess.run([sys.executable, '-X', 'utf8', str(folder / f'{script}.py'), *flags], input=text,
                          capture_output=True, encoding='utf-8', env=env or clean_env(root), timeout=300)
    out = done.stdout.strip()
    try:
        data = json.loads(out) if out else None
    except ValueError:
        data = None
    return done.returncode, data, out, done.stderr


def spec(data):
    """The hookSpecificOutput of a hook result (an empty dict when the hook printed nothing)."""
    return (data or {}).get('hookSpecificOutput', {})


def tool(event, name, **tool_input):
    return {'hook_event_name': event, 'session_id': 's1', 'tool_name': name, 'tool_input': tool_input}


def edit(event, rel, name='Edit'):
    return tool(event, name, file_path=rel)


def patch(rel, *more):
    text = '*** Begin Patch\n' + ''.join(f'*** Update File: {r}\n@@\n-x\n+y\n' for r in (rel, *more)) + '*** End Patch\n'
    return tool('PreToolUse', 'apply_patch', command=text)


def bash(command, event='PreToolUse'):
    return tool(event, 'Bash', command=command)


class HookCase(unittest.TestCase):
    """A temp project with a store group of every kind the hooks care about, in `self.p`."""

    KIT = KIT
    GROUPS = GROUPS
    STORES = STORES

    def setUp(self):
        self.p = Project(self.GROUPS, self.STORES, self.KIT)
        self.addCleanup(self.p.close)
        self.root = self.p.root

    def hook(self, script, payload=None, *flags, **kw):
        return run_script(script, self.root, payload, *flags, **kw)

    def store_paths(self, group):
        cfg = self.p.cfg(group)
        return cfg['source'], cfg['store']

    def grant(self, *args):
        """Run grant.py as the person would: returns (exit code, stdout)."""
        code, _, out, _ = self.hook('grant', None, *args, raw='')
        return code, out
