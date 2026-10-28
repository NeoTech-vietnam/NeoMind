"""Two scopes, two decision groups: isolation of reads, writes, drift and rollback. Temp project only."""

import unittest
from contextlib import closing
import sqlite3

from . import project
from .project import ProjectCase, kb, store

TRACKER, OPS = 'tracker-decisions', 'ops-decisions'


class ScopeTests(ProjectCase):
    GROUPS = (TRACKER, OPS)

    def setUp(self):
        super().setUp()
        self.original = project.DECISIONS_MD.encode('utf-8')

    def both_stores(self):
        for name in (TRACKER, OPS):
            store.transfer(kb, self.root, 'fixture-human', 'Fixture transfer', group=name)

    def files(self, group):
        cfg = kb.load_config(self.root, group)
        paths = [self.root / cfg['source']]
        if cfg['mode'] == 'store':
            paths.append(store.journal(kb, self.root, cfg))
        return {p: p.read_bytes() for p in paths}

    def import_copy(self, cfg):
        kb.atomic_bytes(kb.store_path(self.root, cfg), kb.encode_records(kb.extract(self.root, cfg)))

    def test_get_and_search_scope_cli_and_totals(self):
        for rid, name, scope in [('D5', TRACKER, 'tracker'), ('D105', OPS, 'ops')]:
            r = kb.get(self.root, rid)
            self.assertEqual((r['group'], r['scope']), (name, scope))
        code, all_hits = self.cli('search', 'log', '--status', 'decided')
        self.assertEqual(code, 0, all_hits)
        self.assertEqual({r['id'] for r in all_hits['results']}, {'D4', 'D104'})
        code, filtered = self.cli('search', 'log', '--scope', 'ops', '--status', 'decided')
        self.assertEqual(code, 0, filtered)
        self.assertEqual([r['id'] for r in filtered['results']], ['D104'])
        self.assertEqual(kb.search(self.root, 'depots', scope='ops')['results'], [])
        self.assertEqual(kb.lint(self.root)['records'], 11 + 5)
        self.assertEqual(len(kb.lint(self.root)['groups']), 2)
        code, status = self.cli('status')
        self.assertEqual(code, 0, status)
        self.assertEqual({r['scope'] for r in status['groups']}, {'tracker', 'ops'})

    def test_duplicate_ids_fail_lint_and_rebuild_naming_groups(self):
        groups = self.p.registry()['groups']
        groups[1].update(id_pattern=r'[DF]\d+', expected_ids=list(groups[0]['expected_ids']))
        self.write('docs/ops-decisions.md', self.original)
        self.p.write_registry(groups)
        self.import_copy(groups[1])
        for action in (kb.lint, kb.rebuild):
            with self.assertRaises(kb.KBError) as e:
                action(self.root)
            self.assertIn('Duplicate', str(e.exception))
            self.assertIn(TRACKER, str(e.exception))
            self.assertIn(OPS, str(e.exception))

    def test_invalid_scope_parser_and_duplicate_group_rejected(self):
        good = self.p.registry_path.read_bytes()
        for field, value in [('scope', 'other'), ('parser', 'backlog'), ('group', TRACKER)]:
            with self.subTest(field=field):
                groups = self.p.registry()['groups']
                groups[1][field] = value
                self.p.write_registry(groups)
                with self.assertRaises(kb.KBError):
                    kb.lint(self.root)
                self.p.registry_path.write_bytes(good)
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_store_group_cli_only_touches_selected_group(self):
        self.both_stores()
        other = self.files(TRACKER)
        before_config = self.p.registry_path.read_bytes()
        text_file = self.write('row.txt', self.p.changed('D104', ' Fixture edit.'))
        code, p = self.cli('store', 'propose', 'edit', 'D104', '--group', OPS,
                           '--text-file', text_file, '--reason', 'fixture', '--actor', 'ai')
        self.assertEqual(code, 0, p)
        number = str(p['proposal'])
        code, review = self.cli('store', 'review', number, '--group', OPS,
                                '--decision', 'approved', '--reviewed-by', 'human', '--reason', 'ok')
        self.assertEqual(code, 0, review)
        code, applied = self.cli('store', 'apply', number, '--group', OPS, '--actor', 'ai')
        self.assertEqual(code, 0, applied)
        self.assertIn('Fixture edit.', kb.get(self.root, 'D104')['text'])
        self.assert_unchanged(other)
        self.assertEqual(self.p.registry_path.read_bytes(), before_config)
        code, status = self.cli('store', 'status', '--group', OPS)
        self.assertEqual(code, 0, status)
        self.assertTrue(status['export_in_sync'])

    def test_two_stores_require_group_for_every_command(self):
        self.both_stores()
        for command in ('status', 'diff', 'ledger'):
            code, result = self.cli('store', command)
            self.assertEqual(code, 2, result)
            self.assertIn('--group', result['error'])
        code, result = self.cli('store', 'status', '--group', 'missing')
        self.assertEqual(code, 2)
        self.assertIn('missing', result['error'])

    def test_one_store_defaults_even_with_other_read_only_group(self):
        before = self.files(OPS)
        store.transfer(kb, self.root, 'human', 'fixture', group=TRACKER)
        code, status = self.cli('store', 'status')
        self.assertEqual(code, 0, status)
        self.assertEqual(status['records'], 11)
        self.assert_unchanged(before)

    def test_drift_warning_belongs_only_to_affected_hits(self):
        self.both_stores()
        source = self.root / kb.load_config(self.root, OPS)['source']
        source.write_bytes(source.read_bytes() + b'Hand note.\n')
        self.assertNotIn('warning', kb.get(self.root, 'D4'))
        self.assertIn('EXPORT DRIFT', kb.get(self.root, 'D104')['warning'])
        hits = {r['id']: r for r in kb.search(self.root, 'log', status='decided')['results']}
        self.assertNotIn('warning', hits['D4'])
        self.assertIn('EXPORT DRIFT', hits['D104']['warning'])
        clean = kb.search(self.root, 'log', scope='tracker')
        self.assertNotIn('warning', clean)
        with self.assertRaisesRegex(kb.KBError, 'ops-decisions.*EXPORT DRIFT'):
            kb.lint(self.root)
        other = self.files(TRACKER)
        store.restore(kb, self.root, 'ai', 'fixture restore', group=OPS)
        self.assert_unchanged(other)
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_rollback_one_group_preserves_other_group_and_journal(self):
        self.both_stores()
        before = self.files(TRACKER)
        other_entry = kb.load_config(self.root, TRACKER)
        result = store.rollback(kb, self.root, 'human', 'fixture rollback', group=OPS)
        self.assertTrue((self.root / result['archived_journal']).exists())
        self.assertEqual(kb.load_config(self.root, OPS)['mode'], 'read-only')
        self.assertEqual(kb.load_config(self.root, TRACKER), other_entry)
        self.assertEqual(kb.get(self.root, 'D104')['authority'], 'original-source')
        self.assert_unchanged(before)
        store.transfer(kb, self.root, 'human', 'fixture retransfer', group=OPS)
        self.assert_unchanged(before)
        self.assertEqual(kb.lint(self.root)['records'], 11 + 5)

    def test_import_refusal_and_stale_checks_stay_per_group(self):
        store.transfer(kb, self.root, 'human', 'fixture', group=TRACKER)
        before = self.files(TRACKER)
        with self.assertRaisesRegex(kb.KBError, 'authoritative'):
            kb.import_source(self.root, group=TRACKER)
        source = self.root / kb.load_config(self.root, OPS)['source']
        source.write_bytes(source.read_bytes() + b'New source note.\n')
        with self.assertRaisesRegex(kb.KBError, 'ops-decisions.*STALE'):
            kb.lint(self.root)
        kb.import_source(self.root, group=OPS)
        self.assert_unchanged(before)
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_duplicate_add_is_refused_before_any_store_write(self):
        self.both_stores()
        before = {**self.files(TRACKER), **self.files(OPS)}
        with self.assertRaisesRegex((kb.KBError, store.StoreError), 'Duplicate'):
            store.propose(kb, self.root, 'add', 'D104', 'decided',
                          '| D104 | Fixture | Cross-group duplicate | Reason |', 'r', 'ai', group=TRACKER)
        self.assert_unchanged(before)

    def test_index_tracks_each_group_and_rebuilds_deleted_or_tampered_index(self):
        self.both_stores()
        kb.rebuild(self.root)
        target = kb.db_path(self.root)
        self.assertEqual(target.name, 'kb.sqlite')

        def fingerprint():
            with closing(sqlite3.connect(target)) as conn:
                return dict(conn.execute('SELECT key, value FROM meta'))['store_hash']

        first = fingerprint()
        number = self.p.propose('edit', 'D104', None, self.p.changed('D104', ' Indexchange.'), group=OPS)
        self.p.approve_apply(number, group=OPS)
        self.assertNotEqual(fingerprint(), first)
        expected = kb.get(self.root, 'D104')
        target.unlink()
        self.assertEqual(kb.get(self.root, 'D104'), expected)
        with closing(sqlite3.connect(target)) as conn:
            columns = {row[1] for row in conn.execute('PRAGMA table_info(records)')}
            self.assertTrue({'id', 'grp', 'scope', 'type', 'status', 'payload'} <= columns)
            conn.execute("UPDATE records SET scope='tracker', grp='bad' WHERE id='D104'")
            conn.commit()
        self.assertEqual(kb.get(self.root, 'D104'), expected)
        self.assertEqual([r['id'] for r in kb.search(self.root, 'log', scope='ops', status='decided')['results']],
                         ['D104'])


if __name__ == '__main__':
    unittest.main()
