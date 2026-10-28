"""Recovery and provenance of a read-only group: verified copy, STALE source, damaged index."""

import json
import sqlite3
import unittest
from contextlib import closing

from .project import ProjectCase, kb


class ReadOnlyGroupTests(ProjectCase):
    GROUPS = ('tracker-decisions',)

    def setUp(self):
        super().setUp()
        self.cfg = self.p.cfg('tracker-decisions')
        self.source = self.p.path('docs/decisions.md')
        self.original = self.source.read_bytes()

    def import_source(self):
        kb.import_source(self.root, 'tracker-decisions')

    def test_verbatim_decisions_and_open_status(self):
        result = kb.lint(self.root)
        self.assertEqual(result['records'], 11)
        self.assertEqual(result['external_links_not_in_pilot'], ['B1'])
        lines = self.original.decode('utf-8-sig').splitlines(keepends=True)
        for rid in self.cfg['expected_ids']:
            r = kb.get(self.root, rid)
            self.assertEqual(r['text'], lines[r['source_line'] - 1])
            self.assertEqual(r['source_sha256'], kb.sha(self.original))
            self.assertIn(':', r['citation'])
        self.assertEqual(kb.get(self.root, 'D1')['status'], 'decided')
        self.assertEqual(kb.get(self.root, 'D5')['approval_status'], 'not-approved')
        self.assertEqual(kb.get(self.root, 'F1')['approval_status'], 'not-stated-in-source')

    def test_search_and_filters(self):
        results = kb.search(self.root, 'log', kind='DEC', status='decided')['results']
        self.assertIn('D4', [r['id'] for r in results])
        self.assertTrue(all(r['status'] == 'decided' for r in results))
        results = kb.search(self.root, 'courier', status='open')['results']
        self.assertEqual([r['id'] for r in results], ['D5'])

    def test_unknown_id_and_empty_search(self):
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'D999')
        empty = kb.search(self.root, 'zzzzmissingzzzz')
        self.assertEqual(empty['results'], [])
        self.assertIn('not proof of absence', empty['empty_result_note'])

    def test_changed_source_blocks_get_search_and_rebuild_until_reimport(self):
        self.source.write_bytes(self.original + b'\nChanged source note.\n')
        for call in [lambda: kb.get(self.root, 'D1'),
                     lambda: kb.search(self.root, 'log'),
                     lambda: kb.rebuild(self.root)]:
            with self.assertRaisesRegex(kb.KBError, 'STALE'):
                call()
        self.import_source()
        self.assertEqual(kb.get(self.root, 'D1')['source_sha256'], kb.sha(self.source.read_bytes()))

    def test_missing_source_is_explicit(self):
        self.source.unlink()
        with self.assertRaisesRegex(kb.KBError, 'Source unavailable'):
            kb.get(self.root, 'D1')

    def test_missing_or_duplicate_source_id_requires_scope_review(self):
        lines = self.original.decode('utf-8-sig').splitlines(keepends=True)
        d1 = next(line for line in lines if line.startswith('| D1 |'))
        self.source.write_text(''.join(line for line in lines if line != d1), encoding='utf-8')
        with self.assertRaisesRegex(kb.KBError, 'missing=.*D1'):
            kb.extract(self.root, self.cfg)
        self.source.write_bytes(self.original + d1.encode('utf-8'))
        with self.assertRaisesRegex(kb.KBError, 'Duplicate source ID: D1'):
            kb.extract(self.root, self.cfg)

    def test_lost_or_hand_edited_record_rejected(self):
        path = kb.store_path(self.root)
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
        kb.atomic_bytes(path, kb.encode_records(rows[1:]))
        with self.assertRaisesRegex(kb.KBError, 'differ from the original source'):
            kb.lint(self.root)
        rows[0]['text'] = 'Altered claim'
        kb.atomic_bytes(path, kb.encode_records(rows))
        with self.assertRaisesRegex(kb.KBError, 'differ from the original source'):
            kb.get(self.root, 'D1')

    def test_deleted_index_rebuilds_without_changing_source_or_copy(self):
        before = kb.store_path(self.root).read_bytes()
        expected = kb.get(self.root, 'D4')
        kb.db_path(self.root).unlink()
        self.assertEqual(kb.get(self.root, 'D4'), expected)
        self.assertEqual(kb.store_path(self.root).read_bytes(), before)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_corrupt_or_tampered_index_is_rebuilt(self):
        target = kb.db_path(self.root)
        target.write_bytes(b'not sqlite')
        self.assertEqual(kb.get(self.root, 'D1')['status'], 'decided')
        with closing(sqlite3.connect(target)) as conn:
            conn.execute("UPDATE records SET payload='{}' WHERE id='D1'")
            conn.execute("UPDATE fts SET text='wrong' WHERE id='D4'")
            conn.commit()
        self.assertEqual(kb.get(self.root, 'D1')['status'], 'decided')
        self.assertIn('D4', [r['id'] for r in kb.search(self.root, 'log')['results']])


if __name__ == '__main__':
    unittest.main()
