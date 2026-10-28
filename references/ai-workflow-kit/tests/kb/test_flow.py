"""Flow commands: trace, file, coverage, test review import, contested, cited code paths, pending proposals."""

import unittest

from . import project
from .project import ProjectCase, flow, kb, store

DEC, REQ, TESTS, LESSONS, MODULES = ('tracker-decisions', 'tracker-requirements', 'tracker-tests',
                                     'tracker-lessons', 'tracker-modules')


class FlowTests(ProjectCase):
    GROUPS = (DEC, REQ, MODULES, LESSONS, TESTS)
    STORES = (DEC, TESTS)

    def add_test(self, req, level, result):
        p = kb.test_add(self.root, req, level, 'cmd', 'out', result, 'b1', 'fixture', 'ai')
        store.review(kb, self.root, p['proposal'], 'approved', 'human', 'ok', group=TESTS)
        store.apply(kb, self.root, p['proposal'], 'ai', group=TESTS)

    # ------------------------------------------------------------ trace and file

    def test_trace_follows_links_both_ways(self):
        t = kb.trace(self.root, 'REQ-SCAN-001')
        self.assertEqual(t['id'], 'REQ-SCAN-001')
        self.assertIn('MOD-scanner', [x['id'] for x in t['linked_from']])
        self.assertIn('REQ-SCAN-002', [x['id'] for x in t['linked_from']])
        out = kb.trace(self.root, 'MOD-router-lib')
        self.assertIn('D5', [x['id'] for x in out['links_to']])
        with self.assertRaisesRegex(kb.KBError, 'ID not found'):
            kb.trace(self.root, 'NOPE-1')

    def test_file_finds_records_naming_a_path(self):
        app = '/x/parcel-app/src/drv/scanner.py'
        self.assertEqual([r['id'] for r in kb.file_records(self.root, app)['records']], ['MOD-scanner'])
        router = 'C:\\x\\parcel-app\\src\\route\\router.py'
        self.assertEqual([r['id'] for r in kb.file_records(self.root, router)['records']], ['MOD-router-lib'])
        labels = '/x/parcel-labels/vendor/labels/label_cache.json'
        self.assertEqual([r['id'] for r in kb.file_records(self.root, labels)['records']], ['LES-001'])
        self.assertEqual(kb.file_records(self.root, '/x/src/drv/scanner.h')['records'], [])
        # A one-level folder (`docs/`) names half the project; it is not a file reference.
        self.assertEqual(list(flow.path_tokens('`docs/` `src/route/` `MEMORY.md` `x`')), ['src/route/', 'MEMORY.md'])
        self.assertEqual(kb.file_records(self.root, '/x/other/src/routex/a.py')['records'], [])

    # ------------------------------------------------------------ coverage

    def test_coverage_by_required_level(self):
        self.add_test('REQ-SCAN-001', 'L3', 'pass')
        self.add_test('REQ-SCAN-002', 'L1', 'pass')
        c = kb.coverage(self.root, REQ)
        self.assertEqual(c['met'], ['REQ-SCAN-001'])
        self.assertEqual(c['partial'], ['REQ-SCAN-002'])  # Needs L3, has L1.
        self.assertEqual(c['blocked'], ['REQ-ROUTE-001'])
        self.assertEqual(c['none'], [])
        self.assertEqual(c['no_source'], [])

    def test_coverage_counts_a_test_review_and_flags_missing_source(self):
        self.write('docs/requirements.md',
                   project.REQUIREMENTS_MD.replace('| Plan 3.1 | L3 | Draft |', '| — | L3 | Draft |'))
        kb.import_source(self.root, REQ)
        kb.test_import_review(self.root, 'docs/review-1.md', 'tracker-review-1', 'fixture', id_prefix='R1-')
        self.assertEqual(kb.get(self.root, 'R1-TC-1.1')['status'], 'pass')
        c = kb.coverage(self.root, REQ)
        self.assertEqual(c['met'], ['REQ-SCAN-001'])
        self.assertIn('REQ-SCAN-002', c['partial'])  # A failed test is not met.
        self.assertEqual(c['no_source'], ['REQ-SCAN-001'])

    def test_review_import_refuses_store_with_prefix_and_bad_input(self):
        kb.test_import_review(self.root, 'docs/review-1.md', 'tracker-review-1', 'fixture', id_prefix='R1-')
        with self.assertRaises(store.StoreError):
            store.transfer(kb, self.root, 'human', 'no', group='tracker-review-1')
        self.write('docs/empty.md', '# x\n')
        with self.assertRaisesRegex(kb.KBError, 'no rows matching'):
            kb.test_import_review(self.root, 'docs/empty.md', 'tracker-review-2', 'fixture')

    # ------------------------------------------------------------ contested and code paths

    def test_contested_lists_what_is_still_open(self):
        p = kb.test_add(self.root, 'REQ-SCAN-001', 'L0', 'make', 'ok', 'pass', 'b1', 'fixture', 'ai')
        c = kb.contested(self.root)
        self.assertIn('D5', [r['id'] for r in c['open_decisions']])
        self.assertEqual([r['id'] for r in c['blocked']], ['REQ-ROUTE-001'])
        self.assertEqual([(x['group'], x['proposal']) for x in c['pending_proposals']], [(TESTS, p['proposal'])])
        self.assertEqual(c['unavailable_groups'], [])
        self.assertEqual(c['coverage'][REQ]['none'], 2)
        self.write('docs/lessons.md', project.LESSONS_MD.replace('Rebuild', 'Changed'))
        self.assertEqual([u['group'] for u in kb.contested(self.root)['unavailable_groups']], [LESSONS])

    def test_code_paths_ok_moved_gone_unverifiable(self):
        app, lib = self.root / 'repo-app', self.root / 'repo-lib'
        self.write('repo-app/src/route/router.py', 'x')
        self.write('repo-app/src/scan/scanner.py', 'x')  # Moved from src/drv/.
        self.write('repo-lib/vendor/other/readme.md', 'x')  # vendor/labels/ is gone.
        self.write('docs/modules.md', project.MODULES_MD.replace('| new |', '| `libs/geo/index` |'))
        kb.import_source(self.root, MODULES)
        result = kb.code_paths(self.root, repos=[app, lib])
        status = {(x['id'], x['path']): x['status'] for x in result['paths']}
        self.assertEqual(status[('MOD-router-lib', 'src/route/')], 'OK')
        self.assertEqual(status[('MOD-scanner', 'src/drv/scanner.py')], 'MOVED')
        self.assertEqual(status[('LES-001', 'vendor/labels/')], 'GONE')
        self.assertEqual(status[('MOD-scanner', 'libs/geo/index')], 'UNVERIFIABLE')
        self.assertEqual(status[('LES-001', 'label_cache.json')], 'UNVERIFIABLE')  # A bare name found nowhere.
        moved = next(x for x in result['paths'] if x['status'] == 'MOVED')
        self.assertEqual(moved['candidates'], ['repo-app/src/scan/scanner.py'])
        self.assertFalse(result['ok'])
        self.assertEqual(result['counts'], {'OK': 1, 'MOVED': 1, 'GONE': 1, 'UNVERIFIABLE': 2})

    def test_code_paths_accept_a_repo_prefixed_path(self):
        # A record may cite a path from the project root (`repo-app/...`): still OK.
        app = self.root / 'repo-app'
        self.write('repo-app/src/route/router.py', 'x')
        self.write('docs/modules.md', project.MODULES_MD.replace(
            '| new |', '| `repo-app/src/route/router.py`, `repo-app/src/` |'))
        kb.import_source(self.root, MODULES)
        status = {(x['id'], x['path']): x['status'] for x in kb.code_paths(self.root, repos=[app])['paths']}
        self.assertEqual(status[('MOD-scanner', 'repo-app/src/route/router.py')], 'OK')
        self.assertEqual(status[('MOD-scanner', 'repo-app/src/')], 'OK')

    # ------------------------------------------------------------ lessons must name a path

    def lessons_to_store(self):
        store.transfer(kb, self.root, 'human', 'fixture', group=LESSONS)

    def test_les_proposal_must_name_a_path(self):
        # A lesson the edit hook cannot find is lost: `Applies to` needs a backticked file or folder.
        self.lessons_to_store()
        with self.assertRaisesRegex(store.StoreError, 'Applies to'):
            store.propose(kb, self.root, 'add', 'LES-002', 'Lessons', '| LES-002 | label cache / headers | x | e | Active |',
                          'r', 'ai', group=LESSONS)
        ok = '| LES-002 | `vendor/labels/api.json` | x | e | Active |'
        p = store.propose(kb, self.root, 'add', 'LES-002', 'Lessons', ok, 'r', 'ai', group=LESSONS)
        self.assertEqual(p['review'], 'pending')
        with self.assertRaisesRegex(store.StoreError, 'Applies to'):
            store.propose(kb, self.root, 'edit', 'LES-001', None,
                          '| LES-001 | label cache | Rebuild. | hash | Active |', 'r', 'ai', group=LESSONS)

    def test_apply_refuses_a_pathless_les_proposed_before_the_check(self):
        self.lessons_to_store()
        cfg = kb.load_config(self.root, LESSONS)
        path, events, _ = store.load(kb, self.root, cfg)
        after = '| LES-002 | label facade | x | e | Active |\n'
        store.append(kb, path, events, 'propose', cfg, op='add', id='LES-002', section='Lessons', before='',
                     after=after, reason='old', actor='ai')
        n = len(events) + 1
        store.review(kb, self.root, n, 'approved', 'human', 'ok', group=LESSONS)
        with self.assertRaisesRegex(store.StoreError, 'Applies to'):
            store.apply(kb, self.root, n, 'ai', group=LESSONS)

    # ------------------------------------------------------------ pending proposals

    def test_store_pending_lists_what_waits(self):
        p = kb.test_add(self.root, 'REQ-SCAN-001', 'L0', 'make', 'ok', 'pass', 'b1', 'fixture', 'ai')
        out = self.root / 'review/pending.md'
        result = store.pending(kb, self.root, out=out)
        self.assertEqual([(x['group'], x['proposal'], x['id']) for x in result['pending']],
                         [(TESTS, p['proposal'], 'TST-001')])
        self.assertEqual(result['approved_not_applied'], [])
        text = out.read_text(encoding='utf-8')
        self.assertIn(f'#{p["proposal"]}', text)
        self.assertIn('| TST-001 | REQ-SCAN-001 | L0 |', text)
        store.review(kb, self.root, p['proposal'], 'approved', 'human', 'ok', group=TESTS)
        result = store.pending(kb, self.root)
        self.assertEqual(result['pending'], [])
        self.assertEqual([x['id'] for x in result['approved_not_applied']], ['TST-001'])
        store.apply(kb, self.root, p['proposal'], 'ai', group=TESTS)
        self.assertEqual(store.pending(kb, self.root, group=TESTS)['approved_not_applied'], [])

    # ------------------------------------------------------------ the command line

    def test_cli_commands(self):
        self.assertEqual(self.cli('trace', 'REQ-SCAN-001')[0], 0)
        code, out = self.cli('file', '/x/src/drv/scanner.py')
        self.assertEqual((code, [r['id'] for r in out['records']]), (0, ['MOD-scanner']))
        code, out = self.cli('coverage', '--group', REQ)
        self.assertEqual((code, out['none']), (0, ['REQ-SCAN-001', 'REQ-SCAN-002']))
        code, out = self.cli('coverage')  # The group comes from kit.json kb.tests.req_group.
        self.assertEqual((code, out['group']), (0, REQ))
        code, out = self.cli('contested')
        self.assertEqual(code, 0, out)
        self.assertIn('D5', [r['id'] for r in out['open_decisions']])


if __name__ == '__main__':
    unittest.main()
