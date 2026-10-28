"""Controls: each guard the KB relies on, shown to catch the damage it exists for.

Every control has three parts. The clean state passes (so the check is not failing for other reasons). Each
kind of damage is reported, in the library and on the command line. And where the guard can be switched off
cleanly, a run with the guard off lets the same damage through, which shows the test depends on that guard.
The damaged input is always put back and the clean state passes again.

    hash chain      a hand edit of a store journal line
    export drift    a hand edit of a store's exported document
    STALE           a changed read-only source
    ID set          a group whose source IDs differ from the reviewed `expected_ids`
"""

import json
import unittest
from unittest.mock import patch

from . import project
from .project import ProjectCase, kb, store

DEC = 'tracker-decisions'


def lenient_read_events(path):
    """store.read_events without the sequence and hash-chain check (the guard switched off)."""
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]


class HashChainControl(ProjectCase):
    GROUPS = (DEC,)
    STORES = (DEC,)

    def setUp(self):
        super().setUp()
        # transfer, propose, review, apply, propose: five events, the last one still pending.
        self.p.apply_change('edit', 'D4', None, self.p.changed('D4'), group=DEC)
        self.p.propose('edit', 'D2', None, self.p.changed('D2', ' Second change.'), group=DEC)
        self.journal = self.p.journal(DEC)
        self.clean = self.journal.read_bytes()
        self.lines = self.clean.splitlines()

    def damage(self, data):
        self.journal.write_bytes(data)
        self.addCleanup(self.journal.write_bytes, self.clean)

    def edited(self, n, **fields):
        """The journal with line n changed (still valid JSON, hash not recomputed)."""
        event = {**json.loads(self.lines[n]), **fields}
        lines = list(self.lines)
        lines[n] = store.packed(event)
        return b'\n'.join(lines) + b'\n'

    def damages(self):
        event = json.loads(self.lines[1])
        rehashed = {**event, 'reason': 'rewritten'}
        rehashed['hash'] = store.digest(store.packed({k: v for k, v in rehashed.items() if k != 'hash'}))
        forged = {**json.loads(self.lines[-1]), 'seq': 6, 'reason': 'forged'}
        return {
            'a reason edited in the middle': self.edited(1, reason='rewritten'),
            'the transferred document edited': self.edited(0, document='Altered'),
            'the last line edited': self.edited(4, reason='rewritten'),
            'an actor edited': self.edited(3, actor='someone-else'),
            'two lines swapped': b'\n'.join([self.lines[0], self.lines[2], self.lines[1], *self.lines[3:]]) + b'\n',
            'a middle line deleted': b'\n'.join(self.lines[:2] + self.lines[3:]) + b'\n',
            'a line added without a valid hash': self.clean + store.packed(forged) + b'\n',
            'a line re-hashed alone': b'\n'.join([self.lines[0], store.packed(rehashed), *self.lines[2:]]) + b'\n',
            'the last line cut short': self.clean[:-25],
        }

    def test_the_clean_journal_is_accepted(self):
        self.assertEqual(len(store.read_events(self.journal)), 5)
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertEqual(self.cli('lint')[0], 0)
        self.assertEqual(store.status(kb, self.root, DEC)['events'], 5)

    def test_every_kind_of_hand_edit_breaks_the_chain(self):
        for name, data in self.damages().items():
            with self.subTest(damage=name):
                self.damage(data)
                with self.assertRaises(store.StoreError):
                    store.read_events(self.journal)
                for call in (lambda: kb.get(self.root, 'D1'), lambda: kb.lint(self.root),
                             lambda: kb.search(self.root, 'fixture'), lambda: store.status(kb, self.root, DEC)):
                    with self.assertRaises(store.StoreError):
                        call()
                self.journal.write_bytes(self.clean)
                self.assertTrue(kb.lint(self.root)['ok'], f'clean again after: {name}')

    def test_the_message_names_the_chain_and_the_group(self):
        self.damage(self.edited(1, reason='rewritten'))
        with self.assertRaisesRegex(store.StoreError, 'Journal sequence or hash chain is invalid'):
            store.read_events(self.journal)
        with self.assertRaisesRegex(store.StoreError, f'{DEC}: Journal sequence or hash chain is invalid'):
            kb.lint(self.root)

    def test_the_command_line_refuses_a_hand_edited_journal(self):
        self.damage(self.edited(1, reason='rewritten'))
        code, result = self.cli('lint')
        self.assertEqual(code, 2)
        self.assertIn('hash chain', result['error'])
        code, result = self.cli('get', 'D1')
        self.assertEqual(code, 2)
        self.assertIn('hash chain', result['error'])
        code, result = self.cli('status')  # status reports the group as unavailable instead of stopping
        self.assertEqual((code, result['ok']), (0, False))
        self.assertIn('hash chain', result['unavailable_groups'][0]['error'])

    def test_writes_stop_on_a_broken_chain_and_leave_the_journal_alone(self):
        self.damage(self.edited(1, reason='rewritten'))
        broken = self.journal.read_bytes()
        row = '| D1 | Scanner | Fixture decision one, changed | Fixture rationale |'
        for call in (lambda: self.p.propose('edit', 'D1', None, row, group=DEC),
                     lambda: store.review(kb, self.root, 5, 'approved', 'alex', 'ok', group=DEC),
                     lambda: store.apply(kb, self.root, 5, 'ai', group=DEC),
                     lambda: store.restore(kb, self.root, 'ai', 'try', group=DEC),
                     lambda: store.rollback(kb, self.root, 'alex', 'try', group=DEC)):
            with self.assertRaises(store.StoreError):
                call()
        self.assertEqual(self.journal.read_bytes(), broken)

    def test_control_with_the_chain_check_off_the_same_edit_goes_unnoticed(self):
        self.damage(self.edited(1, reason='rewritten'))
        with self.assertRaises(store.StoreError):
            kb.get(self.root, 'D1')
        with patch.object(store, 'read_events', lenient_read_events):
            self.assertEqual(kb.get(self.root, 'D1')['id'], 'D1')
            self.assertTrue(kb.lint(self.root)['ok'])
            self.assertEqual(store.ledger(kb, self.root, DEC)['events'][1]['reason'], 'rewritten')

    def test_the_restored_journal_is_accepted_again_without_any_repair(self):
        self.damage(self.edited(1, reason='rewritten'))
        with self.assertRaises(store.StoreError):
            kb.lint(self.root)
        self.journal.write_bytes(self.clean)
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertEqual(store.ledger(kb, self.root, DEC)['events'][1]['reason'], 'Fixture reason')


