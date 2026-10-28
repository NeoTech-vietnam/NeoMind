"""Where the KB keeps its files: every path comes from kit.json through kbpaths; kb.json is checked."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from .project import KB_PY, Project, ProjectCase, entry, kb, kbpaths, store

DEC = 'tracker-decisions'


def tree(root, *names):
    """Sorted project-relative paths of every file under root whose path contains one of `names`."""
    return sorted(p.relative_to(root).as_posix() for p in Path(root).rglob('*')
                  if p.is_file() and any(n in p.relative_to(root).as_posix() for n in names))


class DefaultLayoutTests(ProjectCase):
    GROUPS = (DEC, 'ops-rules')
    STORES = (DEC,)

    def test_paths_follow_the_default_config(self):
        r = self.root
        self.assertEqual(kbpaths.kb_dir(r), 'knowledge/kb')
        self.assertEqual(kbpaths.registry(r), 'knowledge/kb/kb.json')
        self.assertEqual(kbpaths.copies_dir(r), 'knowledge/kb/copies')
        self.assertEqual(kbpaths.store_dir(r), 'knowledge/kb/store')
        self.assertEqual(kbpaths.snapshots_dir(r), 'knowledge/kb/.snapshots')
        self.assertEqual(kbpaths.cache_dir(r), 'knowledge/.cache')

    def test_files_land_in_those_places(self):
        self.assertTrue((self.root / 'knowledge/kb/kb.json').is_file())
        self.assertTrue((self.root / 'knowledge/kb/copies/ops-rules.jsonl').is_file())
        self.assertTrue((self.root / 'knowledge/kb/store/tracker-decisions.jsonl').is_file())
        self.assertTrue(list((self.root / 'knowledge/kb/.snapshots').glob('transfer-*/decisions.md')))
        self.assertTrue((self.root / 'knowledge/.cache/kb.sqlite').is_file())
        self.assertTrue(list((self.root / 'knowledge/.cache/parse').glob('ops-rules-*.json')))
        self.assertEqual(self.p.cfg(DEC)['store'], 'knowledge/kb/store/tracker-decisions.jsonl')

    def test_an_empty_copies_or_store_dir_means_the_default(self):
        self.p.write_kit(kb={'copies_dir': '', 'store_dir': None})
        self.assertEqual(kbpaths.copies_dir(self.root), 'knowledge/kb/copies')
        self.assertEqual(kbpaths.store_dir(self.root), 'knowledge/kb/store')

    def test_a_journal_outside_the_store_dir_is_refused(self):
        groups = self.p.registry()['groups']
        groups[0]['store'] = 'knowledge/kb/elsewhere/tracker-decisions.jsonl'
        self.p.write_registry(groups)
        with self.assertRaisesRegex(store.StoreError, 'Journal must be a regular file in the store directory'):
            kb.get(self.root, 'D1')


class CustomLayoutTests(ProjectCase):
    GROUPS = (DEC, 'ops-rules')
    STORES = (DEC,)
    KIT = {'paths': {'kb': 'kb-data\\inner/', 'cache': 'scratch/cache'},
           'kb': {'copies_dir': 'mirror', 'store_dir': 'ledger'}}

    def test_every_path_comes_from_the_config(self):
        r = self.root
        self.assertEqual(kbpaths.kb_dir(r), 'kb-data/inner')  # Backslashes and a trailing slash are normalised.
        self.assertEqual(kbpaths.registry(r), 'kb-data/inner/kb.json')
        self.assertEqual(kbpaths.copies_dir(r), 'kb-data/inner/mirror')
        self.assertEqual(kbpaths.store_dir(r), 'kb-data/inner/ledger')
        self.assertEqual(kbpaths.snapshots_dir(r), 'kb-data/inner/.snapshots')
        self.assertEqual(kbpaths.cache_dir(r), 'scratch/cache')

    def test_nothing_is_written_to_the_default_places(self):
        files = tree(self.root, 'kb-data', 'scratch')
        self.assertIn('kb-data/inner/kb.json', files)
        self.assertIn('kb-data/inner/mirror/ops-rules.jsonl', files)
        self.assertIn('kb-data/inner/ledger/tracker-decisions.jsonl', files)
        self.assertIn('scratch/cache/kb.sqlite', files)
        self.assertTrue(any(f.startswith('kb-data/inner/.snapshots/transfer-') for f in files))
        self.assertTrue(any(f.startswith('scratch/cache/parse/ops-rules-') for f in files))
        for default in ('knowledge', 'copies', 'store'):
            self.assertFalse((self.root / default).exists(), default)
        self.assertEqual(self.p.cfg(DEC)['store'], 'kb-data/inner/ledger/tracker-decisions.jsonl')

    def test_the_commands_work_with_the_custom_layout(self):
        code, result = self.cli('get', 'D5')
        self.assertEqual((code, result['authority']), (0, 'kb-store'))
        text = self.write('row.txt', self.p.changed('D4'))
        code, p = self.cli('store', 'propose', 'edit', 'D4', '--text-file', text, '--reason', 'r', '--actor', 'ai')
        self.assertEqual(code, 0, p)
        self.assertEqual(self.p.journal(DEC), self.root / 'kb-data/inner/ledger/tracker-decisions.jsonl')
        self.assertFalse((store.home(self.root) / '.write.lock').exists())

    def test_rollback_archives_in_the_configured_store_dir(self):
        result = store.rollback(kb, self.root, 'approver', 'fixture rollback', group=DEC)
        self.assertTrue(result['archived_journal'].startswith('kb-data/inner/ledger/archive/'))
        self.assertTrue((self.root / result['archived_journal']).exists())
        self.assertTrue(kb.store_path(self.root, self.p.cfg(DEC)).is_file())
        self.assertEqual(kb.store_path(self.root, self.p.cfg(DEC)).parent, self.root / 'kb-data/inner/mirror')

    def test_add_and_remove_group_snapshot_in_the_configured_place(self):
        result = kb.add_group(self.root, entry('ops-exceptions'), 'fixture add')
        self.assertTrue(result['snapshot'].startswith('kb-data/inner/.snapshots/config-'))
        self.assertTrue((self.root / 'kb-data/inner/mirror/ops-exceptions.jsonl').is_file())
        result = kb.remove_group(self.root, 'ops-exceptions', 'fixture rollback')
        self.assertTrue((self.root / result['snapshot'] / 'ops-exceptions.jsonl').is_file())


class CommandLineRootTests(unittest.TestCase):
    def test_without_root_the_project_around_the_working_folder_is_used(self):
        p = Project((DEC,))
        self.addCleanup(p.close)
        inner = p.path('docs')
        done = subprocess.run([sys.executable, str(KB_PY), 'get', 'D1'], cwd=inner,
                              capture_output=True, encoding='utf-8')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)['id'], 'D1')

    def test_outside_any_project_the_error_is_reported_as_json(self):
        with tempfile.TemporaryDirectory(prefix='kbt-empty-') as folder:
            try:
                kbpaths.kitconfig.find_project_root(folder)
            except kbpaths.kitconfig.ConfigError:
                pass
            else:  # pragma: no cover - a kit.json above the temp folder
                self.skipTest('a kit.json exists above the temp folder')
            done = subprocess.run([sys.executable, str(KB_PY), 'status'], cwd=folder,
                                  capture_output=True, encoding='utf-8')
        self.assertEqual(done.returncode, 2)
        result = json.loads(done.stdout)
        self.assertFalse(result['ok'])
        self.assertIn('kit.json', result['error'])

    def test_a_root_without_kit_json_is_reported(self):
        with tempfile.TemporaryDirectory(prefix='kbt-empty-') as folder:
            done = subprocess.run([sys.executable, str(KB_PY), '--root', folder, 'status'],
                                  capture_output=True, encoding='utf-8')
        self.assertEqual(done.returncode, 2)
        self.assertIn('kit.json', json.loads(done.stdout)['error'])


class ContainmentTests(unittest.TestCase):
    """`kb.inside` keeps every configured path inside the project folder."""

    ROOT = Path(tempfile.gettempdir()) / 'kbt-contain'

    def test_relative_paths_inside_are_joined_to_the_root(self):
        self.assertEqual(kb.inside(self.ROOT, 'docs/a.md'), self.ROOT / 'docs' / 'a.md')
        self.assertEqual(kb.inside(self.ROOT, 'a.md'), self.ROOT / 'a.md')

    def test_parent_steps_and_drive_paths_are_refused(self):
        for rel in ('../a.md', 'docs/../../a.md', 'docs/../a.md', 'C:/a.md', 'C:a.md', str(Path(tempfile.gettempdir()) / 'a.md')):
            with self.subTest(rel=rel), self.assertRaisesRegex(kb.KBError, 'Invalid workspace-relative path'):
                kb.inside(self.ROOT, rel)

    def test_a_rooted_path_without_a_drive_is_refused(self):
        for rel in ('/a.md', '\\a.md'):
            with self.subTest(rel=rel), self.assertRaisesRegex(kb.KBError, 'Invalid workspace-relative path'):
                kb.inside(self.ROOT, rel)


class RegistryChecksTests(ProjectCase):
    """kb.json is read with checks: a bad entry stops every command and names the problem."""

    GROUPS = (DEC, 'ops-rules')

    def write_groups(self, groups):
        self.p.write_registry(groups)

    def test_a_missing_kb_json_is_an_error(self):
        self.p.registry_path.unlink()
        with self.assertRaisesRegex(kb.KBError, 'No KB config: knowledge/kb/kb.json does not exist'):
            kb.load_groups(self.root)
        code, result = self.cli('status')
        self.assertEqual(code, 2)
        self.assertIn('No KB config', result['error'])

    def test_schema_version_and_shape(self):
        path = self.p.registry_path
        for text in ('[]', '{"schema_version": 1, "groups": []}', '{"schema_version": 2}',
                     '{"schema_version": 2, "groups": {}}'):
            with self.subTest(text=text):
                path.write_text(text, encoding='utf-8')
                with self.assertRaises(kb.KBError):
                    kb.load_groups(self.root)

    def test_group_entry_checks(self):
        good = self.p.registry()['groups']
        cases = [('group', 'Bad_Name', 'Invalid group name'), ('group', 'a--b', 'Invalid group name'),
                 ('group', '', 'Invalid group name'), ('mode', 'store', 'Unsupported group mode/authority'),
                 ('authority', 'kb-store', 'Unsupported group mode/authority'),
                 ('parser', 'spreadsheet', 'Unsupported parser'), ('scope', 'nowhere', 'Invalid scope'),
                 ('source', '../outside.md', 'Invalid workspace-relative path'),
                 ('source', str(Path(tempfile.gettempdir()) / 'x.md'), 'Invalid workspace-relative path'),
                 ('source', '', 'Missing source'), ('expected_ids', ['D1', 'D1'], 'Invalid or duplicate expected IDs'),
                 ('expected_ids', [], 'Invalid or duplicate expected IDs'),
                 ('expected_ids', ['X9'], 'Invalid or duplicate expected IDs')]
        for key, value, message in cases:
            with self.subTest(key=key, value=value):
                groups = json.loads(json.dumps(good))
                groups[0][key] = value
                self.write_groups(groups)
                with self.assertRaisesRegex(kb.KBError, message):
                    kb.load_groups(self.root)
        self.write_groups(good)
        self.assertEqual(len(kb.load_groups(self.root)), 2)

    def test_a_store_group_needs_its_journal_path(self):
        groups = self.p.registry()['groups']
        groups[0].update(mode='store', authority='kb-store')
        self.write_groups(groups)
        with self.assertRaisesRegex(kb.KBError, 'Missing store for tracker-decisions'):
            kb.load_groups(self.root)

    def test_two_groups_cannot_share_a_source_file(self):
        groups = self.p.registry()['groups']
        groups[1].update(source=groups[0]['source'])
        self.write_groups(groups)
        with self.assertRaisesRegex(kb.KBError, 'separate source/export files'):
            kb.load_groups(self.root)

    def test_two_groups_cannot_share_a_name(self):
        groups = self.p.registry()['groups']
        groups[1]['group'] = groups[0]['group']
        self.write_groups(groups)
        with self.assertRaisesRegex(kb.KBError, 'Duplicate group'):
            kb.load_groups(self.root)

    def test_a_bad_entry_stops_the_command_line_with_json(self):
        groups = self.p.registry()['groups']
        groups[1]['parser'] = 'spreadsheet'
        self.write_groups(groups)
        for args in (('status',), ('lint',), ('get', 'D1'), ('search', 'fixture')):
            with self.subTest(args=args):
                code, result = self.cli(*args)
                self.assertEqual(code, 2, result)
                self.assertFalse(result['ok'])
                self.assertIn('Unsupported parser', result['error'])


if __name__ == '__main__':
    unittest.main()
