"""Settings that come from kit.json: kb.scopes, kb.extra_types and kb.hidden_types."""

import json
import unittest

from . import project
from .project import Project, ProjectCase, entry, kb, kbpaths, run_cli_raw

DEC, OPS = 'tracker-decisions', 'ops-decisions'


class ScopeTests(ProjectCase):
    GROUPS = (DEC, OPS)

    def test_scopes_are_the_ones_in_kit_json(self):
        self.assertEqual(kbpaths.scopes(self.root), ('tracker', 'ops'))
        self.p.write_kit(kb={'scopes': ['tracker', 'ops', 'policy']})
        self.assertEqual(kbpaths.scopes(self.root), ('tracker', 'ops', 'policy'))

    def test_a_group_in_a_scope_that_is_not_listed_is_rejected(self):
        self.p.write_kit(kb={'scopes': ['tracker']})
        with self.assertRaisesRegex(kb.KBError, 'Invalid scope for ops-decisions; choose from tracker'):
            kb.lint(self.root)
        code, result = self.cli('lint')
        self.assertEqual(code, 2)
        self.assertIn('Invalid scope for ops-decisions', result['error'])

    def test_a_new_group_with_an_unknown_scope_is_refused_and_kb_json_stays(self):
        before = self.p.registry_path.read_bytes()
        with self.assertRaisesRegex(kb.KBError, 'Invalid scope for ops-exceptions; choose from tracker, ops'):
            kb.add_group(self.root, entry('ops-exceptions', scope='nowhere'), 'fixture add')
        self.assertEqual(self.p.registry_path.read_bytes(), before)
        self.assertFalse(kb.store_path(self.root, entry('ops-exceptions')).exists())

    def test_search_by_scope_checks_the_name(self):
        self.assertEqual([r['id'] for r in kb.search(self.root, 'dock', scope='ops')['results']], ['D104'])
        self.assertEqual(kb.search(self.root, 'dock', scope='tracker')['results'], [])
        with self.assertRaisesRegex(kb.KBError, 'Invalid scope: nowhere'):
            kb.search(self.root, 'dock', scope='nowhere')

    def test_the_command_line_offers_only_the_configured_scopes(self):
        done = run_cli_raw(self.root, 'search', 'dock', '--scope', 'nowhere')
        self.assertEqual(done.returncode, 2)
        self.assertIn('invalid choice', done.stderr)
        self.assertIn('choose from tracker, ops', done.stderr)
        self.assertEqual(done.stdout, '')
        code, result = self.cli('search', 'dock', '--scope', 'ops')
        self.assertEqual((code, [r['id'] for r in result['results']]), (0, ['D104']))
        self.p.write_kit(kb={'scopes': ['tracker', 'ops', 'policy']})
        code, result = self.cli('search', 'dock', '--scope', 'policy')
        self.assertEqual((code, result['results']), (0, []))

    def test_every_record_carries_the_scope_of_its_group(self):
        self.assertEqual({kb.get(self.root, 'D1')['scope'], kb.get(self.root, 'D101')['scope']}, {'tracker', 'ops'})
        code, result = self.cli('get', 'D105')
        self.assertEqual(result['scope'], 'ops')


class DefaultScopeTests(unittest.TestCase):
    def test_without_kb_scopes_the_one_scope_is_project(self):
        p = Project(groups=(), kb_json=False)
        self.addCleanup(p.close)
        p.write('kit.json', json.dumps({'project': {'name': 'Parcel Tracker'}}))
        project.reset_caches(p.root)
        self.assertEqual(kbpaths.scopes(p.root), ('project',))
        p.write_registry([entry(DEC, scope='project')])
        p.setup()
        self.assertEqual(kb.get(p.root, 'D1')['scope'], 'project')
        p.write_registry([entry(DEC, scope='tracker')])
        with self.assertRaisesRegex(kb.KBError, 'choose from project'):
            kb.lint(p.root)


class ExtraTypeTests(ProjectCase):
    GROUPS = (DEC,)

    def note_group(self, **extra):
        return entry('ops-exceptions', type='NOTE', **extra)

    def test_a_type_outside_the_built_ins_needs_kb_extra_types(self):
        with self.assertRaisesRegex(kb.KBError, 'Invalid type for ops-exceptions; choose from DEC, REQ'):
            kb.add_group(self.root, self.note_group(), 'fixture add')
        self.p.write_kit(kb={'extra_types': ['NOTE']})
        kb.add_group(self.root, self.note_group(), 'fixture add')
        self.assertEqual(kb.get(self.root, 'OPS-EXC-1')['type'], 'NOTE')

    def test_types_are_the_built_ins_plus_the_extra_ones(self):
        self.assertEqual(kb.types(self.root), kb.TYPES)
        self.p.write_kit(kb={'extra_types': ['NOTE', 'DEC', 'ISSUE']})  # DEC is built in: not added again.
        self.assertEqual(kb.types(self.root), kb.TYPES + ('NOTE', 'ISSUE'))

    def test_a_name_listed_twice_is_one_type(self):
        self.p.write_kit(kb={'extra_types': ['NOTE', 'ISSUE', 'NOTE']})
        self.assertEqual(kb.types(self.root), kb.TYPES + ('NOTE', 'ISSUE'))

    def test_search_accepts_an_extra_type_and_rejects_an_unknown_one(self):
        self.p.write_kit(kb={'extra_types': ['NOTE']})
        kb.add_group(self.root, self.note_group(), 'fixture add')
        hits = kb.search(self.root, 'damaged', kind='NOTE')['results']
        self.assertEqual([r['id'] for r in hits], ['OPS-EXC-2'])
        with self.assertRaisesRegex(kb.KBError, 'Invalid type: ISSUE'):
            kb.search(self.root, 'damaged', kind='ISSUE')
        code, result = self.cli('search', 'damaged', '--type', 'NOTE')
        self.assertEqual((code, [r['id'] for r in result['results']]), (0, ['OPS-EXC-2']))

    def test_removing_an_extra_type_makes_its_group_invalid(self):
        self.p.write_kit(kb={'extra_types': ['NOTE']})
        kb.add_group(self.root, self.note_group(), 'fixture add')
        self.p.write_kit(kb={'extra_types': []})
        with self.assertRaisesRegex(kb.KBError, 'Invalid type for ops-exceptions'):
            kb.lint(self.root)


