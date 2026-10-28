"""Transfer, review gates, export drift and rollback of the KB store, on a temp project."""

import json
import unittest
from unittest.mock import patch

from . import project
from .project import ProjectCase, kb, store

D5_DECIDED = '| D5 | Courier integration | Adapter per courier | Fixture: chosen to try |'


class StoreTests(ProjectCase):
    GROUPS = ('tracker-decisions',)
    STORES = ('tracker-decisions',)

    def setUp(self):
        super().setUp()
        self.source = self.p.path('docs/decisions.md')
        self.fixture_bytes = project.DECISIONS_MD.encode('utf-8')

    def changed(self, rid, suffix=' Fixture change.'):
        return self.p.changed(rid, suffix)

    def propose(self, op='edit', rid='D4', section=None, text=None):
        return self.p.propose(op, rid, section, text)

    def approve_apply(self, number):
        return self.p.approve_apply(number)

    def journal(self):
        return self.p.journal()

    # ------------------------------------------------------------ transfer

    def test_transfer_is_lossless_and_switches_authority(self):
        self.assertEqual(self.source.read_bytes(), self.fixture_bytes)
        cfg = kb.load_config(self.root)
        self.assertEqual((cfg['mode'], cfg['authority']), ('store', 'kb-store'))
        record = kb.get(self.root, 'D5')
        self.assertEqual((record['authority'], record['status']), ('kb-store', 'open'))
        self.assertEqual(kb.lint(self.root)['records'], 11)
        snapshot = self.root / store.read_events(self.journal())[0]['snapshot']
        self.assertEqual((snapshot / 'decisions.md').read_bytes(), self.fixture_bytes)

    def test_second_transfer_and_import_are_refused(self):
        with self.assertRaisesRegex(store.StoreError, 'already authoritative'):
            store.transfer(kb, self.root, 'test-approver', 'again')
        with self.assertRaisesRegex(kb.KBError, 'authoritative'):
            kb.import_source(self.root)

    # ------------------------------------------------------------ review gate

    def test_edit_needs_review_then_updates_store_export_and_index(self):
        number = self.propose()
        before = self.source.read_bytes()
        with self.assertRaisesRegex(store.StoreError, 'approved'):
            store.apply(kb, self.root, number, 'ai')
        self.assertEqual(self.source.read_bytes(), before)
        self.approve_apply(number)
        record = kb.get(self.root, 'D4')
        self.assertTrue(record['text'].rstrip().endswith('Fixture change.|'))
        self.assertEqual((record['approval_status'], record['approved_by']), ('approved-in-kb', 'alex'))
        self.assertIn(b'Fixture change.', self.source.read_bytes())
        self.assertIn('D4', [r['id'] for r in kb.search(self.root, 'Fixture')['results']])
        apply_event = store.read_events(self.journal())[-1]
        self.assertEqual(apply_event['kind'], 'apply')
        self.assertNotEqual(apply_event['before_sha256'], apply_event['after_sha256'])

    def test_rejected_and_self_reviewed_proposals_cannot_apply(self):
        number = self.propose()
        with self.assertRaisesRegex(store.StoreError, 'author'):
            store.review(kb, self.root, number, 'approved', 'ai', 'self review')
        store.review(kb, self.root, number, 'rejected', 'alex', 'No')
        with self.assertRaisesRegex(store.StoreError, 'approved'):
            store.apply(kb, self.root, number, 'ai')

    def test_add_new_decision_into_section(self):
        self.approve_apply(self.propose('add', 'D6', 'decided', '| D6 | Fixture | New decision | Reason |'))
        record = kb.get(self.root, 'D6')
        self.assertEqual(record['status'], 'decided')
        lines = self.source.read_text(encoding='utf-8').splitlines()
        self.assertEqual(lines.index(record['text'].rstrip('\n')), lines.index(self.row('D4').rstrip('\n')) + 1)

    def test_move_open_decision_to_decided(self):
        self.approve_apply(self.propose('move', 'D5', 'decided', D5_DECIDED))
        record = kb.get(self.root, 'D5')
        self.assertEqual((record['status'], record['approval_status']), ('decided', 'approved-in-kb'))
        self.assertEqual(kb.search(self.root, 'courier', status='open')['results'], [])
        self.assertEqual(kb.lint(self.root)['records'], 11)

    def test_intro_edit_adds_a_banner_and_keeps_records(self):
        before = store.current_text(kb, self.source.read_text(encoding='utf-8'), 'INTRO')
        text = '\n> Fixture banner.\n' + before.rstrip('\n')
        self.approve_apply(self.propose('intro', 'INTRO', text=text))
        data = self.source.read_text(encoding='utf-8')
        self.assertIn('\n\n> Fixture banner.\n', data)
        self.assertEqual(data.count('## '), self.fixture_bytes.decode('utf-8').count('## '))
        self.assertEqual(kb.lint(self.root)['records'], 11)
        for bad in ('## Injected heading', '| D9 | x | y | z |'):
            with self.assertRaises(store.StoreError):
                self.propose('intro', 'INTRO', text=text + '\n' + bad)
        with self.assertRaises(store.StoreError):
            self.propose('intro', 'D1', text=text)

    def test_bad_rows_are_rejected_before_the_journal(self):
        before = self.journal().read_bytes()
        cases = [('edit', 'D4', None, self.changed('D4').replace('D4', 'D9')),
                 ('edit', 'D4', None, self.changed('D4') + '\n## Injected'),
                 ('edit', 'D4', None, self.changed('D4').replace('|', '', 2)),
                 ('add', 'D1', 'decided', '| D1 | x | y | z |'),
                 ('add', 'D6', 'open', '| D6 | four | columns | wrong | here |'),
                 ('move', 'D5', 'decided', '| D5 | three | columns |'),
                 ('move', 'D1', 'decided', '| D1 | x | y | z |'),
                 ('edit', 'D99', None, '| D99 | x | y | z |')]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(store.StoreError):
                self.propose(*case)
        with self.assertRaises(store.StoreError):
            store.propose(kb, self.root, 'edit', 'D4', None, self.changed('D4'), ' ', 'ai')
        self.assertEqual(self.journal().read_bytes(), before)

    def test_stale_proposal_is_refused_and_can_be_rejected(self):
        a = self.propose()
        b = self.propose(text=self.changed('D4', ' Other change.'))
        store.review(kb, self.root, b, 'approved', 'alex', 'B ok')
        self.approve_apply(a)
        with self.assertRaisesRegex(store.StoreError, 'STALE'):
            store.apply(kb, self.root, b, 'ai')
        store.review(kb, self.root, b, 'rejected', 'alex', 'Superseded by A')
        self.assertEqual(store.status(kb, self.root)['unresolved'], [])

    # ------------------------------------------------------------ drift and recovery

    def test_hand_edit_is_drift_reads_warn_writes_block_restore_keeps_text(self):
        self.source.write_bytes(self.fixture_bytes + 'Hand note.\n'.encode('utf-8'))
        self.assertIn('EXPORT DRIFT', kb.get(self.root, 'D1')['warning'])
        with self.assertRaisesRegex(kb.KBError, 'EXPORT DRIFT'):
            kb.lint(self.root)
        with self.assertRaisesRegex(store.StoreError, 'EXPORT DRIFT'):
            self.propose()
        self.assertIn('+Hand note.', store.diff(kb, self.root)['diff'])
        self.assertTrue(store.restore(kb, self.root, 'ai', 'Revert hand edit')['restored'])
        self.assertEqual(self.source.read_bytes(), self.fixture_bytes)
        self.assertIn('Hand note.', store.read_events(self.journal())[-1]['overwritten'])

    def test_git_crlf_checkout_is_not_drift(self):
        self.source.write_bytes(self.fixture_bytes.replace(b'\n', b'\r\n'))
        self.assertNotIn('warning', kb.get(self.root, 'D1'))
        self.assertTrue(kb.lint(self.root)['ok'])
        self.approve_apply(self.propose())
        self.assertIn(b'Fixture change.', self.source.read_bytes())
        crlf = self.source.read_bytes().replace(b'\n', b'\r\n')
        self.source.write_bytes(crlf.replace(b'Fixture change.', b'Hand change.'))
        with self.assertRaisesRegex(kb.KBError, 'EXPORT DRIFT'):
            kb.lint(self.root)

    def test_failed_export_after_apply_is_repaired_by_restore(self):
        number = self.propose()
        store.review(kb, self.root, number, 'approved', 'alex', 'OK')
        with patch.object(store, 'export', side_effect=OSError('Simulated failure')):
            with self.assertRaises(OSError):
                store.apply(kb, self.root, number, 'ai')
        self.assertFalse(store.status(kb, self.root)['export_in_sync'])
        self.assertTrue(kb.get(self.root, 'D4')['text'].rstrip().endswith('Fixture change.|'))
        store.restore(kb, self.root, 'ai', 'Finish interrupted export')
        self.assertIn(b'Fixture change.', self.source.read_bytes())
        self.assertFalse((store.home(self.root) / '.write.lock').exists())

    def test_tampered_or_truncated_journal_fails_closed(self):
        path = self.journal()
        raw = path.read_bytes()
        event = json.loads(raw.splitlines()[0])
        event['document'] += 'Altered'
        path.write_bytes(store.packed(event) + b'\n')
        with self.assertRaisesRegex(store.StoreError, 'hash chain'):
            kb.get(self.root, 'D1')
        path.write_bytes(raw[:-10])
        with self.assertRaises(store.StoreError):
            kb.get(self.root, 'D1')

    def test_failed_journal_write_and_lock_keep_state(self):
        before = self.journal().read_bytes()
        with patch.object(store.os, 'replace', side_effect=OSError('Simulated failed publish')):
            with self.assertRaises(OSError):
                self.propose()
        self.assertEqual(self.journal().read_bytes(), before)
        with store.locked(self.root):
            with self.assertRaisesRegex(store.StoreError, 'locked'):
                self.propose()
        self.assertEqual(self.journal().read_bytes(), before)

    def test_bom_and_crlf_survive_transfer_and_edit(self):
        other = project.Project(('tracker-decisions',), setup=False)
        self.addCleanup(other.close)
        raw = b'\xef\xbb\xbf' + self.fixture_bytes.decode('utf-8').replace('\n', '\r\n').encode('utf-8')
        other.write('docs/decisions.md', raw)
        other.setup(('tracker-decisions',))
        self.assertEqual(other.path('docs/decisions.md').read_bytes(), raw)
        row = kb.get(other.root, 'D4')['text']
        number = store.propose(kb, other.root, 'edit', 'D4', None, row.rstrip('\r\n')[:-1] + ' X.|', 'r',
                               'ai')['proposal']
        store.review(kb, other.root, number, 'approved', 'alex', 'ok')
        store.apply(kb, other.root, number, 'ai')
        data = other.path('docs/decisions.md').read_bytes()
        self.assertTrue(data.startswith(b'\xef\xbb\xbf'))
        self.assertNotIn(b'\n', data.replace(b'\r\n', b''))
        self.assertIn(b' X.|\r\n', data)

    # ------------------------------------------------------------ rollback

    def test_rollback_keeps_applied_changes_and_allows_new_transfer(self):
        self.approve_apply(self.propose('add', 'D6', 'decided', '| D6 | Fixture | New | Reason |'))
        pending = self.propose()
        with self.assertRaisesRegex(store.StoreError, 'Resolve proposals'):
            store.rollback(kb, self.root, 'alex', 'try')
        store.review(kb, self.root, pending, 'rejected', 'alex', 'drop')
        result = store.rollback(kb, self.root, 'alex', 'Fixture rollback')
        self.assertTrue((self.root / result['archived_journal']).exists())
        cfg = kb.load_config(self.root)
        self.assertEqual((cfg['mode'], cfg['authority']), ('read-only', 'original-source'))
        record = kb.get(self.root, 'D6')
        self.assertEqual((record['authority'], record['status']), ('original-source', 'decided'))
        store.transfer(kb, self.root, 'test-approver', 'Second transfer')
        self.assertEqual(kb.lint(self.root)['records'], 12)

    def test_deleted_index_rebuilds_from_store(self):
        self.approve_apply(self.propose())
        expected = kb.get(self.root, 'D4')
        kb.db_path(self.root).unlink()
        self.assertEqual(kb.get(self.root, 'D4'), expected)

    def test_cli_round_trip(self):
        text = self.write('row.txt', self.changed('D4'))
        code, result = self.cli('store', 'propose', 'edit', 'D4', '--text-file', text,
                                '--reason', 'cli', '--actor', 'ai')
        self.assertEqual(code, 0, result)
        number = str(result['proposal'])
        self.assertEqual(self.cli('store', 'review', number, '--decision', 'approved',
                                  '--reviewed-by', 'alex', '--reason', 'ok')[0], 0)
        code, result = self.cli('store', 'apply', number, '--actor', 'ai')
        self.assertEqual(code, 0, result)
        code, result = self.cli('get', 'D4')
        self.assertEqual(result['approval_status'], 'approved-in-kb')
        code, result = self.cli('store', 'propose', 'add', 'D7', '--text-file', text,
                                '--reason', 'x', '--actor', 'ai')
        self.assertEqual(code, 2)
        self.assertIn('--section', result['error'])


if __name__ == '__main__':
    unittest.main()
