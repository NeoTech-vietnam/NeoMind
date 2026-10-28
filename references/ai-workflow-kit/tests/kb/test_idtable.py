"""Store for any table with ID rows (id-table): requirement, backlog and test-log shapes, on a temp project."""

import unittest

from . import project
from .project import ProjectCase, entry, kb, store

DEC = 'tracker-decisions'
REQ = 'tracker-requirements'

BACKLOG = '''# Parcel Tracker — Backlog

## Backlog

| ID | Item | Priority | Status |
| --- | --- | --- | --- |
''' + ''.join(f'| B{n} | Backlog item {n} | Medium | Open |\n' for n in range(1, 9))

TEST_REVIEW = '''# Test Review Template

## 2. TC-1 — Scanning level

| ID | Condition | Run used | Value | Résultat |
| --- | --- | --- | --- | --- |
| TC-1.1 | Water 25 mL/hr | `run1` | 1 mL | Pass |
| TC-1.2 | [condition] | `[run folder]` | [value + unit] | [Pass / Partial / Fail / Not tested] |

## 3. TC-2 — Routing level

| ID | Condition | Run used | Value | Résultat |
| --- | --- | --- | --- | --- |
| TC-2.1 | x | `run` | 1 mL | Not tested |
'''


def backlog_cfg(**extra):
    return {'group': 'tracker-backlog', 'scope': 'tracker', 'mode': 'read-only', 'authority': 'original-source',
            'parser': 'id-table', 'source': 'docs/backlog-md.md', 'id_pattern': r'B\d+', 'type': 'BKL',
            'status': 'unknown', 'status_column': 'Status', 'approval_status': 'not-stated-in-source',
            'expected_ids': [f'B{n}' for n in range(1, 9)], **extra}


