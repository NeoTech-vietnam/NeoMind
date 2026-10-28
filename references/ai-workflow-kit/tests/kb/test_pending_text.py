"""`store pending --out`: the Markdown text comes from the project's ui_lang and names its reviewer."""

import unittest

from .project import ProjectCase, kb, kbpaths, store

DEC, REQ, TESTS, LESSONS = 'tracker-decisions', 'tracker-requirements', 'tracker-tests', 'tracker-lessons'


class PendingCase(ProjectCase):
    GROUPS = (DEC, REQ, LESSONS, TESTS)
    STORES = (DEC, LESSONS, TESTS)

    def pending_file(self, name='review/pending.md'):
        out = self.root / name
        store.pending(kb, self.root, out=out)
        return out.read_text(encoding='utf-8')

    def waiting_and_approved(self):
        """One edit waiting for review and one test row approved but not applied."""
        edit = self.p.propose('edit', 'D4', None, self.p.changed('D4', ' Pending change.'), group=DEC)
        proposal = kb.test_add(self.root, 'REQ-SCAN-001', 'L0', 'make', 'ok', 'pass', 'b1', 'fixture', 'ai')
        store.review(kb, self.root, proposal['proposal'], 'approved', 'human', 'ok', group=TESTS)
        return edit, proposal['proposal']

    def pathless_lesson(self):
        """A lesson proposal that names no path, as one written before the check existed."""
        cfg = kb.load_config(self.root, LESSONS)
        path, events, _ = store.load(kb, self.root, cfg)
        store.append(kb, path, events, 'propose', cfg, op='add', id='LES-002', section='Lessons', before='',
                     after='| LES-002 | label facade | x | e | Active |\n', reason='old', actor='ai')


class EnglishTests(PendingCase):
    def test_the_text_is_english_and_names_the_reviewer(self):
        edit, tests = self.waiting_and_approved()
        text = self.pending_file()
        self.assertTrue(text.startswith('# KB: proposals waiting for Alex Doe\n'), text[:60])
        self.assertIn('> Written by `kb.py store pending --out`, read only. 1 waiting, 1 approved but not applied. '
                      'Review in chat by group and #.', text)
        self.assertIn('## Waiting for review (1)', text)
        self.assertIn('## Approved, not applied (1)', text)
        self.assertIn(f'### {DEC} #{edit} · edit D4', text)
        self.assertIn('- Reason: Fixture reason', text)
        self.assertIn('**Before:**', text)
        self.assertIn('**After:**', text)
        self.assertIn(f'### {TESTS} #{tests} · add TST-001', text)
        self.assertIn('**New row:**', text)
        self.assertIn('| TST-001 | REQ-SCAN-001 | L0 |', text)
        self.assertNotIn('Chờ duyệt', text)
        self.assertNotIn('\n\n\n', text)  # Blank lines are collapsed.

    def test_nothing_waiting_says_so(self):
        text = self.pending_file()
        self.assertIn('No proposal is waiting.', text)
        self.assertIn('0 waiting, 0 approved but not applied', text)
        self.assertNotIn('## Waiting', text)

    def test_a_lesson_without_a_path_is_flagged(self):
        self.pathless_lesson()
        text = self.pending_file()
        self.assertIn('- Hook sees: **nothing**: put the path in backticks', text)

    def test_a_lesson_with_a_path_lists_it(self):
        self.p.propose('add', 'LES-002', 'Lessons', '| LES-002 | `vendor/labels/api.json` | x | e | Active |', group=LESSONS)
        self.assertIn('- Hook sees: vendor/labels/api.json', self.pending_file())

    def test_the_returned_data_does_not_depend_on_the_language(self):
        edit, tests = self.waiting_and_approved()
        result = store.pending(kb, self.root)
        self.assertEqual([(x['group'], x['proposal'], x['id']) for x in result['pending']], [(DEC, edit, 'D4')])
        self.assertEqual([(x['group'], x['proposal'], x['id']) for x in result['approved_not_applied']],
                         [(TESTS, tests, 'TST-001')])
        self.assertNotIn('written', result)

    def test_the_command_line_writes_the_file_and_filters_by_group(self):
        self.waiting_and_approved()
        out = self.root / 'cli' / 'pending.md'
        code, result = self.cli('store', 'pending', '--out', out)
        self.assertEqual((code, result['written']), (0, str(out)))
        self.assertIn('## Waiting for review (1)', out.read_text(encoding='utf-8'))
        code, result = self.cli('store', 'pending', '--group', TESTS, '--out', out)
        self.assertEqual((code, result['pending']), (0, []))
        self.assertIn('## Approved, not applied (1)', out.read_text(encoding='utf-8'))
        self.assertNotIn('Waiting for review', out.read_text(encoding='utf-8'))
        code, result = self.cli('store', 'pending', '--group', REQ)
        self.assertEqual(code, 2)
        self.assertIn('No store group tracker-requirements', result['error'])


