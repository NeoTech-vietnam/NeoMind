"""A project whose kb.json has an empty `groups` list (a fresh kit): every read command answers, nothing breaks."""

import json
import unittest

from .project import ProjectCase, entry, kb, store


class EmptyKbTests(ProjectCase):
    GROUPS = ()

    def test_the_registry_is_valid_and_has_no_groups(self):
        self.assertEqual(self.p.registry(), {'schema_version': 2, 'groups': []})
        self.assertEqual(kb.load_groups(self.root), [])

    def test_status_and_lint_are_ok_with_zero_records(self):
        code, status = self.cli('status')
        self.assertEqual((code, status['ok'], status['groups'], status['records']), (0, True, [], 0))
        code, lint = self.cli('lint')
        self.assertEqual((code, lint['ok'], lint['records'], lint['pending_proposals']), (0, True, 0, 0))
        self.assertNotIn('unavailable_groups', lint)

    def test_rebuild_makes_an_empty_index(self):
        result = kb.rebuild(self.root)
        self.assertEqual((result['records'], result['groups'], result['integrity']), (0, [], 'ok'))
        self.assertTrue(kb.db_path(self.root).is_file())

    def test_search_returns_nothing_with_the_usual_note(self):
        result = kb.search(self.root, 'anything')
        self.assertEqual(result['results'], [])
        self.assertIn('not proof of absence', result['empty_result_note'])
        self.assertEqual(kb.search(self.root, 'anything', scope='ops')['results'], [])
        code, result = self.cli('search', 'anything', '--type', 'DEC', '--status', 'open')
        self.assertEqual((code, result['results']), (0, []))

    def test_get_trace_and_file_find_nothing(self):
        for call in (lambda: kb.get(self.root, 'D1'), lambda: kb.trace(self.root, 'D1')):
            with self.assertRaisesRegex(kb.KBError, 'ID not found in configured KB groups: D1'):
                call()
        self.assertEqual(kb.file_records(self.root, 'src/a.py')['records'], [])

    def test_contested_is_all_empty(self):
        c = kb.contested(self.root)
        self.assertEqual({k: v for k, v in c.items() if k != 'counts'},
                         {'open_decisions': [], 'blocked': [], 'pending_proposals': [], 'unavailable_groups': [],
                          'deferred_ids': {}, 'coverage': {}})
        self.assertTrue(all(n == 0 for n in c['counts'].values()))

    def test_code_paths_and_pending_have_nothing_to_report(self):
        code, result = self.cli('lint', '--code')
        self.assertEqual((code, result['code_paths']['counts']['OK'], result['code_paths']['ok']), (0, 0, True))
        self.assertEqual(store.pending(kb, self.root), {'pending': [], 'approved_not_applied': []})

    def test_commands_that_need_a_group_say_so(self):
        for args in (('coverage',), ('store', 'status'), ('import',), ('review', 'export', '--out', 'x.xlsx')):
            with self.subTest(args=args):
                code, result = self.cli(*args)
                self.assertEqual(code, 2, result)
                self.assertFalse(result['ok'])

    def test_import_with_no_group_does_not_say_multiple(self):
        code, result = self.cli('import')
        self.assertEqual(code, 2)
        self.assertNotIn('Multiple groups', result['error'])

    def test_the_first_group_can_be_added_to_an_empty_kb(self):
        result = kb.add_group(self.root, entry('ops-rules'), 'first group')
        self.assertEqual((result['records'], result['group_records']), (4, 4))
        self.assertEqual([g['group'] for g in self.p.registry()['groups']], ['ops-rules'])
        self.assertEqual(kb.get(self.root, 'R1')['scope'], 'ops')

    def test_removing_the_last_group_gives_an_empty_kb_again(self):
        kb.add_group(self.root, entry('ops-rules'), 'first group')
        result = kb.remove_group(self.root, 'ops-rules', 'undo')
        self.assertEqual((result['records'], result['groups']), (0, []))
        self.assertEqual(self.p.registry()['groups'], [])
        self.assertEqual(kb.lint(self.root)['records'], 0)

    def test_an_empty_kb_with_an_unavailable_only_group_is_an_error_not_empty(self):
        # Control: "no groups" is fine, but "every group failed" is reported, not shown as an empty KB.
        kb.add_group(self.root, entry('ops-rules'), 'first group')
        self.p.path('docs/rules.md').unlink()
        code, result = self.cli('search', 'rule')
        self.assertEqual(code, 2)
        self.assertIn('Source unavailable', result['error'])
        code, result = self.cli('status')
        self.assertEqual(code, 0)
        self.assertFalse(result['ok'])
        self.assertEqual([g['group'] for g in result['unavailable_groups']], ['ops-rules'])


class JsonOutputTests(ProjectCase):
    GROUPS = ()

    def test_output_is_utf_8_json_without_ascii_escapes(self):
        from .project import run_cli_raw
        self.write('docs/vi.md', '# Quyết định\n\n## Decided\n\n| # | Chủ đề |\n| --- | --- |\n| D1 | Kho trung tâm |\n')
        kb.add_group(self.root, {'group': 'ops-vi', 'scope': 'ops', 'mode': 'read-only',
                                 'authority': 'original-source', 'parser': 'decision-table',
                                 'source': 'docs/vi.md', 'expected_ids': ['D1']}, 'fixture')
        done = run_cli_raw(self.root, 'get', 'D1')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('Kho trung tâm', done.stdout)
        self.assertEqual(json.loads(done.stdout)['id'], 'D1')


if __name__ == '__main__':
    unittest.main()