class ExportDriftControl(ProjectCase):
    GROUPS = (DEC,)
    STORES = (DEC,)

    def setUp(self):
        super().setUp()
        self.number = self.p.propose('edit', 'D4', None, self.p.changed('D4'), group=DEC)
        self.p.approve(self.number, DEC)  # Approved, not applied: apply must be refused while drifting.
        self.doc = self.p.path('docs/decisions.md')
        self.clean = self.doc.read_bytes()
        self.text = self.clean.decode('utf-8')

    def damage(self, text):
        self.doc.write_bytes(text.encode('utf-8'))
        self.addCleanup(self.doc.write_bytes, self.clean)

    def damages(self):
        return {
            'a line appended': self.text + 'Hand note.\n',
            'a row edited': self.text.replace('Fixture decision two', 'Fixture decision 2'),
            'a row deleted': self.text.replace('| D3 | Depots | Fixture decision three | Fixture rationale |\n', ''),
            'a trailing space added': self.text.replace('Minimal log fixture |', 'Minimal log fixture  |'),
            'the title changed': self.text.replace('# Tracker decisions', '# Tracker choices'),
            'the file emptied': '',
        }

    def test_the_clean_export_is_in_sync(self):
        self.assertNotIn('warning', kb.get(self.root, 'D1'))
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertTrue(store.status(kb, self.root, DEC)['export_in_sync'])
        self.assertEqual(store.diff(kb, self.root, DEC)['diff'], '')
        self.assertNotIn('warning', kb.search(self.root, 'fixture'))

    def test_every_kind_of_hand_edit_is_reported_as_drift(self):
        for name, text in self.damages().items():
            with self.subTest(damage=name):
                self.damage(text)
                self.assertIn('EXPORT DRIFT', kb.get(self.root, 'D1')['warning'])
                with self.assertRaisesRegex(kb.KBError, 'EXPORT DRIFT'):
                    kb.lint(self.root)
                self.assertFalse(store.status(kb, self.root, DEC)['export_in_sync'])
                self.assertTrue(store.diff(kb, self.root, DEC)['diff'])
                self.assertIn('EXPORT DRIFT', kb.search(self.root, 'fixture')['warning'])
                self.doc.write_bytes(self.clean)
                self.assertTrue(kb.lint(self.root)['ok'], f'clean again after: {name}')
                self.assertNotIn('warning', kb.get(self.root, 'D1'))

    def test_the_answer_still_comes_from_the_store_not_from_the_edited_document(self):
        self.damage(self.text.replace('Fixture decision two', 'Hand wrote this'))
        answer = kb.get(self.root, 'D2')
        self.assertIn('Fixture decision two', answer['text'])
        self.assertNotIn('Hand wrote this', answer['text'])
        self.assertIn('EXPORT DRIFT', answer['warning'])

    def test_writes_are_refused_while_the_document_drifts(self):
        self.damage(self.text + 'Hand note.\n')
        before = self.p.journal(DEC).read_bytes()
        for call in (lambda: self.p.propose('edit', 'D2', None, self.p.changed('D2', ' More.'), group=DEC),
                     lambda: store.apply(kb, self.root, self.number, 'ai', group=DEC),
                     lambda: store.rollback(kb, self.root, 'alex', 'try', group=DEC)):
            with self.assertRaisesRegex(store.StoreError, 'EXPORT DRIFT'):
                call()
        self.assertEqual(self.p.journal(DEC).read_bytes(), before)
        self.assertEqual(self.doc.read_bytes(), (self.text + 'Hand note.\n').encode('utf-8'))

    def test_the_command_line_reports_drift(self):
        self.damage(self.text + 'Hand note.\n')
        code, result = self.cli('lint')
        self.assertEqual(code, 2)
        self.assertIn('EXPORT DRIFT', result['error'])
        code, result = self.cli('status')
        self.assertEqual((code, result['ok']), (0, False))
        code, result = self.cli('get', 'D1')
        self.assertEqual(code, 0)
        self.assertIn('EXPORT DRIFT', result['warning'])
        code, result = self.cli('store', 'diff')
        self.assertIn('+Hand note.', result['diff'])
        code, result = self.cli('store', 'apply', self.number, '--actor', 'ai')
        self.assertEqual(code, 2)
        self.assertIn('EXPORT DRIFT', result['error'])

    def test_restore_puts_the_export_back_and_keeps_the_hand_text_in_the_ledger(self):
        self.damage(self.text + 'Hand note.\n')
        self.assertTrue(store.restore(kb, self.root, 'ai', 'revert hand edit', group=DEC)['restored'])
        self.assertEqual(self.doc.read_bytes(), self.clean)
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertIn('Hand note.', store.read_events(self.p.journal(DEC))[-1]['overwritten'])
        self.assertTrue(store.apply(kb, self.root, self.number, 'ai', group=DEC)['applied'])

    def test_control_with_the_sync_check_off_the_same_edit_goes_unnoticed(self):
        self.damage(self.text + 'Hand note.\n')
        self.assertIn('EXPORT DRIFT', kb.get(self.root, 'D1')['warning'])
        real = store.load

        def blind(kb_module, root, cfg):
            path, events, state = real(kb_module, root, cfg)
            state['in_sync'] = True
            return path, events, state

        with patch.object(store, 'load', blind):
            self.assertNotIn('warning', kb.get(self.root, 'D1'))
            self.assertTrue(kb.lint(self.root)['ok'])
            later = self.p.propose('edit', 'D2', None, self.p.changed('D2', ' More.'), group=DEC)
            self.assertGreater(later, self.number)  # The write went through on a drifting export.


