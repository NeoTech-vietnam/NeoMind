"""The test log (TST rows) as kit.json kb.tests configures it: `test add`, `test import-review`, coverage."""

import json
import unittest

from . import project
from .project import Project, ProjectCase, entry, kb, store

REQ, TESTS = 'tracker-requirements', 'tracker-tests'


def add(root, **kw):
    args = dict(req='REQ-SCAN-001', level='bench', cmd='make test', output='ok', result='pass', build='b1',
                reason='fixture', actor='ai')
    args.update(kw)
    return kb.test_add(root, **args)


class DefaultsTests(unittest.TestCase):
    def test_the_defaults_when_kit_json_has_no_tests_section(self):
        p = Project(groups=(), kb_json=False)
        self.addCleanup(p.close)
        p.write('kit.json', json.dumps({'kb': {'scopes': ['tracker']}}))
        project.reset_caches(p.root)
        tc = kb.tests_cfg(p.root)
        self.assertEqual(tc, {'group': None, 'req_group': None, 'id_prefix': 'TST-', 'levels': ['L0', 'L1', 'L2', 'L3'],
                              'add_levels': ['L0', 'L1', 'L2', 'L3'], 'review_level': None, 'section': 'Checks',
                              'coverage_groups': [], 'columns': {'req': 'REQ', 'level': 'Level', 'source': 'Source'}})

    def test_a_review_level_is_left_out_of_add_levels_unless_listed(self):
        p = Project(groups=(), kb_json=False, kit={'kb': {'tests': {'levels': ['a', 'b', 'c'], 'review_level': 'c'}}})
        self.addCleanup(p.close)
        self.assertEqual(kb.tests_cfg(p.root)['add_levels'], ['a', 'b'])
        p.write_kit(kb={'tests': {'add_levels': ['a', 'c']}})
        self.assertEqual(kb.tests_cfg(p.root)['add_levels'], ['a', 'c'])

    def test_a_partial_columns_setting_keeps_the_other_defaults(self):
        p = Project(groups=(), kb_json=False, kit={'kb': {'tests': {'columns': {'level': 'Tier'}}}})
        self.addCleanup(p.close)
        self.assertEqual(kb.tests_cfg(p.root)['columns'], {'req': 'REQ', 'level': 'Tier', 'source': 'Source'})


