"""The KB hooks, the action guard, the grant tool and the Antigravity adapter, on JSON payloads in a temp project.

Each hook runs as a script (`python engine/hooks/<name>.py`) with the payload on stdin, as the harness runs it.
Controls: every "denied" test has a twin that shows the same call is allowed when the guard has nothing to say.
"""

import json
import os
import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path

from tests.hooks.support import (HOOKS, KIT_ROOT, HookCase, bash, clean_env, edit, patch, run_script, spec, tool)

DOCS_RULES = 'docs/rules.md'  # the source of the read-only group `ops-rules`


class KbGuardTest(HookCase):
    def test_session_note_names_project_scopes_reviewer_and_command(self):
        code, data, _, _ = self.hook('kb_guard', {'hook_event_name': 'SessionStart', 'session_id': 's1'})
        self.assertEqual(code, 0)
        note = spec(data)['additionalContext']
        self.assertEqual(spec(data)['hookEventName'], 'SessionStart')
        self.assertIn('Parcel Tracker KB: 5 groups', note)
        self.assertIn('--scope tracker|ops --type', note)
        self.assertIn('asking Alex Doe', note)
        self.assertIn('`python .aikit/kb/kb.py get <ID>`', note)
        self.assertIn('Store groups', note)
        self.assertIn('tracker-decisions', note)

    def test_session_note_uses_the_kb_cli_of_kit_json(self):
        self.p.write_kit(kb={'cli': 'python tools/kbx.py'})
        _, data, _, _ = self.hook('kb_guard', {'hook_event_name': 'SessionStart'})
        self.assertIn('`python tools/kbx.py get <ID>`', spec(data)['additionalContext'])

    def test_session_note_when_the_kb_is_broken_still_names_the_project(self):
        self.p.registry_path.write_text('{not json', encoding='utf-8')
        code, data, _, _ = self.hook('kb_guard', {'hook_event_name': 'SessionStart'})
        self.assertEqual(code, 0)
        self.assertIn('Parcel Tracker KB unavailable', spec(data)['additionalContext'])

    def test_control_edit_of_a_store_export_is_denied_and_of_other_files_is_not(self):
        export, journal = self.store_paths('tracker-decisions')
        for rel, name in ((export, 'Edit'), (journal, 'Write'), (export, 'MultiEdit')):
            _, data, _, _ = self.hook('kb_guard', edit('PreToolUse', rel, name))
            self.assertEqual(spec(data)['permissionDecision'], 'deny', rel)
            self.assertIn('store propose', spec(data)['permissionDecisionReason'])
            self.assertIn('Alex Doe reviews', spec(data)['permissionDecisionReason'])
        # control: an unrelated file, and the read-only source of another group, are not refused
        for rel in ('code/main.py', DOCS_RULES):
            code, data, out, _ = self.hook('kb_guard', edit('PreToolUse', rel))
            self.assertEqual((code, out), (0, ''), rel)

    def test_edit_of_kb_json_asks(self):
        _, data, _, _ = self.hook('kb_guard', edit('PreToolUse', 'knowledge/kb/kb.json'))
        self.assertEqual(spec(data)['permissionDecision'], 'ask')
        self.assertIn('add-group', spec(data)['permissionDecisionReason'])

    def test_codex_patch_of_a_store_export_is_denied_and_deny_wins_over_ask(self):
        export, _ = self.store_paths('tracker-decisions')
        _, data, _, _ = self.hook('kb_guard', patch(export), '--codex')
        self.assertEqual(spec(data)['permissionDecision'], 'deny')
        _, data, _, _ = self.hook('kb_guard', patch('knowledge/kb/kb.json', export), '--codex')
        self.assertEqual(spec(data)['permissionDecision'], 'deny')
        _, data, _, _ = self.hook('kb_guard', patch('code/main.py'), '--codex')
        self.assertIsNone(data)

    def test_codex_turns_ask_into_deny_and_names_the_reviewer(self):
        _, data, _, _ = self.hook('kb_guard', patch('knowledge/kb/kb.json'), '--codex')
        self.assertEqual(spec(data)['permissionDecision'], 'deny')
        reason = spec(data)['permissionDecisionReason']
        self.assertTrue(reason.startswith('[Codex cannot ask]'))
        self.assertIn('Ask Alex Doe in chat', reason)
        # control: the same payload without --codex stays an ask
        _, data, _, _ = self.hook('kb_guard', patch('knowledge/kb/kb.json'))
        self.assertEqual(spec(data)['permissionDecision'], 'ask')

    def test_post_edit_of_a_read_only_source_reminds_to_import(self):
        _, data, _, _ = self.hook('kb_guard', edit('PostToolUse', DOCS_RULES))
        note = spec(data)['additionalContext']
        self.assertIn('`python .aikit/kb/kb.py import --group ops-rules`', note)
        # control: a post-edit of a store-owned file or a plain file adds nothing
        self.assertIsNone(self.hook('kb_guard', edit('PostToolUse', 'code/main.py'))[1])

    def test_bad_input_prints_nothing_and_exits_0(self):
        for raw in ('', 'not json', '[]', '{}'):
            code, _, out, _ = self.hook('kb_guard', raw=raw)
            self.assertEqual((code, out), (0, ''), raw)

    def test_calls_are_logged_under_the_cache_folder(self):
        self.hook('kb_guard', edit('PreToolUse', 'code/main.py'), '--codex')
        log = self.root / 'knowledge' / '.cache' / 'hooks' / 'calls.log'
        entry = json.loads(log.read_text(encoding='utf-8').splitlines()[-1])
        self.assertEqual((entry['script'], entry['client'], entry['event'], entry['tool']),
                         ('kb_guard', 'codex', 'PreToolUse', 'Edit'))
        self.assertFalse(entry['emitted'])


