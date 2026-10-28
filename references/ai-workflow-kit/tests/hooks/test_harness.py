"""`init.py harness` and the harness step of `init`: .claude/settings.json, .codex/hooks.json, .agents/hooks.json."""

import contextlib
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import init as kit

CLAUDE_EVENTS = {
    'SessionStart': [(None, ['kb_guard', 'kb_context'])],
    'PreToolUse': [('Bash', ['action_guard']), ('Edit|Write|MultiEdit', ['action_guard', 'kb_guard', 'kb_context'])],
    'PostToolUse': [('Edit|Write|MultiEdit', ['kb_guard']), ('Bash', ['kb_context'])],
    'Stop': [(None, ['kb_context'])],
}


def run(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            code = kit.main(list(argv))
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue()


def snapshot(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(Path(root).rglob('*')) if p.is_file() and '__pycache__' not in p.parts}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


class HarnessCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='hn-')
        self.addCleanup(self._tmp.cleanup)
        self.target = Path(self._tmp.name) / 'proj'

    def init(self, *extra):
        return run('init', '--target', str(self.target), '--name', 'Demo', '--owner', 'Sam Roe', *extra)

    def harness(self):
        return run('harness', '--target', str(self.target))


class ClaudeSettingsTest(HarnessCase):
    def test_init_writes_the_claude_hooks_with_the_documented_commands(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertIn('created: .claude/settings.json', out)
        settings = read(self.target / '.claude' / 'settings.json')
        got = {}
        for event, groups in settings['hooks'].items():
            got[event] = [(g.get('matcher'), [h['command'] for h in g['hooks']]) for g in groups]
        want = {event: [(m, [f'python "$CLAUDE_PROJECT_DIR/.aikit/hooks/{s}.py"' for s in scripts])
                        for m, scripts in groups] for event, groups in CLAUDE_EVENTS.items()}
        self.assertEqual(got, want)
        for groups in settings['hooks'].values():
            for group in groups:
                self.assertTrue(all(h['type'] == 'command' for h in group['hooks']))
        deny = settings['permissions']['deny']
        for tool in ('Edit', 'Write'):
            for path in ('.claude/grants/**', '.aikit/hooks/grant.py', '.aikit/hooks/action_guard.py'):
                self.assertIn(f'{tool}({path})', deny)

    def test_control_second_run_changes_nothing(self):
        self.init()
        before = snapshot(self.target)
        code, out = self.harness()
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot(self.target), before)
        self.assertIn('unchanged: .claude/settings.json', out)
        self.assertIn('unchanged: .codex/hooks.json', out)
        self.assertNotIn('re-trust', out)
        code, out = self.init()
        self.assertEqual(snapshot(self.target), before)
        self.assertIn('unchanged: .claude/settings.json', out)

    def test_control_an_existing_settings_file_keeps_everything_that_is_not_a_kit_hook(self):
        mine = {
            'model': 'sonnet',
            'env': {'A': '1'},
            'permissions': {'allow': ['Bash(make test)'], 'deny': ['Edit(secret.txt)']},
            'hooks': {
                'SessionStart': [{'hooks': [{'type': 'command', 'command': 'echo hi'}]}],
                'PreToolUse': [
                    {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'python mine.py'},
                                                  {'type': 'command',
                                                   'command': 'python "$CLAUDE_PROJECT_DIR/.aikit/hooks/old_guard.py"'}]},
                    {'matcher': 'Read', 'hooks': [{'type': 'command', 'command': 'python read_hook.py'}]},
                ],
                'Notification': [{'hooks': [{'type': 'command', 'command': 'notify'}]}],
                'PostToolUse': [{'matcher': 'Bash', 'hooks': [
                    {'type': 'command', 'command': 'python "$CLAUDE_PROJECT_DIR/.aikit/hooks/gone.py"'}]}],
            },
        }
        (self.target / '.claude').mkdir(parents=True)
        path = self.target / '.claude' / 'settings.json'
        path.write_text(json.dumps(mine, indent=4), encoding='utf-8')
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertIn('changed: .claude/settings.json', out)
        got = read(path)
        self.assertEqual(got['model'], 'sonnet')
        self.assertEqual(got['env'], {'A': '1'})
        self.assertEqual(got['permissions']['allow'], ['Bash(make test)'])
        self.assertEqual(got['permissions']['deny'][0], 'Edit(secret.txt)')
        self.assertIn('Write(.claude/grants/**)', got['permissions']['deny'])
        self.assertEqual(got['hooks']['Notification'], mine['hooks']['Notification'])
        self.assertEqual(got['hooks']['SessionStart'][0], mine['hooks']['SessionStart'][0])
        self.assertEqual(got['hooks']['PreToolUse'][0],
                         {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'python mine.py'}]})
        self.assertEqual(got['hooks']['PreToolUse'][1], mine['hooks']['PreToolUse'][1])
        everything = json.dumps(got)
        self.assertNotIn('old_guard.py', everything)  # a stale kit entry is replaced...
        self.assertNotIn('gone.py', everything)
        self.assertEqual(everything.count('hooks/action_guard.py'), 2 + 2)  # ...and not duplicated (hooks + 2 denies)
        again = path.read_bytes()
        self.assertEqual(self.harness()[0], 0)
        self.assertEqual(path.read_bytes(), again)

    def test_invalid_settings_json_is_refused_and_left_alone(self):
        (self.target / '.claude').mkdir(parents=True)
        path = self.target / '.claude' / 'settings.json'
        path.write_text('{ not json', encoding='utf-8')
        code, out = self.init()
        self.assertEqual(code, 2)
        self.assertIn('not valid JSON', out)
        self.assertEqual(path.read_text(encoding='utf-8'), '{ not json')
        self.assertFalse((self.target / '.codex' / 'hooks.json').exists(), 'nothing is written after a refusal')

    def test_harness_needs_the_engine_installed(self):
        self.init()
        (self.target / '.aikit' / 'hooks' / 'action_guard.py').unlink()
        code, out = self.harness()
        self.assertEqual(code, 2)
        self.assertIn('action_guard.py', out)
        empty = Path(self._tmp.name) / 'empty'
        empty.mkdir()
        self.assertEqual(run('harness', '--target', str(empty))[0], 2)

    def test_custom_engine_folder_name_is_used_everywhere(self):
        self.target.mkdir()
        (self.target / 'kit.json').write_text(json.dumps({'paths': {'engine': 'tools/ai'}}), encoding='utf-8')
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertTrue((self.target / 'tools' / 'ai' / 'hooks' / 'kb_guard.py').is_file())
        text = (self.target / '.claude' / 'settings.json').read_text(encoding='utf-8')
        self.assertIn('$CLAUDE_PROJECT_DIR/tools/ai/hooks/kb_guard.py', text)
        self.assertIn('Edit(tools/ai/hooks/grant.py)', text)
        self.assertNotIn('.aikit', text)
        self.assertIn('/tools/ai/hooks/kb_guard.py --codex', (self.target / '.codex' / 'hooks.json').read_text(encoding='utf-8'))


