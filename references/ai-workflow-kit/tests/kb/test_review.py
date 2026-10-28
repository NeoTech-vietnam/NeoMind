"""Store row removal and the review sheet (export, the reviewer marks Keep/Remove/Change, import)."""

import unittest

from .project import ProjectCase, kb, store

try:
    import openpyxl
except ImportError:  # pragma: no cover
    openpyxl = None

DEC, REQ = 'tracker-decisions', 'tracker-requirements'


class ReviewTests(ProjectCase):
    GROUPS = (DEC, REQ)
    STORES = (DEC, REQ)

    def setUp(self):
        super().setUp()
        port = kb.load_config(self.root, DEC)
        self.port = {self.root / port[k]: (self.root / port[k]).read_bytes() for k in ('source', 'store')}

    def port_intact(self):
        self.assert_unchanged(self.port)

    def req_journal(self):
        return store.journal(kb, self.root, kb.load_config(self.root, REQ))

    # ------------------------------------------------------------ remove

    def test_remove_needs_review_then_deletes_the_row(self):
        number = store.propose(kb, self.root, 'remove', 'REQ-SCAN-002', None, '', 'not needed', 'ai',
                               group=REQ)['proposal']
        self.assertIn('REQ-SCAN-002', self.p.read('docs/requirements.md'))
        store.review(kb, self.root, number, 'approved', 'human', 'ok', group=REQ)
        store.apply(kb, self.root, number, 'ai', group=REQ)
        text = self.p.read('docs/requirements.md')
        self.assertNotIn('REQ-SCAN-002', text)
        self.assertIn('REQ-SCAN-001', text)
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'REQ-SCAN-002')
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertEqual(store.read_events(self.req_journal())[-1]['kind'], 'apply')
        with self.assertRaisesRegex(store.StoreError, 'STALE'):
            store.propose(kb, self.root, 'remove', 'REQ-SCAN-002', None, '', 'again', 'ai', group=REQ)
        self.port_intact()

    def test_remove_proposal_goes_stale_when_the_row_changes(self):
        a = store.propose(kb, self.root, 'remove', 'REQ-SCAN-001', None, '', 'drop', 'ai', group=REQ)
        row = kb.get(self.root, 'REQ-SCAN-001')['text'].rstrip('\n').replace('| Draft |', '| Approved |')
        b = store.propose(kb, self.root, 'edit', 'REQ-SCAN-001', None, row, 'edit', 'ai', group=REQ)
        for p in (a, b):
            store.review(kb, self.root, p['proposal'], 'approved', 'human', 'ok', group=REQ)
        store.apply(kb, self.root, b['proposal'], 'ai', group=REQ)
        with self.assertRaisesRegex(store.StoreError, 'STALE'):
            store.apply(kb, self.root, a['proposal'], 'ai', group=REQ)

    # ------------------------------------------------------------ review sheet

    @unittest.skipUnless(openpyxl, 'openpyxl not installed')
    def test_export_lists_every_store_record_with_keep_default(self):
        out = self.p.path('review.xlsx')
        result = kb.review_export(self.root, out)
        self.assertEqual(result['records'], 11 + 3)
        book = openpyxl.load_workbook(out)
        sheet = book['Records']
        header = [c.value for c in sheet[1]]
        self.assertEqual(header[:4], ['Group', 'Scope', 'ID', 'Type'])
        rows = list(sheet.iter_rows(min_row=2, values_only=True))
        self.assertEqual({r[2] for r in rows},
                         set(kb.load_config(self.root, DEC)['expected_ids']) | set(kb.load_config(self.root, REQ)['expected_ids']))
        self.assertEqual({r[header.index('Decision')] for r in rows}, {'Keep'})
        self.assertTrue(sheet.data_validations.dataValidation)
        self.assertIn(REQ, [c.value for c in book['Meta']['A']])

    @unittest.skipUnless(openpyxl, 'openpyxl not installed')
    def test_import_proposes_removals_lists_changes_and_applies_on_ok(self):
        out = self.p.path('review.xlsx')
        kb.review_export(self.root, out)
        self.mark(out, {'REQ-SCAN-002': ('Remove', 'duplicate'), 'REQ-ROUTE-001': ('Change', 'reword'),
                        'D3': ('Remove', 'fixture')})
        result = kb.review_import(self.root, out)
        self.assertEqual(sorted(p['id'] for p in result['proposed']), ['D3', 'REQ-SCAN-002'])
        self.assertEqual([c['id'] for c in result['change_requests']], ['REQ-ROUTE-001'])
        self.assertIn('REQ-SCAN-002', self.p.read('docs/requirements.md'))
        result = kb.review_import(self.root, out, approve_as='human', reason='Chat OK fixture')
        self.assertEqual(sorted(a['id'] for a in result['applied']), ['D3', 'REQ-SCAN-002'])
        self.assertNotIn('| REQ-SCAN-002 |', self.p.read('docs/requirements.md'))
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'D3')
        self.assertEqual(store.status(kb, self.root, REQ)['unresolved'], [])

    @unittest.skipUnless(openpyxl, 'openpyxl not installed')
    def test_import_refuses_a_sheet_older_than_the_store_or_bad_values(self):
        out = self.p.path('review.xlsx')
        kb.review_export(self.root, out)
        self.mark(out, {'REQ-SCAN-002': ('Delete', '')})
        with self.assertRaisesRegex(kb.KBError, 'Decision'):
            kb.review_import(self.root, out)
        self.mark(out, {'REQ-SCAN-002': ('Remove', '')})
        row = kb.get(self.root, 'REQ-SCAN-001')['text'].rstrip('\n').replace('| Draft |', '| Approved |')
        p = store.propose(kb, self.root, 'edit', 'REQ-SCAN-001', None, row, 'edit', 'ai', group=REQ)
        store.review(kb, self.root, p['proposal'], 'approved', 'human', 'ok', group=REQ)
        store.apply(kb, self.root, p['proposal'], 'ai', group=REQ)
        before = self.req_journal().read_bytes()
        with self.assertRaisesRegex(kb.KBError, 'changed since the export'):
            kb.review_import(self.root, out)
        self.assertEqual(self.req_journal().read_bytes(), before)

    @unittest.skipUnless(openpyxl, 'openpyxl not installed')
    def test_cli_round_trip(self):
        out = self.p.path('review.xlsx')
        code, result = self.cli('review', 'export', '--out', out, '--group', REQ)
        self.assertEqual((code, result['records']), (0, 3), result)
        self.mark(out, {'REQ-SCAN-001': ('Remove', 'x')})
        code, result = self.cli('review', 'import', '--file', out)
        self.assertEqual((code, [p['id'] for p in result['proposed']]), (0, ['REQ-SCAN-001']), result)
        self.port_intact()

    def test_export_needs_a_store_group_and_a_known_name(self):
        # The sheet is for store groups; these refusals do not need openpyxl to be installed first.
        code, result = self.cli('review', 'export')
        self.assertEqual(code, 2)
        self.assertIn('--out', result['error'])
        if openpyxl is None:
            self.skipTest('openpyxl not installed')
        out = self.p.path('review.xlsx')
        code, result = self.cli('review', 'export', '--out', out, '--group', 'nope')
        self.assertEqual(code, 2)
        self.assertIn('Unknown group', result['error'])

    def mark(self, path, decisions):
        book = openpyxl.load_workbook(path)
        sheet = book['Records']
        header = [c.value for c in sheet[1]]
        for row in sheet.iter_rows(min_row=2):
            rid = row[header.index('ID')].value
            if rid in decisions:
                row[header.index('Decision')].value, row[header.index('Note')].value = decisions[rid]
        book.save(path)


if __name__ == '__main__':
    unittest.main()