class RootResolutionTest(unittest.TestCase):
    """The hook finds the project from kit.json above its own folder when no environment variable is set."""

    def test_installed_hook_finds_its_project_without_environment(self):
        import contextlib
        import io
        import init
        with tempfile_dir() as tmp:
            target = Path(tmp) / 'proj'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(init.main(['init', '--target', str(target), '--name', 'Demo Project',
                                            '--owner', 'Sam Roe']), 0)
            env = {k: v for k, v in os.environ.items() if k not in ('CLAUDE_PROJECT_DIR', 'KB_HOOK_ROOT')}
            code, data, _, _ = run_script('kb_guard', target, {'hook_event_name': 'SessionStart'}, env=env,
                                          folder=target / '.aikit' / 'hooks')
            self.assertEqual(code, 0)
            self.assertIn('Demo Project KB', spec(data)['additionalContext'])
            # the environment variable wins over the folder
            other = Path(tmp) / 'other'
            other.mkdir()
            (other / 'kit.json').write_text(json.dumps({'project': {'name': 'Other One'}}), encoding='utf-8')
            env['CLAUDE_PROJECT_DIR'] = str(other)
            _, data, _, _ = run_script('kb_guard', target, {'hook_event_name': 'SessionStart'}, env=env,
                                       folder=target / '.aikit' / 'hooks')
            self.assertIn('Other One KB', spec(data)['additionalContext'])


def tempfile_dir():
    import tempfile
    return tempfile.TemporaryDirectory(prefix='hk-')


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *args],
                   check=True, capture_output=True)


