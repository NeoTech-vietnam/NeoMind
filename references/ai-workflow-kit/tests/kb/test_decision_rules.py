"""decision-table settings from the group entry: id_pattern, sections (any language) and link_pattern."""

import unittest

from . import project
from .project import ProjectCase, entry, kb, store

VI_DOC = '''# Quyết định vận hành

## Đã chốt

| # | Chủ đề | Quyết định | Lý do |
| --- | --- | --- | --- |
| Q1 | Kho | Kho trung tâm, xem T5 | Gần cảng |
| Q2 | Xe | Thuê xe, tiếp theo Q1 | Rẻ hơn |

## Chưa chốt

| # | Chủ đề | Việc cần làm |
| --- | --- | --- |
| Q3 | Ca đêm | So sánh phương án |

## Phản hồi

| # | Khách hỏi | Trả lời |
| --- | --- | --- |
| Q4 | Giờ giao | Buổi chiều |
'''

VI_SECTIONS = [['## Đã chốt', 'decided', 'source-reported-decided'],
               ['## Chưa chốt', 'open', 'not-approved'],
               ['## Phản hồi', 'recorded-response', 'not-stated-in-source']]


def vi_cfg(**extra):
    return {'group': 'ops-vi', 'scope': 'ops', 'mode': 'read-only', 'authority': 'original-source',
            'parser': 'decision-table', 'source': 'docs/vi.md', 'id_pattern': r'Q\d+',
            'link_pattern': r'\b(?:Q\d+|T\d+)\b', 'sections': VI_SECTIONS,
            'expected_ids': ['Q1', 'Q2', 'Q3', 'Q4'], **extra}


class CustomSectionTests(ProjectCase):
    GROUPS = ()
    SETUP = False

    def setUp(self):
        super().setUp()
        self.write('docs/vi.md', VI_DOC)

    def test_headings_in_another_language_give_the_same_statuses(self):
        records = {r['id']: r for r in kb.extract(self.root, vi_cfg())}
        self.assertEqual({k: (r['status'], r['approval_status']) for k, r in records.items()},
                         {'Q1': ('decided', 'source-reported-decided'), 'Q2': ('decided', 'source-reported-decided'),
                          'Q3': ('open', 'not-approved'), 'Q4': ('recorded-response', 'not-stated-in-source')})
        self.assertEqual(records['Q3']['section'], '## Chưa chốt')
        lines = VI_DOC.splitlines(keepends=True)
        for r in records.values():
            self.assertEqual(r['text'], lines[r['source_line'] - 1])
            self.assertEqual(r['type'], 'DEC')

    def test_a_heading_not_in_the_list_is_an_error(self):
        # The English defaults do not apply once a group names its own sections.
        self.write('docs/vi.md', VI_DOC.replace('## Chưa chốt', '## Open'))
        with self.assertRaisesRegex(kb.KBError, 'Unknown decision section for Q3: ## Open'):
            kb.extract(self.root, vi_cfg())

    def test_default_sections_are_english_and_do_not_read_other_headings(self):
        self.assertEqual([s[0] for s in kb.SECTIONS], ['## Decided', '## Open', '## Responses'])
        with self.assertRaisesRegex(kb.KBError, 'Unknown decision section'):
            kb.extract(self.root, {k: v for k, v in vi_cfg().items() if k != 'sections'})

    def test_a_shorter_list_leaves_the_other_sections_unknown(self):
        cfg = vi_cfg(sections=VI_SECTIONS[:2])
        with self.assertRaisesRegex(kb.KBError, 'Unknown decision section for Q4'):
            kb.extract(self.root, cfg)

    def test_search_finds_a_heading_without_its_accents(self):
        self.p.write_registry([vi_cfg()])
        kb.import_source(self.root, 'ops-vi')
        hits = {r['id'] for r in kb.search(self.root, 'chot', status='decided')['results']}
        self.assertEqual(hits, {'Q1', 'Q2'})

    def test_the_store_adds_and_moves_by_status_name_under_the_local_heading(self):
        self.p.write_registry([vi_cfg()])
        kb.import_source(self.root, 'ops-vi')
        store.transfer(kb, self.root, 'approver', 'fixture', group='ops-vi')
        self.p.apply_change('add', 'Q5', 'decided', '| Q5 | Cổng | Cổng B | Gần kho |', group='ops-vi')
        self.assertEqual(kb.get(self.root, 'Q5')['status'], 'decided')
        self.assertEqual(kb.get(self.root, 'Q5')['section'], '## Đã chốt')
        self.p.apply_change('move', 'Q3', 'decided', '| Q3 | Ca đêm | Hai ca | Đủ người |', group='ops-vi')
        self.assertEqual((kb.get(self.root, 'Q3')['status'], kb.get(self.root, 'Q3')['approval_status']),
                         ('decided', 'approved-in-kb'))
        text = self.p.read('docs/vi.md')
        self.assertLess(text.index('| Q5 |'), text.index('## Chưa chốt'))
        # The section argument is a status name, not the heading text.
        with self.assertRaisesRegex(store.StoreError, 'Section must be one of: decided, open, recorded-response'):
            self.p.propose('add', 'Q6', '## Đã chốt', '| Q6 | a | b | c |', group='ops-vi')
        # The ID check uses the group's id_pattern.
        with self.assertRaisesRegex(store.StoreError, 'New ID must look like'):
            self.p.propose('add', 'D6', 'decided', '| D6 | a | b | c |', group='ops-vi')
        self.assertTrue(kb.lint(self.root)['ok'])

    def test_invalid_sections_are_rejected(self):
        bad_lists = ['## Đã chốt', [], [['## Đã chốt', 'decided']], [['Đã chốt', 'decided', 'not-approved']],
                     [['## Đã chốt', 'maybe', 'not-approved']], [['## Đã chốt', 'decided', 'approved']],
                     [['## Đã chốt', 'decided', '']], [['', 'decided', 'not-approved']]]
        for sections in bad_lists:
            with self.subTest(sections=sections), self.assertRaisesRegex(kb.KBError, 'sections for ops-vi'):
                kb.checked_group(self.root, vi_cfg(sections=sections))
        kb.checked_group(self.root, vi_cfg())