class CodexHooksTest(HarnessCase):
    def test_codex_commands_are_absolute_forward_slash_and_unquoted(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        hooks = read(self.target / '.codex' / 'hooks.json')['hooks']
        base = self.target.absolute().as_posix() + '/.aikit/hooks'
        commands = [h['command'] for groups in hooks.values() for g in groups for h in g['hooks']]
        self.assertEqual(len(commands), 9)
        for command in commands:
            self.assertRegex(command, r'^python [A-Za-z]:/' if os.name == 'nt' else r'^python /')
            self.assertTrue(command.startswith(f'python {base}/'), command)
            self.assertTrue(command.endswith('.py --codex'), command)
            self.assertNotIn('\\', command)
            self.assertNotIn('"', command)
            self.assertNotIn("'", command)
        matchers = [(event, g.get('matcher')) for event, groups in hooks.items() for g in groups]
        self.assertIn(('PreToolUse', 'Bash'), matchers)
        self.assertIn(('PreToolUse', 'apply_patch|Edit|Write'), matchers)
        self.assertIn(('PostToolUse', 'apply_patch|Edit|Write'), matchers)
        self.assertNotIn(('PreToolUse', 'Edit|Write|MultiEdit'), matchers)

    def test_the_retrust_line_is_printed_when_the_codex_file_changes_and_not_otherwise(self):
        _, out = self.init()
        self.assertIn('/hooks', out)
        self.assertIn('re-trust', out)
        self.assertNotIn('re-trust', self.harness()[1])
        # a changed hook (a stale command) is repaired and the person is told to re-trust again
        path = self.target / '.codex' / 'hooks.json'
        data = read(path)
        data['hooks']['Stop'][0]['hooks'][0]['command'] = 'python X:/old/.aikit/hooks/kb_context.py --codex'
        path.write_text(json.dumps(data), encoding='utf-8')
        code, out = self.harness()
        self.assertIn('changed: .codex/hooks.json', out)
        self.assertIn('re-trust', out)

    def test_codex_file_keeps_other_hooks(self):
        (self.target / '.codex').mkdir(parents=True)
        mine = {'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'python C:/me/stop.py'}]}]}, 'x': 1}
        (self.target / '.codex' / 'hooks.json').write_text(json.dumps(mine), encoding='utf-8')
        self.assertEqual(self.init()[0], 0)
        got = read(self.target / '.codex' / 'hooks.json')
        self.assertEqual(got['x'], 1)
        self.assertEqual(got['hooks']['Stop'][0], mine['hooks']['Stop'][0])
        self.assertEqual(len(got['hooks']['Stop']), 2)

    def test_a_path_with_a_space_gets_a_warning(self):
        self.target = Path(self._tmp.name) / 'my proj'
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertIn('warning: the project path contains a space', out)


class HarnessChoiceTest(HarnessCase):
    def test_only_enabled_harnesses_get_a_file(self):
        self.assertEqual(self.init('--harness', 'codex')[0], 0)
        self.assertFalse((self.target / '.claude' / 'settings.json').exists())
        self.assertTrue((self.target / '.codex' / 'hooks.json').is_file())
        self.assertFalse((self.target / '.agents').exists())

    def test_antigravity_gets_one_adapter_block_when_enabled(self):
        self.assertEqual(self.init('--harness', 'claude,antigravity')[0], 0)
        self.assertFalse((self.target / '.codex' / 'hooks.json').exists())
        data = read(self.target / '.agents' / 'hooks.json')
        self.assertEqual(list(data), ['aikit-guards'])
        block = data['aikit-guards']
        self.assertTrue(block['enabled'])
        self.assertEqual([g['matcher'] for g in block['PreToolUse']],
                         ['run_command', 'replace_file_content', 'write_to_file'])
        command = block['PreToolUse'][0]['hooks'][0]['command']
        self.assertEqual(command, f'python {self.target.absolute().as_posix()}/.aikit/hooks/antigravity.py')
        before = snapshot(self.target)
        self.assertEqual(self.harness()[0], 0)
        self.assertEqual(snapshot(self.target), before)

    def test_antigravity_keeps_other_blocks(self):
        (self.target / '.agents').mkdir(parents=True)
        (self.target / '.agents' / 'hooks.json').write_text(json.dumps({'mine': {'enabled': False}}), encoding='utf-8')
        self.assertEqual(self.init('--harness', 'antigravity')[0], 0)
        self.assertEqual(sorted(read(self.target / '.agents' / 'hooks.json')), ['aikit-guards', 'mine'])

    def test_no_harness_enabled_writes_nothing(self):
        self.assertEqual(self.init('--harness', 'codex')[0], 0)
        path = self.target / 'kit.json'
        cfg = read(path)
        cfg['harnesses'] = {'claude': False, 'codex': False, 'antigravity': False}
        path.write_text(json.dumps(cfg), encoding='utf-8')
        code, out = self.harness()
        self.assertEqual(code, 0)
        self.assertIn('no harness is enabled', out)


class GeneratedCommandsRunTest(HarnessCase):
    """The commands in the generated files are runnable as written, from any working folder."""

    def run_command(self, command, cwd):
        env = {k: v for k, v in os.environ.items() if k not in ('KB_HOOK_ROOT', 'CLAUDE_PROJECT_DIR')}
        done = subprocess.run(command, input=json.dumps({'hook_event_name': 'SessionStart', 'session_id': 's'}),
                              shell=True, capture_output=True, encoding='utf-8', env=env, cwd=cwd, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_claude_and_codex_session_start_commands_return_a_note(self):
        self.init()
        claude = read(self.target / '.claude' / 'settings.json')['hooks']['SessionStart'][0]['hooks'][0]['command']
        command = claude.replace('$CLAUDE_PROJECT_DIR', self.target.absolute().as_posix())
        out = self.run_command(command, self._tmp.name)
        self.assertIn('Demo KB', out['hookSpecificOutput']['additionalContext'])
        codex = read(self.target / '.codex' / 'hooks.json')['hooks']['SessionStart'][0]['hooks'][0]['command']
        out = self.run_command(codex, self._tmp.name)
        self.assertIn('Demo KB', out['hookSpecificOutput']['additionalContext'])
        log = self.target / 'knowledge' / '.cache' / 'hooks' / 'calls.log'
        clients = [json.loads(line)['client'] for line in log.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(clients, ['claude', 'codex'])


if __name__ == '__main__':
    unittest.main()