class StaleControl(ProjectCase):
    GROUPS = ('ops-rules', 'ops-exceptions')

    def setUp(self):
        super().setUp()
        self.rules = self.p.path('docs/rules.md')
        self.original = self.rules.read_bytes()
        self.copy = kb.store_path(self.root, self.p.cfg('ops-rules'))
        self.copy_before = self.copy.read_bytes()

    def damage(self, data):
        self.rules.write_bytes(data)
        self.addCleanup(self.rules.write_bytes, self.original)

    def damages(self):
        text = self.original.decode('utf-8')
        return {
            'a line appended': text + 'Changed source note.\n',
            'a word changed': text.replace('Address the user', 'Address the reader'),
            'one letter changed': text.replace('Clear.', 'Clean.'),
            'a space added': text.replace('Never edit', 'Never  edit'),
            'a new ID added': text + '- **R3** — Added later.\n',
            'an ID removed': text.replace('- **R1** — Address the user.\n', ''),
        }

    def test_the_clean_source_is_accepted(self):
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertEqual(self.cli('lint')[0], 0)
        self.assertEqual(kb.get(self.root, 'R1')['source_sha256'], kb.sha(self.original))

    def test_every_kind_of_change_is_stale(self):
        for name, data in self.damages().items():
            with self.subTest(damage=name):
                self.damage(data.encode('utf-8'))
                for call in (lambda: kb.get(self.root, 'R1'), lambda: kb.lint(self.root),
                             lambda: kb.get(self.root, 'R0')):
                    with self.assertRaisesRegex(kb.KBError, 'ops-rules.*STALE: original source changed'):
                        call()
                self.rules.write_bytes(self.original)
                self.assertTrue(kb.lint(self.root)['ok'], f'clean again after: {name}')

    def test_stale_comes_first_even_when_the_id_set_changed_too(self):
        self.damage((self.original.decode('utf-8') + '- **R3** — Added later.\n').encode('utf-8'))
        with self.assertRaisesRegex(kb.KBError, 'STALE'):
            kb.get(self.root, 'R1')
        with self.assertRaisesRegex(kb.KBError, r"unexpected=\['R3'\]"):
            kb.import_source(self.root, 'ops-rules')  # import is the step that reports the IDs

    def test_the_other_groups_keep_answering_and_the_stale_one_is_named(self):
        self.damage(self.original + b'Changed source note.\n')
        self.assertEqual(kb.get(self.root, 'OPS-EXC-1')['group'], 'ops-exceptions')
        result = kb.search(self.root, 'damaged')
        self.assertEqual([u['group'] for u in result['unavailable_groups']], ['ops-rules'])
        self.assertIn('ops-rules', result['warning'])
        code, status = self.cli('status')
        self.assertEqual((code, status['ok']), (0, False))
        self.assertIn('STALE', status['unavailable_groups'][0]['error'])
        code, result = self.cli('lint')
        self.assertEqual(code, 2)
        self.assertIn('STALE', result['error'])

    def test_re_import_after_review_clears_it_and_replaces_the_copy(self):
        self.damage(self.original.replace(b'Address the user', b'Address the reader'))
        with self.assertRaisesRegex(kb.KBError, 'STALE'):
            kb.lint(self.root)
        kb.import_source(self.root, 'ops-rules')
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertNotEqual(self.copy.read_bytes(), self.copy_before)
        self.assertIn('Address the reader', kb.get(self.root, 'R1')['text'])

    def test_a_refused_import_leaves_the_copy_as_it_was(self):
        self.damage((self.original.decode('utf-8') + '- **R3** — Added later.\n').encode('utf-8'))
        with self.assertRaises(kb.KBError):
            kb.import_source(self.root, 'ops-rules')
        self.assertEqual(self.copy.read_bytes(), self.copy_before)

    def test_only_line_endings_changing_is_not_a_change(self):
        # Control for the control: the check looks at content, so a CRLF checkout does not raise it.
        self.damage(self.original.replace(b'\n', b'\r\n'))
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_a_binary_source_is_hashed_as_it_is(self):
        # A DOCX is not normalised: one changed byte inside is a change.
        project_with_docx = self.p
        kb.add_group(self.root, project.entry('ops-spec'), 'fixture add')
        spec = project_with_docx.path('docs/spec.docx')
        data = spec.read_bytes()
        self.addCleanup(spec.write_bytes, data)
        self.assertTrue(kb.lint(self.root)['ok'])
        spec.write_bytes(project.docx_bytes(project.spec_body().replace('200 ms', '300 ms')))
        with self.assertRaisesRegex(kb.KBError, 'ops-spec.*STALE'):
            kb.lint(self.root)