class VietnameseTests(PendingCase):
    KIT = {'project': {'ui_lang': 'vi'}}

    def test_the_text_is_vietnamese_and_names_the_reviewer(self):
        edit, tests = self.waiting_and_approved()
        text = self.pending_file()
        self.assertTrue(text.startswith('# KB — đề xuất chờ Alex Doe\n'), text[:60])
        self.assertIn('> Sinh bằng `kb.py store pending --out`, chỉ để đọc. 1 chờ duyệt, 1 đã duyệt chưa apply. '
                      'Duyệt trong chat theo nhóm và số #.', text)
        self.assertIn('## Chờ duyệt (1)', text)
        self.assertIn('## Đã duyệt, chưa apply (1)', text)
        self.assertIn(f'### {DEC} #{edit} · edit D4', text)
        self.assertIn('- Lý do: Fixture reason', text)
        self.assertIn('**Trước:**', text)
        self.assertIn('**Sau:**', text)
        self.assertIn('**Dòng mới:**', text)
        for english in ('Waiting for review', 'Reason:', 'New row', 'Before:'):
            self.assertNotIn(english, text)

    def test_nothing_waiting_says_so(self):
        text = self.pending_file()
        self.assertIn('Không có đề xuất nào đang chờ.', text)
        self.assertNotIn('No proposal is waiting.', text)

    def test_a_lesson_without_a_path_is_flagged(self):
        self.pathless_lesson()
        self.assertIn('- Hook thấy: **không** — cần đường dẫn trong backtick', self.pending_file())

    def test_the_file_is_utf_8(self):
        self.waiting_and_approved()
        out = self.root / 'review/pending.md'
        store.pending(kb, self.root, out=out)
        self.assertIn('đề xuất'.encode('utf-8'), out.read_bytes())


class ReviewerNameTests(PendingCase):
    def test_the_reviewer_is_project_reviewer_then_owner_then_a_generic_word(self):
        self.assertEqual(kbpaths.reviewer(self.root), 'Alex Doe')
        self.p.write_kit(project={'reviewer': '', 'owner': 'Sam Roe'})
        self.assertEqual(kbpaths.reviewer(self.root), 'Sam Roe')
        self.assertIn('proposals waiting for Sam Roe', self.pending_file())
        self.p.write_kit(project={'reviewer': '', 'owner': ''})
        self.assertEqual(kbpaths.reviewer(self.root), 'the reviewer')
        self.assertIn('proposals waiting for the reviewer', self.pending_file())

    def test_an_unknown_ui_language_falls_back_to_english(self):
        self.p.write_kit(project={'ui_lang': 'fr'})
        self.assertEqual(kbpaths.ui_lang(self.root), 'fr')
        self.assertIn('No proposal is waiting.', self.pending_file())

    def test_the_default_language_is_english(self):
        self.assertEqual(kbpaths.ui_lang(self.root), 'en')

    def test_the_review_command_names_the_reviewer_in_its_next_step(self):
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            self.skipTest('openpyxl not installed')
        out = self.root / 'review.xlsx'
        kb.review_export(self.root, out)
        book = openpyxl.load_workbook(out)
        sheet = book['Records']
        header = [c.value for c in sheet[1]]
        for row in sheet.iter_rows(min_row=2):
            if row[header.index('ID')].value == 'D3':
                row[header.index('Decision')].value = 'Remove'
        book.save(out)
        result = kb.review_import(self.root, out)
        self.assertIn('After Alex Doe says OK in chat', result['next'])
        self.assertIn('--approve-as "Alex Doe"', result['next'])


if __name__ == '__main__':
    unittest.main()