class TestAddTests(ProjectCase):
    GROUPS = ()
    SETUP = False
    KIT = {'kb': {'tests': {'group': TESTS, 'req_group': REQ, 'id_prefix': 'CHK-', 'section': 'Runs',
                            'levels': ['bench', 'field', 'pilot'], 'review_level': 'pilot'}}}

    def setUp(self):
        super().setUp()
        self.write('docs/tests.md', project.TESTS_MD.replace('## Checks', '## Runs'))
        self.p.write_registry([entry(REQ), entry('tracker-decisions'), entry(TESTS, id_pattern=r'CHK-\d{3}')])
        self.p.setup((TESTS,))

    def apply(self, proposal):
        store.review(kb, self.root, proposal['proposal'], 'approved', 'human', 'ok', group=TESTS)
        store.apply(kb, self.root, proposal['proposal'], 'ai', group=TESTS)

    def test_the_row_takes_the_configured_prefix_level_and_section(self):
        first = add(self.root)
        self.assertEqual(first['id'], 'CHK-001')
        self.assertTrue(first['after'].startswith('| CHK-001 | REQ-SCAN-001 | bench | '))
        self.assertEqual(first['after'].count(' | '), 7)
        self.apply(first)
        record = kb.get(self.root, 'CHK-001')
        self.assertEqual((record['type'], record['status'], record['section']), ('TST', 'pass', '## Runs'))
        second = add(self.root, level='field', result='fail')
        self.assertEqual(second['id'], 'CHK-002')  # Numbering continues after the applied row.
        self.apply(second)
        self.assertEqual(kb.get(self.root, 'CHK-002')['status'], 'fail')

    def test_a_level_outside_add_levels_is_rejected(self):
        before = self.p.journal(TESTS).read_bytes()
        for level in ('pilot', 'L0', ''):
            with self.subTest(level=level), self.assertRaisesRegex(kb.KBError, r'Level must be one of bench, field$'):
                add(self.root, level=level)
        self.assertEqual(self.p.journal(TESTS).read_bytes(), before)

    def test_explicit_add_levels_replace_the_default_list(self):
        self.p.write_kit(kb={'tests': {'add_levels': ['bench', 'pilot']}})
        self.assertEqual(add(self.root, level='pilot')['id'], 'CHK-001')
        with self.assertRaisesRegex(kb.KBError, r'Level must be one of bench, pilot$'):
            add(self.root, level='field')

    def test_the_result_must_be_pass_partial_or_fail(self):
        for result in ('ok', 'Pass', ''):
            with self.subTest(result=result), self.assertRaisesRegex(kb.KBError, 'result must be one of pass, partial, fail'):
                add(self.root, result=result)
        self.assertTrue(add(self.root, result='partial')['after'].rstrip().endswith('| Partial |'))

    def test_the_requirement_must_be_a_req_record(self):
        for req, message in [('REQ-SCAN-999', 'ID not found'), ('D1', 'is not a REQ record'), ('', 'is not a REQ record')]:
            with self.subTest(req=req), self.assertRaisesRegex(kb.KBError, message):
                add(self.root, req=req)

    def test_text_cells_stay_on_one_line_and_escape_pipes(self):
        p = add(self.root, cmd='make | tee build.log', output='flash 97.9%\nram ok', date='2026-02-03')
        self.assertIn('| 2026-02-03 |', p['after'])
        self.assertIn('make \\| tee build.log', p['after'])
        self.assertIn('flash 97.9% ram ok', p['after'])
        self.assertNotIn('\n', p['after'].rstrip('\n'))
        for field in ('cmd', 'output', 'build'):
            with self.subTest(field=field), self.assertRaisesRegex(kb.KBError, 'must be nonempty'):
                add(self.root, **{field: '  '})

    def test_a_section_that_is_not_in_the_document_is_an_error(self):
        self.p.write_kit(kb={'tests': {'section': 'Checks'}})
        with self.assertRaisesRegex(store.StoreError, 'Section not found: Checks'):
            add(self.root)

    def test_the_log_group_comes_from_the_config_or_the_group_argument(self):
        self.p.write_kit(kb={'tests': {'group': None}})
        with self.assertRaisesRegex(kb.KBError, 'test add needs --group, or kb.tests.group in kit.json'):
            add(self.root)
        self.assertEqual(add(self.root, group=TESTS)['id'], 'CHK-001')

    def test_the_command_line_takes_the_same_settings(self):
        code, result = self.cli('test', 'add', '--req', 'REQ-SCAN-001', '--level', 'bench', '--cmd', 'make',
                                '--output', 'ok', '--result', 'pass', '--build', 'b1', '--reason', 'r', '--actor', 'ai')
        self.assertEqual((code, result['id']), (0, 'CHK-001'))
        code, result = self.cli('test', 'add', '--req', 'REQ-SCAN-001', '--level', 'pilot', '--cmd', 'make',
                                '--output', 'ok', '--result', 'pass', '--build', 'b1', '--reason', 'r', '--actor', 'ai')
        self.assertEqual(code, 2)
        self.assertIn('Level must be one of bench, field', result['error'])
        code, result = self.cli('test', 'add', '--level', 'bench', '--reason', 'r')
        self.assertEqual(code, 2)
        self.assertIn('test add needs --req, --cmd, --output, --result, --build, --actor', result['error'])


