"""py-literal parser: one record per dict of a module-level list in a generated Python table.

The table is code, not Markdown. The parser reads it with `ast.literal_eval`, so nothing in the source runs.
"""

import ast
import unittest

from . import project
from .project import ProjectCase, entry, kb

TABLE = project.CARRIERS_PY


def cfg(**extra):
    return entry('ops-carriers', expected_ids=['CARRIER-road_standard'], **extra)


def parse(text, **extra):
    return kb.parse_source(cfg(**extra), text.encode('utf-8'), 'sha')


class PyLiteralTests(ProjectCase):
    GROUPS = ()
    SETUP = False

    def test_one_record_per_dict(self):
        records, notes = parse(TABLE)
        self.assertEqual([r['id'] for r in records], ['CARRIER-road_standard', 'CARRIER-air_express'])
        first = records[0]
        self.assertEqual(first['type'], 'CONST')
        self.assertEqual(first['status'], 'in-force')
        self.assertEqual(first['section'], 'CARRIERS')
        self.assertEqual(first['source_line'], 6)
        self.assertEqual(first['source_locator'], 'CARRIERS[0]')
        self.assertIn('rate_per_kg: 0.048', first['text'])
        self.assertIn('max_kg: 25.0', first['text'])
        self.assertEqual(notes['skipped_source_ids'], [])

    def test_crlf_source_reads_the_same(self):
        self.assertEqual(parse(TABLE)[0], parse(TABLE.replace('\n', '\r\n'))[0])

    def test_nothing_in_the_source_runs(self):
        hostile = TABLE.replace("'max_kg': 6.0", "'max_kg': __import__('os').getcwd()")
        with self.assertRaisesRegex(kb.KBError, r'CARRIERS\[1\] is not a literal'):
            parse(hostile)

    def test_missing_variable_or_key_is_an_error(self):
        with self.assertRaisesRegex(kb.KBError, 'No module-level assignment to SETUPS'):
            parse(TABLE, variable='SETUPS')
        with self.assertRaisesRegex(kb.KBError, r'CARRIERS\[0\] has no name'):
            parse(TABLE, id_column='name')
        with self.assertRaisesRegex(kb.KBError, 'not a list'):
            parse(TABLE, variable='META')

    def test_bad_id_is_skipped_and_duplicate_is_an_error(self):
        records, notes = parse(TABLE.replace("'air_express'", "'Air Express'"))
        self.assertEqual([r['id'] for r in records], ['CARRIER-road_standard'])
        self.assertEqual(notes['skipped_source_ids'], [{'line': 11, 'id': 'Air Express'}])
        with self.assertRaisesRegex(kb.KBError, 'Duplicate source ID'):
            parse(TABLE.replace("'air_express'", "'road_standard'"))

    def test_config_needs_variable_and_key_and_stays_read_only(self):
        kb.checked_group(self.root, cfg())
        for bad in ({'variable': ''}, {'variable': 'not a name'}, {'id_column': ''}):
            with self.subTest(bad=bad), self.assertRaisesRegex(kb.KBError, 'needs variable'):
                kb.checked_group(self.root, cfg(**bad))
        with self.assertRaisesRegex(kb.KBError, 'read-only groups only'):
            kb.checked_group(self.root, cfg(mode='store', authority='kb-store', store='knowledge/kb/store/x.jsonl'))

    def test_project_table_matches_an_independent_read(self):
        text = self.p.read('data/carriers.py')
        tree = ast.parse(text)
        node = next(n for n in tree.body if isinstance(n, ast.Assign) and n.targets[0].id == 'CARRIERS')
        expected = [d['carrier'] for d in ast.literal_eval(node.value)]
        records, notes = parse(text)
        self.assertEqual([r['id'] for r in records], ['CARRIER-' + c for c in expected])
        self.assertEqual(notes['skipped_source_ids'], [])
        self.assertGreaterEqual(len(records), 2)


if __name__ == '__main__':
    unittest.main()