class IdSetControl(ProjectCase):
    GROUPS = (DEC,)

    def setUp(self):
        super().setUp()
        self.doc = self.p.path('docs/decisions.md')
        self.original = self.doc.read_bytes()
        self.copy = kb.store_path(self.root, self.p.cfg(DEC))
        self.copy_before = self.copy.read_bytes()
        self.text = self.original.decode('utf-8')

    def damage(self, text):
        self.doc.write_bytes(text.encode('utf-8'))
        self.addCleanup(self.doc.write_bytes, self.original)

    def test_the_reviewed_ids_match_the_source(self):
        cfg = self.p.cfg(DEC)
        self.assertEqual([r['id'] for r in kb.extract(self.root, cfg)], cfg['expected_ids'])

    def test_missing_and_unexpected_ids_are_named(self):
        d3 = '| D3 | Depots | Fixture decision three | Fixture rationale |\n'
        new = '| D6 | Parcels | Fixture decision six | Fixture rationale |\n'
        cases = {
            'a row removed': (self.text.replace(d3, ''), "missing=['D3'], unexpected=[]"),
            'a row added': (self.text.replace(d3, d3 + new), "missing=[], unexpected=['D6']"),
            'a row renamed': (self.text.replace(d3, d3.replace('D3', 'D6')), "missing=['D3'], unexpected=['D6']"),
            'two rows removed and one added': (self.text.replace(d3, new).replace(
                '| F6 | Tracking page | Fixture response six |\n', ''), "missing=['D3', 'F6'], unexpected=['D6']"),
        }
        for name, (text, expected) in cases.items():
            with self.subTest(damage=name):
                self.damage(text)
                with self.assertRaises(kb.KBError) as caught:
                    kb.extract(self.root, self.p.cfg(DEC))
                self.assertIn('Source IDs changed; ' + expected, str(caught.exception))
                with self.assertRaisesRegex(kb.KBError, 'Source IDs changed'):
                    kb.import_source(self.root, DEC)
                code, result = self.cli('import', '--group', DEC)
                self.assertEqual(code, 2)
                self.assertIn(expected, result['error'])
                self.assertEqual(self.copy.read_bytes(), self.copy_before, 'the copy is not overwritten')
                self.doc.write_bytes(self.original)
                self.assertTrue(kb.lint(self.root)['ok'], f'clean again after: {name}')

    def test_a_group_with_changed_ids_is_refused_by_add_group_and_the_config_stays(self):
        before = self.p.registry_path.read_bytes()
        bad = project.entry('ops-rules', expected_ids=['R0', 'R11', 'R1', 'R2', 'R9'])
        with self.assertRaisesRegex(kb.KBError, r"Source IDs changed; missing=\['R9'\], unexpected=\[\]"):
            kb.add_group(self.root, bad, 'fixture add')
        self.assertEqual(self.p.registry_path.read_bytes(), before)
        self.assertFalse(kb.store_path(self.root, bad).exists())

    def test_the_fix_is_a_reviewed_expected_ids_not_a_silent_re_import(self):
        d3 = '| D3 | Depots | Fixture decision three | Fixture rationale |\n'
        self.damage(self.text.replace(d3, ''))
        with self.assertRaisesRegex(kb.KBError, 'Source IDs changed'):
            kb.import_source(self.root, DEC)
        groups = self.p.registry()['groups']
        groups[0]['expected_ids'] = [i for i in groups[0]['expected_ids'] if i != 'D3']
        self.p.write_registry(groups)
        kb.import_source(self.root, DEC)
        self.assertTrue(kb.lint(self.root)['ok'])
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'D3')

    def test_a_copy_with_a_lost_record_is_not_accepted_either(self):
        rows = [json.loads(line) for line in self.copy.read_text(encoding='utf-8').splitlines()]
        kb.atomic_bytes(self.copy, kb.encode_records(rows[:-1]))
        self.addCleanup(self.copy.write_bytes, self.copy_before)
        with self.assertRaisesRegex(kb.KBError, 'differ from the original source'):
            kb.lint(self.root)

    def test_duplicate_expected_ids_and_ids_outside_the_pattern_are_refused(self):
        cfg = self.p.cfg(DEC)
        for ids in (cfg['expected_ids'] + ['D1'], cfg['expected_ids'] + ['X7'], [], 'D1'):
            with self.subTest(ids=ids), self.assertRaisesRegex(kb.KBError, 'Invalid or duplicate expected IDs'):
                kb.checked_group(self.root, {**cfg, 'expected_ids': ids})


if __name__ == '__main__':
    unittest.main()