class ImportReviewTests(ProjectCase):
    GROUPS = (REQ,)
    KIT = {'kb': {'tests': {'review_id_pattern': r'CASE-\d+', 'review_status_column': 'Outcome', 'scope': 'ops'}}}

    SHEET = ('# Test review\n\n## Cases\n\n| ID | Step | Requirement | Outcome |\n| --- | --- | --- | --- |\n'
             '| CASE-1 | Scan a parcel | REQ-SCAN-001 | Pass |\n| CASE-2 | Scan two | REQ-SCAN-002 | Fail |\n')

    def test_the_id_pattern_status_column_and_scope_come_from_the_config(self):
        self.write('docs/cases.md', self.SHEET)
        result = kb.test_import_review(self.root, 'docs/cases.md', 'ops-cases', 'fixture', id_prefix='RV-')
        self.assertEqual(result['group_records'], 2)
        cfg = kb.load_config(self.root, 'ops-cases')
        self.assertEqual((cfg['scope'], cfg['id_pattern'], cfg['status_column'], cfg['id_prefix'], cfg['type']),
                         ('ops', r'CASE-\d+', 'Outcome', 'RV-', 'TST'))
        self.assertEqual((cfg['mode'], cfg['parser'], cfg['approval_status']),
                         ('read-only', 'id-table', 'not-stated-in-source'))
        self.assertEqual((kb.get(self.root, 'RV-CASE-1')['status'], kb.get(self.root, 'RV-CASE-2')['status']),
                         ('pass', 'fail'))
        self.assertEqual(kb.get(self.root, 'RV-CASE-1')['scope'], 'ops')

    def test_rows_that_do_not_match_the_configured_pattern_give_no_group(self):
        self.write('docs/cases.md', self.SHEET.replace('CASE-', 'TC-'))
        before = self.p.registry_path.read_bytes()
        with self.assertRaisesRegex(kb.KBError, r'has no rows matching CASE-\\d\+'):
            kb.test_import_review(self.root, 'docs/cases.md', 'ops-cases', 'fixture')
        self.assertEqual(self.p.registry_path.read_bytes(), before)

    def test_the_scope_defaults_to_the_first_configured_scope(self):
        self.p.write_kit(kb={'tests': {'scope': None}})
        self.write('docs/cases.md', self.SHEET)
        kb.test_import_review(self.root, 'docs/cases.md', 'ops-cases', 'fixture')
        self.assertEqual(kb.load_config(self.root, 'ops-cases')['scope'], 'tracker')

    def test_a_missing_source_a_taken_name_and_a_bad_prefix_are_refused(self):
        self.write('docs/cases.md', self.SHEET)
        kb.test_import_review(self.root, 'docs/cases.md', 'ops-cases', 'fixture')
        before = self.p.registry_path.read_bytes()
        for source, group, prefix, message in [('docs/none.md', 'ops-x', '', 'Source unavailable'),
                                               ('docs/cases.md', 'ops-cases', '', 'already exists'),
                                               ('docs/cases.md', 'ops-y', 'bad prefix', 'Invalid id_prefix')]:
            with self.subTest(message=message), self.assertRaisesRegex(kb.KBError, message):
                kb.test_import_review(self.root, source, group, 'fixture', id_prefix=prefix)
        self.assertEqual(self.p.registry_path.read_bytes(), before)

    def test_the_command_line_needs_source_and_group(self):
        self.write('docs/cases.md', self.SHEET)
        code, result = self.cli('test', 'import-review', '--reason', 'r', '--group', 'ops-cases')
        self.assertEqual(code, 2)
        self.assertIn('needs --source and --group', result['error'])
        code, result = self.cli('test', 'import-review', '--reason', 'r', '--group', 'ops-cases',
                                '--source', 'docs/cases.md', '--id-prefix', 'RV-')
        self.assertEqual((code, result['added']), (0, 'ops-cases'))
        self.assertEqual(self.cli('get', 'RV-CASE-2')[1]['status'], 'fail')


REQS2 = '''# Requirements

## Parcels

| ID | Description | Origin | Tier | Status |
| --- | --- | --- | --- | --- |
| R2-001 | Needs field proof | Plan | field | Draft |
| R2-002 | Bench is enough | Plan | bench | Draft |
| R2-003 | Named only in a review text | Plan | field | Draft |
| R2-004 | No origin and no test | — | bench | Draft |
| R2-005 | Blocked one | Plan | field | Blocked |
| R2-006 | Failed only | Plan | bench | Draft |
| R2-007 | Reviewed | Plan | field | Draft |
| R2-008 | Untested | Plan | field | Draft |
'''
REVIEW2 = '''# Review

## Cases

| ID | Condition | Requirement | Result |
| --- | --- | --- | --- |
| TC-1 | Reviewed on site | R2-007 | Pass |
| TC-2 | Check that R2-003 works |  | Pass |
'''