class IdTableTests(ProjectCase):
    GROUPS = (DEC,)
    STORES = (DEC,)

    def setUp(self):
        super().setUp()
        live = kb.load_config(self.root, DEC)
        self.port_files = {self.root / live[k]: (self.root / live[k]).read_bytes() for k in ('source', 'store')}
        self.d5 = kb.get(self.root, 'D5')
        self.write('docs/backlog-md.md', BACKLOG)

    def port_intact(self):
        self.assert_unchanged(self.port_files)
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)

    def store_group(self, cfg):
        kb.add_group(self.root, cfg, 'fixture add')
        store.transfer(kb, self.root, 'human', 'fixture transfer', group=cfg['group'])

    def approve_apply(self, group, op, rid, section, text):
        return self.p.apply_change(op, rid, section, text, group=group)

    # ------------------------------------------------------------ read-only

    def test_read_only_rows_status_and_sections(self):
        kb.add_group(self.root, entry(REQ), 'fixture add')
        lines = project.REQUIREMENTS_MD.splitlines(keepends=True)
        hw1, hw2, route = (kb.get(self.root, i) for i in ('REQ-SCAN-001', 'REQ-SCAN-002', 'REQ-ROUTE-001'))
        self.assertEqual(hw1['text'], lines[hw1['source_line'] - 1])
        self.assertEqual((hw1['status'], hw2['status'], route['status']), ('draft', 'approved', 'blocked'))
        self.assertEqual((hw1['section'], route['section']), ('## SCAN — Scanning', '## ROUTE — Routing'))
        self.assertEqual(hw2['links'], ['REQ-SCAN-001'])
        self.assertEqual(hw1['type'], 'REQ')
        self.assertEqual([r['id'] for r in kb.search(self.root, 'depot', kind='REQ', status='blocked')['results']],
                         ['REQ-ROUTE-001'])

    def test_backlog_copy_reads_every_row_open(self):
        kb.add_group(self.root, backlog_cfg(), 'fixture add')
        statuses = {kb.get(self.root, f'B{n}')['status'] for n in range(1, 9)}
        self.assertEqual(statuses, {'open'})
        self.port_intact()

    def test_bad_rows_and_config(self):
        cfg = entry(REQ)
        self.write('docs/requirements.md', project.REQUIREMENTS_MD.replace('| REQ-SCAN-002 |', '| SCAN-002 |'))
        with self.assertRaisesRegex(kb.KBError, 'Unexpected row'):
            kb.extract(self.root, cfg)
        self.write('docs/requirements.md',
                   project.REQUIREMENTS_MD + '| REQ-SCAN-001 | Again | x | L0 | Draft |\n')
        with self.assertRaisesRegex(kb.KBError, 'Duplicate source ID: REQ-SCAN-001'):
            kb.extract(self.root, cfg)
        store_mode = {'mode': 'store', 'authority': 'kb-store', 'store': 'knowledge/kb/store/x.jsonl'}
        kb.checked_group(self.root, entry(REQ, id_prefix='X-', expected_ids=['X-REQ-SCAN-001']))  # Read-only may.
        for bad in [entry(REQ, id_prefix='X-', expected_ids=['X-REQ-SCAN-001'], **store_mode),
                    entry(REQ, status_column=3),
                    entry(REQ, deferred_ids={'REQ-SCAN-001': 'r'}, **store_mode)]:
            with self.subTest(bad=bad), self.assertRaises(kb.KBError):
                kb.checked_group(self.root, bad)

    # ------------------------------------------------------------ store

    def test_transfer_edit_add_move_with_other_group_untouched(self):
        self.store_group(entry(REQ))
        source = self.p.path('docs/requirements.md')
        self.assertEqual(source.read_bytes(), project.REQUIREMENTS_MD.encode('utf-8'))
        self.assertEqual(kb.get(self.root, 'REQ-SCAN-001')['authority'], 'kb-store')
        edited = self.row('REQ-SCAN-001').rstrip('\n').replace('| Draft |', '| Approved |')
        self.approve_apply(REQ, 'edit', 'REQ-SCAN-001', None, edited)
        r = kb.get(self.root, 'REQ-SCAN-001')
        self.assertEqual((r['status'], r['approval_status']), ('approved', 'approved-in-kb'))
        self.approve_apply(REQ, 'add', 'REQ-ROUTE-002', 'ROUTE — Routing',
                           '| REQ-ROUTE-002 | Start from one command. | Plan Goal 1 | L3 | Draft |')
        self.assertEqual(kb.get(self.root, 'REQ-ROUTE-002')['section'], '## ROUTE — Routing')
        self.approve_apply(REQ, 'move', 'REQ-SCAN-002', '## ROUTE — Routing',
                           self.row('REQ-SCAN-002').rstrip('\n'))
        self.assertEqual(kb.get(self.root, 'REQ-SCAN-002')['section'], '## ROUTE — Routing')
        text = source.read_text(encoding='utf-8')
        self.assertLess(text.index('REQ-ROUTE-001'), text.index('REQ-SCAN-002'))
        self.assertTrue(kb.lint(self.root)['ok'])
        self.port_intact()

    def test_store_refusals_leave_journal_unchanged(self):
        self.store_group(entry(REQ))
        journal = store.journal(kb, self.root, kb.load_config(self.root, REQ))
        before = journal.read_bytes()
        cases = [('add', 'REQ-SCAN-9', 'SCAN — Scanning', '| REQ-SCAN-9 | x | y | L0 | Draft |'),
                 ('add', 'REQ-SCAN-003', 'SCAN — Scanning', '| REQ-SCAN-003 | too | few |'),
                 ('add', 'REQ-SCAN-003', 'Missing section', '| REQ-SCAN-003 | x | y | L0 | Draft |'),
                 ('add', 'D1', 'SCAN — Scanning', '| D1 | x | y | L0 | Draft |'),
                 ('edit', 'REQ-SCAN-001', None, '| REQ-SCAN-002 | x | y | L0 | Draft |'),
                 ('move', 'REQ-SCAN-001', 'SCAN — Scanning', self.row('REQ-SCAN-001').rstrip('\n'))]
        for case in cases:
            with self.subTest(case=case), self.assertRaises((store.StoreError, kb.KBError)):
                store.propose(kb, self.root, *case, 'fixture', 'ai', group=REQ)
        self.assertEqual(journal.read_bytes(), before)
        self.port_intact()

    def test_drift_restore_and_rollback(self):
        self.store_group(entry(REQ))
        source = self.p.path('docs/requirements.md')
        source.write_bytes(source.read_bytes() + b'Hand note.\n')
        with self.assertRaisesRegex(kb.KBError, f'{REQ}.*EXPORT DRIFT'):
            kb.lint(self.root)
        self.assertIn('EXPORT DRIFT', kb.get(self.root, 'REQ-SCAN-001')['warning'])
        self.assertNotIn('warning', kb.get(self.root, 'D5'))
        store.restore(kb, self.root, 'ai', 'fixture restore', group=REQ)
        self.approve_apply(REQ, 'add', 'REQ-SCAN-003', 'SCAN — Scanning',
                           '| REQ-SCAN-003 | Read dimensions. | Plan 3.1 | L3 | Draft |')
        result = store.rollback(kb, self.root, 'human', 'fixture rollback', group=REQ)
        cfg = kb.load_config(self.root, REQ)
        self.assertEqual((cfg['mode'], cfg['parser']), ('read-only', 'id-table'))
        self.assertIn('REQ-SCAN-003', cfg['expected_ids'])
        self.assertTrue((self.root / result['archived_journal']).exists())
        self.assertEqual(kb.get(self.root, 'REQ-SCAN-003')['authority'], 'original-source')
        self.port_intact()

    def test_backlog_transfer_is_lossless_and_cli_edit(self):
        self.store_group(backlog_cfg())
        doc = self.p.path('docs/backlog-md.md')
        self.assertEqual(doc.read_bytes(), BACKLOG.encode('utf-8'))
        row = self.row('B7').rstrip('\r\n').replace('| Open |', '| Closed |')
        text = self.write('row.txt', row)
        code, p = self.cli('store', 'propose', 'edit', 'B7', '--group', 'tracker-backlog', '--text-file', text,
                           '--reason', 'fixture', '--actor', 'ai')
        self.assertEqual(code, 0, p)
        self.cli('store', 'review', p['proposal'], '--group', 'tracker-backlog', '--decision', 'approved',
                 '--reviewed-by', 'human', '--reason', 'ok')
        code, result = self.cli('store', 'apply', p['proposal'], '--group', 'tracker-backlog', '--actor', 'ai')
        self.assertEqual(code, 0, result)
        self.assertEqual(kb.get(self.root, 'B7')['status'], 'closed')
        code, result = self.cli('store', 'propose', 'add', 'B12', '--group', 'tracker-backlog', '--section',
                                'Backlog', '--text-file', text, '--reason', 'x', '--actor', 'ai')
        self.assertEqual(code, 2)  # The row in the file is B7, not B12.
        self.port_intact()

    def test_test_review_template_cuts_into_case_records(self):
        self.write('docs/review.md', TEST_REVIEW)
        cfg = {'group': 'tracker-test-review', 'scope': 'tracker', 'mode': 'read-only',
               'authority': 'original-source', 'parser': 'id-table', 'source': 'docs/review.md',
               'id_pattern': r'TC-\d+\.\d+', 'type': 'TST', 'status': 'unknown', 'status_column': 'Résultat',
               'approval_status': 'not-stated-in-source', 'expected_ids': ['TC-1.1', 'TC-1.2', 'TC-2.1']}
        records = {r['id']: r for r in kb.extract(self.root, cfg)}
        self.assertEqual({k: r['status'] for k, r in records.items()},
                         {'TC-1.1': 'pass', 'TC-1.2': 'unknown', 'TC-2.1': 'not-tested'})
        self.assertTrue(records['TC-2.1']['section'].startswith('## 3. TC-2'))

    def test_empty_test_log_store_and_test_add(self):
        kb.add_group(self.root, entry(REQ), 'fixture add')
        self.store_group(entry('tracker-tests'))
        self.assertEqual(kb.lint(self.root)['records'], 11 + 3)

        def add(**kw):
            args = dict(req='REQ-SCAN-001', level='L0', cmd='make | tee build.log', output='flash 97.9%\nram ok',
                        result='pass', build='base', reason='fixture', actor='ai', group='tracker-tests')
            args.update(kw)
            return kb.test_add(self.root, **args)
        first = add()
        self.assertEqual(first['id'], 'TST-001')
        second = add(result='fail')
        self.assertEqual(second['id'], 'TST-002')  # The pending first proposal already holds TST-001.
        for p in (first, second):
            store.review(kb, self.root, p['proposal'], 'approved', 'human', 'ok', group='tracker-tests')
            store.apply(kb, self.root, p['proposal'], 'ai', group='tracker-tests')
        r = kb.get(self.root, 'TST-001')
        self.assertEqual((r['type'], r['status']), ('TST', 'pass'))
        self.assertIn('make \\| tee build.log', r['text'])
        self.assertIn('flash 97.9% ram ok', r['text'])
        self.assertEqual(kb.get(self.root, 'TST-002')['status'], 'fail')
        for bad, message in [({'level': 'L4'}, 'Level must be one of'), ({'req': 'REQ-SCAN-999'}, 'not found'),
                             ({'req': 'D1'}, 'REQ'), ({'result': 'ok'}, 'result'), ({'cmd': ' '}, 'Command')]:
            with self.subTest(message=message), self.assertRaisesRegex((kb.KBError, store.StoreError), message):
                add(**bad)
        self.port_intact()

    def test_two_store_groups_need_group(self):
        self.store_group(entry(REQ))
        code, result = self.cli('store', 'status')
        self.assertEqual(code, 2)
        self.assertIn('--group', result['error'])


if __name__ == '__main__':
    unittest.main()
