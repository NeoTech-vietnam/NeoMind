"""Read-only groups beside a store group: add, isolate failures, rollback. Temp project only."""

import json
import unittest

from . import project
from .project import ProjectCase, entry, kb, store

DEC = 'tracker-decisions'


class GroupTests(ProjectCase):
    GROUPS = (DEC,)
    STORES = (DEC,)
    KIT = {'kb': {'scopes': ['tracker', 'ops', 'policy']}}

    def setUp(self):
        super().setUp()
        live = kb.load_config(self.root, DEC)
        self.port = {k: v for k, v in live.items() if k not in kb.RUNTIME_KEYS}
        self.port_files = {self.root / live[k]: (self.root / live[k]).read_bytes() for k in ('source', 'store')}
        self.d5 = kb.get(self.root, 'D5')
        # md-table, md-bullet-id (its own scope, so a stale one can empty a scope), docx-field-table
        self.entries = [entry('ops-exceptions'), entry('ops-rules', scope='policy'), entry('ops-spec')]

    def add_all(self):
        for e in self.entries:
            kb.add_group(self.root, e, 'fixture add')

    def config(self):
        return self.p.registry()

    def assert_port_intact(self):
        self.assert_unchanged(self.port_files)
        self.assertEqual(self.config()['groups'][0], self.port)

    # ------------------------------------------------------------ add

    def test_add_group_imports_snapshots_and_keeps_the_store_group(self):
        before = self.p.registry_path.read_bytes()
        result = kb.add_group(self.root, self.entries[0], 'fixture add')
        snapshot = self.root / result['snapshot']
        self.assertEqual((snapshot / 'kb.json').read_bytes(), before)
        self.assertEqual(json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))['action'],
                         'add-group')
        self.assertTrue(kb.store_path(self.root, self.entries[0]).exists())
        for e in self.entries[1:]:
            kb.add_group(self.root, e, 'fixture add')
        lint = kb.lint(self.root)
        self.assertTrue(lint['ok'])
        self.assertEqual(lint['records'], 11 + 2 + 4 + 2)
        self.assertEqual([g['group'] for g in self.config()['groups']],
                         [DEC, 'ops-exceptions', 'ops-rules', 'ops-spec'])
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)
        self.assert_port_intact()
        spec = {g['group']: g for g in lint['groups']}['ops-spec']
        self.assertEqual(len(spec['skipped_source_ids']), 1)
        self.assertEqual(spec['parser'], 'docx-field-table')

    def test_add_group_refusals_leave_config_and_files_unchanged(self):
        kb.add_group(self.root, self.entries[0], 'fixture add')
        before = self.p.registry_path.read_bytes()
        clash = entry('ops-exceptions', group='ops-clash', source='docs/clash.md', id_prefix='',
                      id_pattern=r'D\d+', type='DEC', expected_ids=['D1'])
        self.write('docs/clash.md', project.NOTES_MD.replace('| 1 | address', '| D1 | address')
                   .replace('| 2 | damaged, see 1 |\n', ''))
        cases = [(self.entries[0], 'exists'),
                 ({**self.entries[1], 'mode': 'store', 'authority': 'kb-store',
                   'store': 'knowledge/kb/store/rules.jsonl'}, 'read-only'),
                 ({**self.entries[1], 'expected_ids': ['R0', 'R1']}, 'Source IDs changed'),
                 (clash, 'Duplicate ID D1'),
                 ({**self.entries[1], 'source': 'docs/missing.md'}, 'Source unavailable')]
        for e, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex((kb.KBError, store.StoreError), message):
                    kb.add_group(self.root, e, 'fixture add')
                self.assertEqual(self.p.registry_path.read_bytes(), before)
                if e['group'] != self.entries[0]['group']:
                    self.assertFalse(kb.store_path(self.root, e).exists())
        self.assert_port_intact()

    def test_cli_add_and_remove_group(self):
        entry_file = self.write('entry.json', json.dumps(self.entries[1]))
        code, result = self.cli('add-group', '--file', entry_file, '--reason', 'cli fixture')
        self.assertEqual(code, 0, result)
        code, result = self.cli('get', 'R11')
        self.assertEqual((code, result['scope']), (0, 'policy'))
        code, result = self.cli('remove-group', '--group', 'ops-rules', '--reason', 'cli fixture')
        self.assertEqual(code, 0, result)
        self.assert_port_intact()

    # ------------------------------------------------------------ read

    def test_scope_type_status_filters_and_provenance(self):
        self.add_all()
        r = kb.get(self.root, 'OPS-EXC-2')
        self.assertEqual((r['scope'], r['group'], r['mode'], r['authority']),
                         ('ops', 'ops-exceptions', 'read-only', 'original-source'))
        self.assertEqual(r['citation'], 'docs/notes.md:10')
        self.assertEqual(r['source_sha256'], kb.sha(self.p.path('docs/notes.md').read_bytes()))
        self.assertEqual([x['id'] for x in kb.search(self.root, 'damaged', scope='ops')['results']],
                         ['OPS-EXC-2'])
        self.assertEqual(kb.search(self.root, 'damaged', scope='tracker')['results'], [])
        code, hits = self.cli('search', 'edit', '--type', 'RULE', '--status', 'in-force', '--scope', 'policy')
        self.assertEqual(code, 0, hits)
        self.assertEqual([x['id'] for x in hits['results']], ['R11'])
        code, hits = self.cli('search', 'feedback', '--type', 'REQ', '--status', 'active')
        self.assertEqual([x['id'] for x in hits['results']], ['SPEC-FUN-SCAN-001'])
        self.assertEqual(hits['results'][0]['citation'], 'docs/spec.docx#table-2')
        self.assertNotIn('unavailable_groups', hits)
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)

    def test_stale_group_does_not_block_other_reads_or_store_writes(self):
        self.add_all()
        self.write('docs/rules.md', project.RULES_MD + '- **R3** — Added later.\n')
        with self.assertRaisesRegex(kb.KBError, 'ops-rules.*STALE'):
            kb.lint(self.root)
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)
        self.assertEqual(kb.get(self.root, 'OPS-EXC-1')['scope'], 'ops')
        with self.assertRaisesRegex(kb.KBError, 'ops-rules.*STALE'):
            kb.get(self.root, 'R1')
        partial = kb.search(self.root, 'decision')
        self.assertEqual([g['group'] for g in partial['unavailable_groups']], ['ops-rules'])
        self.assertIn('unavailable', partial['warning'])
        self.assertTrue(partial['results'])
        self.assertNotIn('policy', {x['scope'] for x in partial['results']})
        with self.assertRaisesRegex(kb.KBError, 'STALE'):
            kb.search(self.root, 'edit', scope='policy')  # Every group of that scope failed.
        code, status = self.cli('status')
        self.assertEqual(code, 0, status)
        self.assertFalse(status['ok'])
        self.assertEqual([g['group'] for g in status['unavailable_groups']], ['ops-rules'])
        rules = self.p.path('docs/rules.md').read_bytes()
        row = self.d5['text'].rstrip('\r\n')[:-1] + ' Fixture.|'
        number = store.propose(kb, self.root, 'edit', 'D5', None, row, 'fixture', 'ai', group=DEC)['proposal']
        store.review(kb, self.root, number, 'approved', 'human', 'fixture ok', group=DEC)
        store.apply(kb, self.root, number, 'ai', group=DEC)
        self.assertIn('Fixture.', kb.get(self.root, 'D5')['text'])
        self.assertEqual(self.p.path('docs/rules.md').read_bytes(), rules)
        with self.assertRaisesRegex(kb.KBError, r"unexpected=\['R3'\]"):
            kb.import_source(self.root, 'ops-rules')  # A new ID needs a reviewed entry.
        self.write('docs/rules.md', project.RULES_MD.replace('Clear.', 'Clear and short.'))
        kb.import_source(self.root, 'ops-rules')
        self.assertIn('Clear and short.', kb.get(self.root, 'R2')['text'])
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_store_uniqueness_still_counts_an_unavailable_group(self):
        self.write('docs/d6.md', '## Decisions\n\n| # | Decision |\n| --- | --- |\n| D6 | Elsewhere |\n')
        kb.add_group(self.root, entry('ops-exceptions', group='ops-d6', source='docs/d6.md',
                                      section='## Decisions', id_pattern=r'D\d+', id_prefix='', type='DEC',
                                      expected_ids=['D6']), 'fixture add')
        self.write('docs/d6.md', '## Decisions\n\n| # | Decision |\n| --- | --- |\n| D6 | Changed |\n')
        before = dict(self.port_files)
        with self.assertRaisesRegex(store.StoreError, 'Duplicate ID D6'):
            store.propose(kb, self.root, 'add', 'D6', 'decided', '| D6 | Fixture | New | Reason |', 'r', 'ai',
                          group=DEC)
        self.assert_unchanged(before)

    def test_missing_source_and_all_groups_unavailable(self):
        self.add_all()
        self.p.path('docs/spec.docx').unlink()
        with self.assertRaisesRegex(kb.KBError, 'ops-spec.*Source unavailable'):
            kb.get(self.root, 'SPEC-NFR-CMN-001')
        with self.assertRaisesRegex(kb.KBError, 'ops-spec.*Source unavailable'):
            kb.lint(self.root)
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'NOPE-1')

    def test_index_rebuilds_after_delete_or_corruption(self):
        self.add_all()
        expected = kb.get(self.root, 'SPEC-FUN-SCAN-001')
        kb.db_path(self.root).unlink()
        self.assertEqual(kb.get(self.root, 'SPEC-FUN-SCAN-001'), expected)
        kb.db_path(self.root).write_bytes(b'corrupt')
        self.assertEqual(kb.get(self.root, 'SPEC-FUN-SCAN-001'), expected)
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)

    def test_crlf_checkout_of_a_text_source_is_not_stale(self):
        self.add_all()
        before = {rid: kb.get(self.root, rid) for rid in ('R11', 'OPS-EXC-2')}
        for rel, text in (('docs/rules.md', project.RULES_MD), ('docs/notes.md', project.NOTES_MD)):
            self.write(rel, text.replace('\n', '\r\n'))  # What git autocrlf writes on checkout.
        self.assertTrue(kb.lint(self.root)['ok'])
        for rid, record in before.items():
            self.assertEqual(kb.get(self.root, rid), record)
        self.write('docs/rules.md', project.RULES_MD.replace('Clear.', 'Changed.').replace('\n', '\r\n'))
        with self.assertRaisesRegex(kb.KBError, 'ops-rules.*STALE'):
            kb.lint(self.root)

    def test_parse_cache_follows_the_source_and_never_hides_a_change(self):
        self.add_all()
        cache_dir = self.root / 'knowledge/.cache/parse'
        self.assertTrue(list(cache_dir.glob('ops-spec-*.json')))
        expected = kb.get(self.root, 'SPEC-NFR-CMN-001')
        for path in cache_dir.glob('*.json'):  # A damaged cache is ignored and rewritten.
            path.write_text('{bad', encoding='utf-8')
        self.assertEqual(kb.get(self.root, 'SPEC-NFR-CMN-001'), expected)
        for path in cache_dir.glob('ops-spec-*.json'):  # A cache entry with altered text is not trusted.
            data = json.loads(path.read_text(encoding='utf-8'))
            data['records'][0]['text'] = 'Altered'
            path.write_text(json.dumps(data), encoding='utf-8')
        self.assertEqual(kb.get(self.root, 'SPEC-NFR-CMN-001'), expected)
        self.write('docs/spec.docx', project.docx_bytes(project.spec_body().replace('200 ms', '100 ms')))
        with self.assertRaisesRegex(kb.KBError, 'STALE'):
            kb.get(self.root, 'SPEC-NFR-CMN-001')
        kb.import_source(self.root, 'ops-spec')
        self.assertIn('100 ms', kb.get(self.root, 'SPEC-NFR-CMN-001')['text'])

    # ------------------------------------------------------------ authority and rollback

    def test_new_parsers_cannot_become_store_groups(self):
        self.add_all()
        before = self.p.registry_path.read_bytes()
        with self.assertRaisesRegex(store.StoreError, 'decision-table'):
            store.transfer(kb, self.root, 'human', 'fixture', group='ops-exceptions')
        self.assertEqual(self.p.registry_path.read_bytes(), before)
        self.assertFalse((self.root / 'knowledge/kb/store/ops-exceptions.jsonl').exists())

    def test_remove_group_restores_previous_kb(self):
        self.add_all()
        others = [g for g in self.config()['groups'] if g['group'] != 'ops-rules']
        copy = kb.store_path(self.root, self.entries[1])
        result = kb.remove_group(self.root, 'ops-rules', 'fixture rollback')
        self.assertEqual(self.config()['groups'], others)
        self.assertFalse(copy.exists())
        self.assertTrue((self.root / result['snapshot'] / copy.name).exists())
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.get(self.root, 'R1')
        self.assertTrue(kb.lint(self.root)['ok'])
        self.assertEqual(kb.get(self.root, 'D5'), self.d5)
        before = self.p.registry_path.read_bytes()
        for group, message in [(DEC, 'store rollback'), ('missing', 'Unknown group')]:
            with self.assertRaisesRegex((kb.KBError, store.StoreError), message):
                kb.remove_group(self.root, group, 'fixture')
        self.assertEqual(self.p.registry_path.read_bytes(), before)
        self.assert_port_intact()


if __name__ == '__main__':
    unittest.main()