class CoverageTests(ProjectCase):
    GROUPS = ()
    SETUP = False
    KIT = {'kb': {'tests': {'group': TESTS, 'req_group': 'tracker-reqs2', 'levels': ['bench', 'field'],
                            'review_level': 'field', 'add_levels': ['bench', 'field'], 'coverage_groups': ['tracker-reqs2'],
                            'columns': {'req': 'Requirement', 'level': 'Tier', 'source': 'Origin'}}}}

    def setUp(self):
        super().setUp()
        self.write('docs/reqs2.md', REQS2)
        self.write('docs/tests.md', project.TESTS_MD.replace('| REQ | Level |', '| Requirement | Tier |'))
        self.write('docs/review2.md', REVIEW2)
        reqs = entry(REQ, group='tracker-reqs2', source='docs/reqs2.md', id_pattern=r'R2-\d{3}',
                     expected_ids=[f'R2-00{n}' for n in range(1, 9)])
        self.p.write_registry([reqs, entry(TESTS)])
        self.p.setup((TESTS,))
        kb.test_import_review(self.root, 'docs/review2.md', 'tracker-review-2', 'fixture', id_prefix='R2-')
        for req, level, result in [('R2-001', 'bench', 'pass'), ('R2-002', 'field', 'pass'),
                                   ('R2-006', 'bench', 'fail')]:
            proposal = add(self.root, req=req, level=level, result=result)
            store.review(kb, self.root, proposal['proposal'], 'approved', 'human', 'ok', group=TESTS)
            store.apply(kb, self.root, proposal['proposal'], 'ai', group=TESTS)

    def test_levels_and_columns_come_from_the_config(self):
        c = kb.coverage(self.root)  # The group comes from kb.tests.req_group.
        self.assertEqual(c['group'], 'tracker-reqs2')
        self.assertEqual(c['met'], ['R2-002', 'R2-003', 'R2-007'])  # A higher level than needed is enough.
        self.assertEqual(c['partial'], ['R2-001', 'R2-006'])  # Tested at a lower level / not passed.
        self.assertEqual(c['none'], ['R2-004', 'R2-008'])
        self.assertEqual(c['blocked'], ['R2-005'])
        self.assertEqual(c['no_source'], ['R2-004'])
        self.assertEqual(c['counts'], {'met': 3, 'partial': 2, 'none': 2, 'blocked': 1, 'no_source': 1})

    def test_with_the_default_column_names_the_same_data_reads_differently(self):
        # Control: the config is what makes the result above, not a coincidence of the data.
        self.p.write_kit(kb={'tests': {'columns': {'req': 'REQ', 'level': 'Level', 'source': 'Source'}}})
        c = kb.coverage(self.root)
        self.assertEqual(c['no_source'], [f'R2-00{n}' for n in range(1, 9)])  # No `Source` column at all.
        self.assertNotEqual(c['met'], ['R2-002', 'R2-003', 'R2-007'])

    def test_a_review_row_without_a_level_column_counts_at_the_review_level(self):
        self.p.write_kit(kb={'tests': {'review_level': 'bench'}})
        c = kb.coverage(self.root)
        self.assertNotIn('R2-007', c['met'])  # Passed at `bench` only, and R2-007 needs `field`.
        self.assertIn('R2-007', c['partial'])

    def test_contested_reports_coverage_only_for_the_listed_groups(self):
        self.assertEqual(kb.contested(self.root)['coverage'],
                         {'tracker-reqs2': {'met': 3, 'partial': 2, 'none': 2, 'blocked': 1, 'no_source': 1}})
        self.p.write_kit(kb={'tests': {'coverage_groups': []}})
        self.assertEqual(kb.contested(self.root)['coverage'], {})

    def test_the_command_line_and_the_missing_group(self):
        code, result = self.cli('coverage')
        self.assertEqual((code, result['met']), (0, ['R2-002', 'R2-003', 'R2-007']))
        code, result = self.cli('coverage', '--group', 'tracker-reqs2')
        self.assertEqual(code, 0)
        self.p.write_kit(kb={'tests': {'req_group': None}})
        code, result = self.cli('coverage')
        self.assertEqual(code, 2)
        self.assertIn('coverage needs --group, or kb.tests.req_group in kit.json', result['error'])
        with self.assertRaisesRegex(kb.KBError, 'No REQ records in tracker-tests'):
            kb.coverage(self.root, TESTS)


if __name__ == '__main__':
    unittest.main()
