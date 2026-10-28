"""Claude/Codex agent parity: the generator on a fixture project, with tiers from kit.json or from a tiers file."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.hooks.support import KIT_ROOT

sys.path.insert(0, str(KIT_ROOT / 'engine' / 'agents'))
import sync_agents  # noqa: E402

try:
    import tomllib
except ImportError:  # Python 3.10
    tomllib = None

TIERS = {'H': {'claude': 'opus', 'codex': 'gpt-6.1-sol', 'codex_effort': 'high'},
         'L': {'claude': 'haiku', 'codex': 'gpt-6-luna', 'codex_effort': 'low'}}
ASSIGN = {'alpha': 'H', 'beta': 'L'}
ALPHA = ('---\nname: alpha\ndescription: Does "alpha" work.\ntools: Read, Bash\nmodel: sonnet\n---\n\n'
         'Read `CLAUDE.md` first.\n\n## Rules\n\n- Path `C:\\x\\y` stays.\n')
BETA = '---\nname: beta\ndescription: Beta.\ntools: Read\n---\n\nBeta body.\n'


class SyncBase(unittest.TestCase):
    KIT = {'agents': {'tiers': TIERS, 'assign': ASSIGN}}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / '.claude/agents').mkdir(parents=True)
        (self.root / '.codex/agents').mkdir(parents=True)
        (self.root / 'kit.json').write_text(json.dumps(self.KIT), encoding='utf-8')
        (self.root / '.claude/agents/alpha.md').write_text(ALPHA, encoding='utf-8')
        (self.root / '.claude/agents/beta.md').write_text(BETA, encoding='utf-8')

    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sync_agents.main([*args, '--root', str(self.root)])
        self.out = out.getvalue()
        return code


class SyncTest(SyncBase):
    def test_write_sets_models_and_generates_codex(self):
        self.assertEqual(self.run_main('--check'), 1)
        self.assertEqual(self.run_main('--write'), 0)
        self.assertEqual(self.run_main('--check'), 0)
        alpha = (self.root / '.claude/agents/alpha.md').read_text(encoding='utf-8')
        self.assertIn('\nmodel: opus\n', alpha)
        self.assertIn('\ntools: Read, Bash\n', alpha)  # the Claude tools line is kept
        beta = (self.root / '.claude/agents/beta.md').read_text(encoding='utf-8')
        self.assertIn('\nmodel: haiku\n---', beta)
        self.assertIn('\ntools: Read\n', beta)
        text = (self.root / '.codex/agents/alpha.toml').read_text(encoding='utf-8')
        if tomllib:
            codex = tomllib.loads(text)
            self.assertEqual((codex['name'], codex['model'], codex['model_reasoning_effort']),
                             ('alpha', 'gpt-6.1-sol', 'high'))
            self.assertEqual(codex['description'], 'Does "alpha" work.')
            self.assertIn('Read `AGENTS.md` first.', codex['developer_instructions'])
            self.assertIn('C:\\x\\y', codex['developer_instructions'])
            self.assertIn('## Rules', codex['developer_instructions'])
            # Codex agent files have no read-only setting: only the documented keys are written
            self.assertEqual(sorted(codex), ['description', 'developer_instructions', 'model',
                                             'model_reasoning_effort', 'name'])
        else:
            self.assertIn('name = "alpha"', text)

    def test_control_drift_orphans_and_missing_tiers_are_reported(self):
        self.run_main('--write')
        path = self.root / '.codex/agents/alpha.toml'
        path.write_text(path.read_text(encoding='utf-8').replace('first.', 'later.'), encoding='utf-8')
        (self.root / '.codex/agents/ghost.toml').write_text('name = "ghost"\n', encoding='utf-8')
        (self.root / '.claude/agents/gamma.md').write_text('---\nname: gamma\ndescription: G.\n---\nG\n',
                                                          encoding='utf-8')
        changes, problems = sync_agents.plan(self.root)
        self.assertIn(path, changes)
        self.assertTrue(any('ghost.toml' in p for p in problems))
        self.assertTrue(any(p.startswith('gamma: no tier') for p in problems))
        self.assertEqual(self.run_main('--check'), 1)
        self.assertEqual(self.run_main('--write'), 1, 'a problem write cannot fix keeps exit 1')

    def test_an_assigned_agent_without_a_file_is_a_problem(self):
        (self.root / 'kit.json').write_text(json.dumps({'agents': {'tiers': TIERS, 'assign': {**ASSIGN, 'ghost': 'L'}}}),
                                            encoding='utf-8')
        _, problems = sync_agents.plan(self.root)
        self.assertEqual(problems, ['ghost: assigned a tier but has no .claude/agents/ghost.md'])

    def test_a_file_without_frontmatter_or_with_the_wrong_name_is_refused(self):
        (self.root / '.claude/agents/alpha.md').write_text('no frontmatter\n', encoding='utf-8')
        with self.assertRaises(sync_agents.SyncError):
            sync_agents.plan(self.root)
        (self.root / '.claude/agents/alpha.md').write_text('---\nname: other\ndescription: x\n---\nB\n', encoding='utf-8')
        with self.assertRaises(sync_agents.SyncError):
            sync_agents.plan(self.root)

    def test_root_comes_from_kit_json_above_the_script_when_not_given(self):
        # run the installed-style layout: <root>/.aikit/agents/sync_agents.py
        engine = self.root / '.aikit'
        (engine).mkdir()
        for rel in ('config.py', 'agents/sync_agents.py'):
            (engine / rel).parent.mkdir(parents=True, exist_ok=True)
            (engine / rel).write_bytes((KIT_ROOT / 'engine' / rel).read_bytes())
        done = subprocess.run([sys.executable, str(engine / 'agents' / 'sync_agents.py'), '--write'],
                              capture_output=True, encoding='utf-8', cwd=tempfile.gettempdir())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue((self.root / '.codex/agents/beta.toml').is_file())

    def test_missing_kit_json_exits_2(self):
        (self.root / 'kit.json').unlink()
        self.assertEqual(self.run_main('--check'), 2)


class TiersFileTest(SyncBase):
    KIT = {'agents': {'tiers_file': '.claude/agents/_tiers.json'}}

    def setUp(self):
        super().setUp()
        (self.root / '.claude/agents/_tiers.json').write_text(
            json.dumps({'_note': 'x', 'tiers': TIERS, 'agents': ASSIGN}), encoding='utf-8')

    def test_tiers_and_assignment_come_from_the_file_and_the_file_is_not_an_agent(self):
        self.assertEqual(self.run_main('--write'), 0, self.out)
        self.assertIn('\nmodel: opus\n', (self.root / '.claude/agents/alpha.md').read_text(encoding='utf-8'))
        self.assertEqual(self.run_main('--check'), 0)
        self.assertFalse((self.root / '.codex/agents/_tiers.toml').exists())

    def test_a_broken_tiers_file_is_reported(self):
        (self.root / '.claude/agents/_tiers.json').write_text('{oops', encoding='utf-8')
        self.assertEqual(self.run_main('--check'), 2)
        self.assertIn('agents.tiers_file', self.out)


if __name__ == '__main__':
    unittest.main()