class PatternTests(ProjectCase):
    GROUPS = ()
    SETUP = False

    def setUp(self):
        super().setUp()
        self.write('docs/vi.md', VI_DOC)

    def test_link_pattern_names_ids_outside_the_group(self):
        records = {r['id']: r for r in kb.extract(self.root, vi_cfg())}
        self.assertEqual(records['Q1']['links'], ['T5'])
        self.assertEqual(records['Q2']['links'], ['Q1'])

    def test_without_link_pattern_links_are_the_group_own_ids(self):
        cfg = {k: v for k, v in vi_cfg().items() if k != 'link_pattern'}
        records = {r['id']: r for r in kb.extract(self.root, cfg)}
        self.assertEqual(records['Q1']['links'], [])  # T5 is not a Q id.
        self.assertEqual(records['Q2']['links'], ['Q1'])

    def test_an_external_link_is_listed_by_lint(self):
        self.p.write_registry([vi_cfg()])
        kb.import_source(self.root, 'ops-vi')
        self.assertEqual(kb.lint(self.root)['external_links_not_in_pilot'], ['T5'])

    def test_default_id_pattern_is_d_and_a_number(self):
        self.write('docs/vi.md', VI_DOC.replace('Q', 'D'))
        cfg = {k: v for k, v in vi_cfg().items() if k not in ('id_pattern', 'link_pattern')}
        cfg['expected_ids'] = ['D1', 'D2', 'D3', 'D4']
        records = kb.extract(self.root, cfg)
        self.assertEqual([r['id'] for r in records], ['D1', 'D2', 'D3', 'D4'])
        with self.assertRaisesRegex(kb.KBError, 'Invalid or duplicate expected IDs'):
            kb.checked_group(self.root, {**cfg, 'expected_ids': ['Q1']})

    def test_bad_patterns_are_rejected(self):
        for key, value, message in [('id_pattern', '(', 'Invalid id_pattern or link_pattern'),
                                    ('id_pattern', r'(Q)\d+', r'\(\?:'),
                                    ('link_pattern', '[', 'Invalid id_pattern or link_pattern'),
                                    ('link_pattern', r'\b(Q\d+)\b', r'\(\?:')]:
            with self.subTest(key=key, value=value), self.assertRaisesRegex(kb.KBError, message):
                kb.checked_group(self.root, vi_cfg(**{key: value}))

    def test_a_row_before_any_table_header_is_an_error(self):
        self.write('docs/vi.md', '## Đã chốt\n\n| Q1 | Kho | x | y |\n')
        with self.assertRaisesRegex(kb.KBError, 'Missing table header for Q1'):
            kb.extract(self.root, vi_cfg(expected_ids=['Q1']))

    def test_a_custom_pattern_decides_what_counts_as_a_row(self):
        # Rows with another ID shape are not records: they are ignored, and the ID set check still holds.
        self.write('docs/vi.md', VI_DOC.replace('| Q4 |', '| X4 |'))
        with self.assertRaisesRegex(kb.KBError, r'missing=\[\'Q4\'\]'):
            kb.extract(self.root, vi_cfg())

    def test_the_ops_group_of_the_catalogue_uses_the_default_pattern_and_sections(self):
        cfg = entry('ops-decisions')
        self.assertNotIn('id_pattern', cfg)
        self.assertNotIn('sections', cfg)
        records = kb.extract(self.root, cfg)
        self.assertEqual({r['id']: r['status'] for r in records},
                         {'D101': 'decided', 'D102': 'decided', 'D103': 'decided', 'D104': 'decided',
                          'D105': 'open'})
        self.assertEqual(records[3]['links'], ['D101'])
        self.assertTrue(project.OPS_DECISIONS_MD.startswith('# Operations decisions'))


if __name__ == '__main__':
    unittest.main()