@unittest.skipUnless(shutil.which('git'), 'git is needed')
class KbContextTest(HookCase):
    def setUp(self):
        super().setUp()
        code = self.root / 'code'
        code.mkdir()
        git(code, 'init', '-q')
        (code / 'a.py').write_text('a = 1\n', encoding='utf-8')
        git(code, 'add', '.')
        git(code, 'commit', '-q', '-m', 'first')

    def start_and_change(self, session='s1', change=True):
        self.hook('kb_context', {'hook_event_name': 'SessionStart', 'session_id': session})
        if change:
            (self.root / 'code' / 'new.py').write_text('b = 2\n', encoding='utf-8')

    def test_edit_context_lists_the_records_that_name_the_file(self):
        _, data, _, _ = self.hook('kb_context', edit('PreToolUse', 'src/drv/scanner.py'))
        context = spec(data)['additionalContext']
        self.assertIn('KB records that name scanner.py', context)
        self.assertIn('MOD-scanner', context)
        # control: a file no record names adds nothing; a Bash call is not an edit
        self.assertIsNone(self.hook('kb_context', edit('PreToolUse', 'src/other.py'))[1])
        self.assertIsNone(self.hook('kb_context', bash('ls'))[1])

    def test_codex_patch_gets_the_same_context(self):
        _, data, _, _ = self.hook('kb_context', patch('src/drv/scanner.py'), '--codex')
        self.assertIn('MOD-scanner', spec(data)['additionalContext'])

    def test_stop_reminder_names_the_configured_groups_levels_and_command_once(self):
        self.start_and_change()
        _, data, _, _ = self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'})
        message = data['systemMessage']
        self.assertIn('no new TST or LES proposal (code: new.py)', message)
        self.assertIn('`python .aikit/kb/kb.py test add --req <REQ-ID> --level L0..L3 ...`', message)
        self.assertIn('--group tracker-lessons', message)
        # once per session
        self.assertIsNone(self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'})[1])

    def test_control_no_reminder_without_a_change_or_without_a_watched_repo(self):
        self.start_and_change(change=False)
        self.assertIsNone(self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'})[1])
        # the change is there, but no repo is watched
        self.p.write_kit(repos=[{'name': 'main', 'path': '.'}, {'name': 'code', 'path': 'code'}])
        self.start_and_change(session='s2')
        self.assertIsNone(self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's2'})[1])

    def test_a_part_whose_group_is_not_configured_is_left_out(self):
        self.p.write_kit(kb={'lessons_group': None})
        self.start_and_change()
        _, data, _, _ = self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'})
        message = data['systemMessage']
        self.assertIn('no new TST proposal', message)
        self.assertNotIn('LES', message)
        # no test log and no lessons group: no reminder at all
        self.p.write_kit(kb={'tests': {'group': None}})
        self.start_and_change(session='s3')
        self.assertIsNone(self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's3'})[1])

    def test_a_new_entry_in_the_test_log_journal_silences_the_reminder(self):
        self.start_and_change()
        journal = self.root / self.store_paths('tracker-tests')[1]
        journal.write_bytes(journal.read_bytes() + b'\n')
        self.assertIsNone(self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'})[1])

    def test_env_repos_override_the_watch_flags(self):
        other = self.root / 'other'
        other.mkdir()
        git(other, 'init', '-q')
        (other / 'x.py').write_text('x = 1\n', encoding='utf-8')
        git(other, 'add', '.')
        git(other, 'commit', '-q', '-m', 'first')
        env = clean_env(self.root, KB_HOOK_REPOS=str(other))
        self.hook('kb_context', {'hook_event_name': 'SessionStart', 'session_id': 's1'}, env=env)
        (other / 'y.py').write_text('y = 1\n', encoding='utf-8')
        (self.root / 'code' / 'new.py').write_text('b = 2\n', encoding='utf-8')  # watched by kit.json, not by env
        _, data, _, _ = self.hook('kb_context', {'hook_event_name': 'Stop', 'session_id': 's1'}, env=env)
        self.assertIn('other: y.py', data['systemMessage'])
        self.assertNotIn('new.py', data['systemMessage'])


PLUGIN = '''
def register(api):
    api.on('post_bash', lambda kb, root, command: f'built: {command}' if 'make' in command else None)
    api.on('post_bash', lambda kb, root, command: 1 / 0)
    api.on('post_bash', lambda kb, root, command: 'second note' if 'make' in command else '')
'''


class PluginCallbackTest(HookCase):
    def setUp(self):
        super().setUp()
        self.p.write('plugins/demo.py', PLUGIN)
        self.p.write_kit(plugins=['plugins/demo.py'])

    def test_post_bash_calls_each_plugin_callback_and_joins_the_strings(self):
        _, data, _, _ = self.hook('kb_context', bash('make all', 'PostToolUse'))
        self.assertEqual(spec(data), {'hookEventName': 'PostToolUse',
                                      'additionalContext': 'built: make all\nsecond note'})

    def test_control_a_command_no_plugin_cares_about_adds_nothing_and_a_failing_plugin_is_skipped(self):
        code, data, out, _ = self.hook('kb_context', bash('ls', 'PostToolUse'))
        self.assertEqual((code, out), (0, ''))

    def test_kb_context_has_no_project_specific_build_logic(self):
        source = (HOOKS / 'kb_context.py').read_text(encoding='utf-8').lower()
        for word in ('mcuboot', 'tmisys', 'zephyr', 'build-'):
            self.assertNotIn(word, source)
        self.assertIn("hooks.get('post_bash'", source)


class GrantTest(HookCase):
    def grant_file(self):
        return self.root / '.claude' / 'grants' / 'deploy.json'

    def test_grant_writes_the_file_with_the_fields_and_default_minutes(self):
        code, out = self.grant('deploy', 'grant')
        self.assertEqual(code, 0, out)
        g = json.loads(self.grant_file().read_text(encoding='utf-8'))
        self.assertEqual(sorted(g), ['expires_epoch', 'granted_epoch', 'granted_local', 'minutes'])
        self.assertEqual(g['minutes'], 5)
        self.assertAlmostEqual(g['expires_epoch'] - g['granted_epoch'], 300, delta=1)
        self.assertIn('GRANTED', out)
        self.assertIn('ACTIVE', self.grant('deploy', 'status')[1])
        self.assertIn('ACTIVE', self.grant('deploy')[1])  # status is the default

    def test_control_minutes_above_the_cap_or_below_one_are_refused_and_write_nothing(self):
        for minutes in ('31', '0', '-3', 'abc'):
            code, out = self.grant('deploy', 'grant', minutes)
            self.assertEqual(code, 1, minutes)
            self.assertFalse(self.grant_file().exists(), minutes)
        self.assertEqual(self.grant('deploy', 'grant', '30')[0], 0)  # the cap itself is allowed

    def test_unknown_grant_is_refused(self):
        for name in ('ghost', '../x'):
            code, out = self.grant(name, 'grant', '5')
            self.assertEqual(code, 2, name)
            self.assertIn('not declared', out)
        self.assertFalse((self.root / '.claude').exists())

    def test_revoke_removes_the_grant_and_is_quiet_when_none_exists(self):
        self.grant('deploy', 'grant', '5')
        self.assertEqual(self.grant('deploy', 'revoke')[0], 0)
        self.assertFalse(self.grant_file().exists())
        self.assertEqual(self.grant('deploy', 'revoke')[0], 0)
        self.assertIn('No grant', self.grant('deploy', 'status')[1])

    def test_read_grant_never_raises_and_ignores_expired_or_broken_files(self):
        sys.path.insert(0, str(HOOKS))
        try:
            import grant
        finally:
            sys.path.remove(str(HOOKS))
        self.assertIsNone(grant.read_grant(self.root, 'deploy'))
        path = self.grant_file()
        path.parent.mkdir(parents=True)
        for text in ('{broken', '[]', '{"expires_epoch": "soon"}', json.dumps({'expires_epoch': time.time() - 5})):
            path.write_text(text, encoding='utf-8')
            self.assertIsNone(grant.read_grant(self.root, 'deploy'), text)
        path.write_text(json.dumps({'expires_epoch': time.time() + 60}), encoding='utf-8')
        self.assertIsNotNone(grant.read_grant(self.root, 'deploy'))
        for name in ('../deploy', '', None, 'a/b'):
            self.assertIsNone(grant.read_grant(self.root, name))


class ActionGuardTest(HookCase):
    def decide(self, command, *flags):
        _, data, _, _ = self.hook('action_guard', bash(command), *flags)
        return spec(data)

    def test_control_deny_without_grant_denies_without_one_and_allows_with_one(self):
        out = self.decide('./publish.sh --prod')
        self.assertEqual(out['permissionDecision'], 'deny')
        reason = out['permissionDecisionReason']
        self.assertIn('Deploys change the live system.', reason)
        self.assertIn('`python .aikit/hooks/grant.py deploy grant 5`', reason)
        self.assertIn('Alex Doe', reason)
        # the person grants it, in their own terminal
        self.assertEqual(self.grant('deploy', 'grant', '5')[0], 0)
        self.assertEqual(self.decide('./publish.sh --prod'), {})
        # revoke closes it again
        self.grant('deploy', 'revoke')
        self.assertEqual(self.decide('./publish.sh --prod')['permissionDecision'], 'deny')

    def test_an_expired_grant_does_not_count(self):
        path = self.root / '.claude' / 'grants' / 'deploy.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'expires_epoch': time.time() - 1}), encoding='utf-8')
        self.assertEqual(self.decide('publish now')['permissionDecision'], 'deny')

    def test_the_first_matching_rule_wins(self):
        self.assertEqual(self.decide('publish --dry-run'), {})  # rule 1 (allow) before rule 2 (deny-without-grant)
        out = self.decide('psql -c "drop table x"')
        self.assertEqual((out['permissionDecision'], out['permissionDecisionReason']),
                         ('ask', '[action-guard] This deletes data.'))
        self.assertEqual(self.decide('ls -la'), {})  # no rule matches

    def test_codex_turns_ask_into_deny(self):
        out = self.decide('psql -c "drop table x"', '--codex')
        self.assertEqual(out['permissionDecision'], 'deny')
        self.assertIn('Ask Alex Doe in chat', out['permissionDecisionReason'])

    def test_a_broken_rule_asks_instead_of_letting_the_command_through(self):
        self.p.write_kit(guard_rules=[{'match': '([bad', 'action': 'allow'}])
        self.assertEqual(self.decide('ls')['permissionDecision'], 'ask')

    def test_control_commands_that_create_or_extend_a_grant_are_denied_even_with_a_valid_grant(self):
        self.grant('deploy', 'grant', '5')
        creating = [
            'python .aikit/hooks/grant.py deploy grant 60',
            'python .aikit/hooks/grant.py deploy grant',
            'python .aikit\\hooks\\grant.py deploy grant 5',
            'cd x && python "$CLAUDE_PROJECT_DIR/.aikit/hooks/grant.py" deploy grant 5',
            'echo {} > .claude/grants/deploy.json',
            'cp /tmp/g.json .claude/grants/deploy.json',
            'python -c "open(\'.claude/grants/deploy.json\',\'w\').write(\'{}\')"',
            'python -c "import sys; sys.path.insert(0,\'.aikit/hooks\'); import grant"',
            'python .aikit/hooks/grant.py deploy status; python -c "print(1)"',
            'tee .claude/grants/deploy.json < x.json',
            'cat .claude/grants/deploy.json > .claude/grants/other.json',
        ]
        for command in creating:
            out = self.decide(command)
            self.assertEqual(out.get('permissionDecision'), 'deny', command)
            self.assertIn('Only the person grants', out['permissionDecisionReason'], command)

    def test_status_revoke_and_reading_the_grant_pass(self):
        passing = [
            'python .aikit/hooks/grant.py deploy status',
            'python .aikit/hooks/grant.py deploy revoke',
            'python .aikit/hooks/grant.py deploy',
            'git diff .aikit/hooks/grant.py',
            'cat .claude/grants/deploy.json',
            'ls .claude/grants',
            'git status --short .claude/grants',
        ]
        for command in passing:
            self.assertEqual(self.decide(command), {}, command)

    def test_control_edits_of_the_grants_and_the_two_guard_files_are_denied(self):
        for rel in ('.claude/grants/deploy.json', '.claude/grants/new.json', '.aikit/hooks/grant.py',
                    '.aikit/hooks/action_guard.py'):
            for name in ('Edit', 'Write', 'MultiEdit'):
                out = spec(self.hook('action_guard', edit('PreToolUse', rel, name))[1])
                self.assertEqual(out.get('permissionDecision'), 'deny', (rel, name))
        # an absolute path and a Codex patch are caught as well
        absolute = str(self.root / '.claude' / 'grants' / 'x.json')
        self.assertEqual(spec(self.hook('action_guard', edit('PreToolUse', absolute))[1])['permissionDecision'], 'deny')
        out = spec(self.hook('action_guard', patch('src/a.py', '.aikit/hooks/grant.py'), '--codex')[1])
        self.assertEqual(out['permissionDecision'], 'deny')
        # control: other files, other hook files and kit.json are not protected
        for rel in ('src/a.py', 'kit.json', '.aikit/hooks/kb_guard.py', '.claude/settings.json', '.claude/grants.md'):
            code, data, out, _ = self.hook('action_guard', edit('PreToolUse', rel))
            self.assertEqual((code, out), (0, ''), rel)

    def test_protected_paths_follow_the_engine_folder_name(self):
        self.p.write_kit(paths={'engine': 'tools/ai'})
        out = spec(self.hook('action_guard', edit('PreToolUse', 'tools/ai/hooks/grant.py'))[1])
        self.assertEqual(out['permissionDecision'], 'deny')
        self.assertEqual(self.hook('action_guard', edit('PreToolUse', '.aikit/hooks/grant.py'))[2], '')
        self.assertIn('tools/ai/hooks/grant.py deploy grant 5',
                      self.decide('publish now')['permissionDecisionReason'])

    def test_unreadable_kit_json_still_blocks_grant_creation_and_asks_for_the_rest(self):
        (self.root / 'kit.json').write_text('{oops', encoding='utf-8')
        self.assertEqual(self.decide('python .aikit/hooks/grant.py deploy grant 5')['permissionDecision'], 'deny')
        self.assertEqual(self.decide('ls')['permissionDecision'], 'ask')

    def test_other_tools_and_events_are_ignored(self):
        self.assertEqual(self.hook('action_guard', tool('PreToolUse', 'Read', file_path='x'))[2], '')
        self.assertEqual(self.hook('action_guard', bash('publish now', 'PostToolUse'))[2], '')
        for raw in ('', 'nope'):
            self.assertEqual(self.hook('action_guard', raw=raw)[:3:2], (0, ''))


class AntigravityTest(HookCase):
    def run_ag(self, name, **args):
        code, data, out, _ = self.hook('antigravity', {'toolCall': {'name': name, 'args': args}})
        self.assertEqual(code, 0)
        return data

    def test_run_command_follows_the_guard_rules_and_grants(self):
        data = self.run_ag('run_command', CommandLine='publish now')
        self.assertEqual(data['decision'], 'deny')
        self.assertIn('grant.py deploy grant 5', data['reason'])
        self.grant('deploy', 'grant', '5')
        self.assertEqual(self.run_ag('run_command', CommandLine='publish now'), {'decision': 'allow', 'reason': ''})
        self.assertEqual(self.run_ag('run_command', CommandLine='python .aikit/hooks/grant.py deploy grant 9')['decision'],
                         'deny')

    def test_edit_of_a_store_export_is_denied_by_the_kb_guard(self):
        export, journal = self.store_paths('tracker-decisions')
        for name in ('replace_file_content', 'write_to_file'):
            data = self.run_ag(name, TargetFile=str(self.root / export))
            self.assertEqual(data['decision'], 'deny', name)
            self.assertTrue(data['reason'].startswith('[kb-guard]'))
        self.assertEqual(self.run_ag('write_to_file', TargetFile=str(self.root / journal))['decision'], 'deny')
        self.assertEqual(self.run_ag('write_to_file', TargetFile='knowledge/kb/kb.json')['decision'], 'ask')

    def test_edit_of_a_grant_file_is_denied_and_other_edits_are_allowed(self):
        self.assertEqual(self.run_ag('write_to_file', TargetFile=str(self.root / '.claude/grants/deploy.json'))['decision'],
                         'deny')
        for name, args in (('write_to_file', {'TargetFile': str(self.root / 'src' / 'a.py')}),
                           ('write_to_file', {}), ('view_file', {'AbsolutePath': 'x'}),
                           ('run_command', {'CommandLine': 'ls'})):
            self.assertEqual(self.run_ag(name, **args), {'decision': 'allow', 'reason': ''}, name)

    def test_bad_input_is_allowed(self):
        code, data, out, _ = self.hook('antigravity', raw='not json')
        self.assertEqual((code, data), (0, {'decision': 'allow', 'reason': ''}))


if __name__ == '__main__':
    unittest.main()