class HiddenTypeTests(ProjectCase):
    """Many generated rows of one type would crowd the answers out; they answer only to --type."""

    GROUPS = (DEC,)
    KIT = {'kb': {'hidden_types': ['CODE']}}

    def setUp(self):
        super().setUp()
        self.write('docs/decisions.md', project.DECISIONS_MD.replace('Fixture decision one', 'Parcel size policy'))
        kb.import_source(self.root, DEC)
        self.write('docs/sizes.md', '# Sizes\n\n## Sizes\n\n| Code | Cause |\n| ---- | ----- |\n'
                                    '| 1 | parcel size small, see D1 |\n'
                                    '| 2 | parcel size large, `src/sizes/table.py` |\n')
        kb.add_group(self.root, entry('ops-exceptions', group='ops-sizes', source='docs/sizes.md',
                                      section='## Sizes', id_prefix='SIZE-', expected_ids=['SIZE-1', 'SIZE-2']),
                     'fixture add')

    def test_search_leaves_them_out_and_says_how_many(self):
        result = kb.search(self.root, 'size')
        self.assertEqual([r['id'] for r in result['results']], ['D1'])
        self.assertEqual(result['hidden_rows'], 2)
        self.assertEqual(result['hidden_note'], '2 CODE rows also match; add --type CODE to see them')

    def test_type_asks_for_them(self):
        result = kb.search(self.root, 'size', kind='CODE')
        self.assertEqual(sorted(r['id'] for r in result['results']), ['SIZE-1', 'SIZE-2'])
        self.assertNotIn('hidden_rows', result)
        self.assertNotIn('hidden_note', result)

    def test_a_word_only_in_hidden_rows_gives_no_hit_but_the_note(self):
        result = kb.search(self.root, 'large')
        self.assertEqual(result['results'], [])
        self.assertEqual(result['hidden_rows'], 1)
        self.assertIn('not proof of absence', result['empty_result_note'])

    def test_filters_apply_to_the_hidden_count_too(self):
        self.assertEqual(kb.search(self.root, 'size', status='as-built')['hidden_rows'], 2)
        self.assertEqual(kb.search(self.root, 'size', status='decided').get('hidden_rows'), None)
        by_scope = kb.search(self.root, 'size', scope='ops')
        self.assertEqual((by_scope['results'], by_scope['hidden_rows']), ([], 2))
        self.assertEqual(kb.search(self.root, 'size', scope='tracker').get('hidden_rows'), None)

    def test_get_still_answers_by_id(self):
        self.assertEqual(kb.get(self.root, 'SIZE-2')['type'], 'CODE')

    def test_trace_and_file_skip_them_unless_nothing_is_hidden(self):
        self.assertEqual(kb.trace(self.root, 'D1')['linked_from'], [])
        self.assertEqual([x['id'] for x in kb.trace(self.root, 'SIZE-1')['links_to']], ['D1'])
        self.assertEqual(kb.file_records(self.root, 'src/sizes/table.py')['records'], [])
        self.p.write_kit(kb={'hidden_types': []})
        self.assertEqual([x['id'] for x in kb.trace(self.root, 'D1')['linked_from']], ['SIZE-1'])
        self.assertEqual([r['id'] for r in kb.file_records(self.root, 'src/sizes/table.py')['records']],
                         ['SIZE-2'])
        self.assertEqual({r['id'] for r in kb.search(self.root, 'size')['results']}, {'D1', 'SIZE-1', 'SIZE-2'})

    def test_lint_still_counts_them(self):
        self.assertEqual(kb.lint(self.root)['records'], 11 + 2)

    def test_the_command_line_shows_the_note_and_the_type_filter(self):
        code, result = self.cli('search', 'size')
        self.assertEqual((code, result['hidden_rows']), (0, 2))
        code, result = self.cli('search', 'size', '--type', 'CODE')
        self.assertEqual((code, len(result['results'])), (0, 2))
        code, result = self.cli('file', 'src/sizes/table.py')
        self.assertEqual((code, result['records']), (0, []))

    def test_several_hidden_types_are_named_in_order(self):
        self.p.write_kit(kb={'hidden_types': ['DEC', 'CODE']})
        self.assertEqual(kb.hidden_types(self.root), {'DEC', 'CODE'})
        result = kb.search(self.root, 'size')
        self.assertEqual(result['results'], [])
        self.assertEqual(result['hidden_note'], '3 CODE, DEC rows also match; add --type CODE to see them')

    def test_a_hidden_name_that_is_no_type_hides_nothing(self):
        self.p.write_kit(kb={'hidden_types': ['NOPE']})
        self.assertEqual({r['id'] for r in kb.search(self.root, 'size')['results']}, {'D1', 'SIZE-1', 'SIZE-2'})
        self.assertNotIn('hidden_rows', kb.search(self.root, 'size'))


if __name__ == '__main__':
    unittest.main()
