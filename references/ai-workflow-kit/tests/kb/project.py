"""A throw-away "parcel tracker" project for the KB engine tests.

`Project` builds a folder in the system temp directory: a `kit.json`, small source documents (Markdown,
a Python table, and a `.docx` and an `.xlsx` made with `zipfile` and XML only) and a `kb.json` with one
group of every parser. Nothing outside that folder is read or written.

Groups (name -> parser, scope, mode after setup):

    tracker-decisions     decision-table   tracker  store      D1-D4 decided, F1-F6 responses, D5 open
    ops-decisions         decision-table   ops      read-only  D101-D104 decided, D105 open (default id_pattern)
    tracker-requirements  id-table         tracker  store      REQ rows (status column, levels)
    tracker-review-1      id-table         tracker  read-only  test review rows, ids prefixed `R1-`
    tracker-tests         id-table         tracker  store      empty test log (TST rows come from `test add`)
    tracker-modules       id-table         tracker  read-only  MOD rows naming code paths
    tracker-lessons       id-table         tracker  read-only  LES rows naming code paths
    ops-exceptions        md-table         ops      read-only
    ops-rules             md-bullet-id     ops      read-only
    ops-carriers          py-literal       ops      read-only
    ops-spec              docx-field-table ops      read-only
    ops-backlog           xlsx-table       ops      read-only

Which of these a test gets is its choice: `Project(groups=[...], stores=[...])`. `stores` lists the groups
that are moved into the KB store (`store transfer`) during setup.
"""

import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

KIT_ROOT = Path(__file__).resolve().parents[2]
ENGINE = KIT_ROOT / 'engine'
KB_PY = ENGINE / 'kb' / 'kb.py'
# The KB modules import each other by bare name (`import store`), so this folder goes first.
for _folder in (str(ENGINE), str(ENGINE / 'kb')):
    if _folder in sys.path:
        sys.path.remove(_folder)
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / 'kb'))

import kb  # noqa: E402
import kbpaths  # noqa: E402
import store  # noqa: E402
import flow  # noqa: E402
import config as kitconfig  # noqa: E402

REVIEWER = 'alex'
AI = 'ai'

# ---------------------------------------------------------------- source documents

DECISIONS_MD = '''# Tracker decisions

Synthetic data for isolated KB tests. This file is not project authority.

## Decided

| # | Topic | Decision | Reason |
| --- | --- | --- | --- |
| D1 | Scanner | Fixture decision one | Fixture rationale |
| D2 | Labels | Fixture decision two | Fixture rationale |
| D3 | Depots | Fixture decision three | Fixture rationale |
| D4 | Routing log | Minimal log fixture | Fixture rationale |

## Responses

| # | Customer asked | Reply |
| --- | --- | --- |
| F1 | Delivery window | Fixture response one |
| F2 | Pickup point | Fixture response two |
| F3 | Notification mail | Fixture response three |
| F4 | Dashboard | Fixture response four |
| F5 | Late parcels | See B1 outside this fixture |
| F6 | Tracking page | Fixture response six |

## Open

| # | Topic | Task |
| --- | --- | --- |
| D5 | Courier integration | Compare fixture integration choices |
'''
DECISION_IDS = [f'D{n}' for n in range(1, 6)] + [f'F{n}' for n in range(1, 7)]

OPS_DECISIONS_MD = '''# Operations decisions

Synthetic data. A second read-only decision table in another scope.

## Decided

| # | Topic | Decision | Reason |
| --- | --- | --- | --- |
| D101 | Shifts | Two shifts | Fixture rationale |
| D102 | Trucks | Leased trucks | Fixture rationale |
| D103 | Gates | Gate B opens first | Fixture rationale |
| D104 | Dock log | Minimal dock log fixture | See D101 |

## Open

| # | Topic | Task |
| --- | --- | --- |
| D105 | Night cover | Compare fixture night options |
'''
OPS_DECISION_IDS = [f'D{n}' for n in range(101, 106)]

REQUIREMENTS_MD = '''# Internal requirements — fixture

> Draft.

## SCAN — Scanning

| ID | Requirement | Source | Level | Status |
| --- | --- | --- | --- | --- |
| REQ-SCAN-001 | Read the barcode on every parcel. | Plan 3.1 | L3 | Draft |
| REQ-SCAN-002 | Read two parcels at once; see REQ-SCAN-001. | Plan 3.1 | L3 | Approved |

## ROUTE — Routing

| ID | Requirement | Source | Level | Status |
| --- | --- | --- | --- | --- |
| REQ-ROUTE-001 | Same route as the depot plan. | Plan Goal 4 | L2 | Blocked |
'''
REQUIREMENT_IDS = ['REQ-SCAN-001', 'REQ-SCAN-002', 'REQ-ROUTE-001']

TESTS_MD = '''# Test log — fixture

> Export of the store.

## Checks

| ID | REQ | Level | Date | Build | Command | Output | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
'''

MODULES_MD = '''# Module map — fixture

## Modules

| ID | Module | App location | Service location | Status |
| --- | --- | --- | --- | --- |
| MOD-scanner | Scanner, see REQ-SCAN-001 | `src/drv/scanner.py` | new | Approved |
| MOD-router-lib | Router library | `src/route/` | depends on D5 | Approved |
'''
MODULE_IDS = ['MOD-scanner', 'MOD-router-lib']

LESSONS_MD = '''# Lessons — fixture

## Lessons

| ID | Applies to | Lesson | Evidence | Status |
| --- | --- | --- | --- | --- |
| LES-001 | `vendor/labels/` | Rebuild the label cache; `label_cache.json` is not fixed. | hash strings | Active |
'''

REVIEW_MD = '''# Parcel Tracker — Test Data Review (fixture)

## 2. TC-1 — Scanning level

| ID | Condition | Run used | REQ | Result |
| --- | --- | --- | --- | --- |
| TC-1.1 | Barcode against manifest | `run1` | REQ-SCAN-001 | Pass |
| TC-1.2 | Damaged label | `run2` | REQ-SCAN-002 | Fail |
'''

NOTES_MD = '''# Change notes

## 3. Delivery Exceptions

`exception_code` carries one of these causes:

| Code | Cause |
| ---- | ----- |
| 1 | address not found |
| 2 | damaged, see 1 |

## 5. Fields

| Offset | Name |
|---|---|
| 69 | `weight_limit` |
'''

RULES_MD = '''# RULES

> **R0 — Read all.** Every line.
> Second line of R0.

## Meta

- **R11** — **Never edit** without OK.
  Continuation of R11, see R1.
  - Sub bullet of R11.
- **R1** — Address the user.

- **R2** (2026-09-21) — Clear.
Plain paragraph after R2.
'''

CARRIERS_PY = '''"""GENERATED - do not edit."""

META = {'schema_version': 1, 'rule': 'clamped'}

CARRIERS = [
    {
        'carrier': 'road_standard',
        'rate_per_kg': 0.048,
        'max_kg': 25.0,
    },
    {'carrier': 'air_express', 'rate_per_kg': 0.20242, 'max_kg': 6.0},
]
'''


# ---------------------------------------------------------------- tiny DOCX and XLSX writers

def para(text, style=None):
    ppr = (f'<w:pPr><w:pStyle w:val="{style}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'
           if style else '')
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def table(rows):
    return '<w:tbl>' + ''.join(
        '<w:tr>' + ''.join('<w:tc>' + ''.join(para(x) for x in cell.split('\n')) + '</w:tc>' for cell in row)
        + '</w:tr>' for row in rows) + '</w:tbl>'


def docx_bytes(body):
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:body>{body}</w:body></w:document>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('[Content_Types].xml',
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr('word/document.xml', xml)
    return out.getvalue()


FUN_1 = [['Field', 'Details'], ['', ''], ['ID', 'SPEC-FUN-SCAN-001'], ['Title', 'Scan feedback'],
         ['Priority', 'High'], ['Dependencies', '- Preceding: SPEC-FUN-SCAN-002\n- Logging'],
         ['Status', 'Active']]
TEMPLATE = [['Field', 'Details'], ['ID', 'SPEC-FUN-[AREA]-[###] (e.g., SPEC-FUN-SCAN-001)'],
            ['Title', 'Short name']]
NFR_1 = [['Field', 'Description'], ['ID', 'SPEC-NFR-CMN-001'], ['Title', 'Response time'],
         ['Purpose', 'Respond within 200 ms.']]


def spec_body(extra=''):
    return (para('Detailed Functional Requirements', 'Heading1') + table(TEMPLATE)
            + para('Stage01-Scanning', 'Heading2') + para('Scan feedback', 'Heading4') + table(FUN_1)
            + table([['#', 'Document Title'], ['1', 'Plan']])
            + para('Non-Functional Requirements', 'Heading1') + para('Performance', 'Heading2')
            + table(NFR_1) + extra)


def xlsx_bytes(sheets, shared_first=True):
    """A minimal workbook. Text in the first column is a shared string, other text is inline, numbers stay
    numbers, None is a styled empty cell (as openpyxl writes it). The shared string `B-02` is rich text with
    a phonetic run that must not be read."""
    main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    shared, out = [], io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        sheet_list, rels = [], []
        for n, (name, rows) in enumerate(sheets.items(), 1):
            sheet_list.append(f'<sheet name="{escape(name)}" sheetId="{n}" r:id="rId{n}"/>')
            rels.append(f'<Relationship Id="rId{n}" Type="{rel}/worksheet" Target="worksheets/sheet{n}.xml"/>')
            xml_rows = []
            for r, row in enumerate(rows, 1):
                cells = []
                for c, value in enumerate(row):
                    ref = f'{chr(65 + c)}{r}'
                    if value is None:
                        cells.append(f'<c r="{ref}" s="4" t="inlineStr"/>')
                    elif isinstance(value, (int, float)):
                        cells.append(f'<c r="{ref}"><v>{value}</v></c>')
                    elif c == 0 and shared_first:
                        shared.append(value)
                        cells.append(f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
                xml_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
            z.writestr(f'xl/worksheets/sheet{n}.xml',
                       f'<worksheet xmlns="{main}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{main}" xmlns:r="{rel}"><sheets>{"".join(sheet_list)}'
                                      '</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels',
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + ''.join(rels) + '</Relationships>')
        items = ''.join(f'<si><t>{escape(s)}</t></si>' if s != 'B-02' else
                        '<si><r><t>B-</t></r><r><t>02</t></r><rPh><t>x</t></rPh></si>' for s in shared)
        z.writestr('xl/sharedStrings.xml', f'<sst xmlns="{main}">{items}</sst>')
    return out.getvalue()


# Columns G-H hold a side table (status counts) on the same header row, after an empty column F.
BACKLOG_ROWS = [['Parcel Tracker - Backlog'], [],
                ['ID', 'Item', 'Status', 'Remaining', 'Priority', None, 'Status', 'Count'],
                ['B-01', 'Scanner set-up', 'Closed', '-', None, None, 'Open', 1],
                ['', 'Section note without an ID', None, None, None, None, 'Done', 2],
                ['B-02', 'Late-parcel accuracy', 'Partly closed', 'About 4% gap.\nSecond line', 2],
                ['Total', 'two items']]


# ---------------------------------------------------------------- group entries

def _entry(**fields):
    return {'mode': 'read-only', 'authority': 'original-source', **fields}


GROUPS = {
    'tracker-decisions': _entry(
        group='tracker-decisions', scope='tracker', parser='decision-table', source='docs/decisions.md',
        id_pattern=r'[DF]\d+', link_pattern=r'\b(?:[DFB]\d+)\b', expected_ids=DECISION_IDS),
    'ops-decisions': _entry(
        group='ops-decisions', scope='ops', parser='decision-table', source='docs/ops-decisions.md',
        expected_ids=OPS_DECISION_IDS),
    'tracker-requirements': _entry(
        group='tracker-requirements', scope='tracker', parser='id-table', source='docs/requirements.md',
        id_pattern=r'REQ-[A-Z]+-\d{3}(?:\.\d+)?', type='REQ', status='unknown', status_column='Status',
        approval_status='not-stated-in-source', expected_ids=REQUIREMENT_IDS),
    'tracker-review-1': _entry(
        group='tracker-review-1', scope='tracker', parser='id-table', source='docs/review-1.md',
        id_pattern=r'TC-\d+(?:\.\d+)*', id_prefix='R1-', type='TST', status='unknown', status_column='Result',
        approval_status='not-stated-in-source', expected_ids=['R1-TC-1.1', 'R1-TC-1.2']),
    'tracker-tests': _entry(
        group='tracker-tests', scope='tracker', parser='id-table', source='docs/tests.md',
        id_pattern=r'TST-\d{3}', type='TST', status='unknown', status_column='Result',
        approval_status='not-stated-in-source', expected_ids=[]),
    'tracker-modules': _entry(
        group='tracker-modules', scope='tracker', parser='id-table', source='docs/modules.md',
        id_pattern=r'MOD-[a-z0-9]+(?:-[a-z0-9]+)*', type='MOD', status='unknown', status_column='Status',
        approval_status='not-stated-in-source', expected_ids=MODULE_IDS),
    'tracker-lessons': _entry(
        group='tracker-lessons', scope='tracker', parser='id-table', source='docs/lessons.md',
        id_pattern=r'LES-\d{3}', type='LES', status='unknown', status_column='Status',
        approval_status='not-stated-in-source', expected_ids=['LES-001']),
    'ops-exceptions': _entry(
        group='ops-exceptions', scope='ops', parser='md-table', source='docs/notes.md',
        section='## 3. Delivery Exceptions', id_pattern=r'\d+', id_prefix='OPS-EXC-', type='CODE',
        status='as-built', approval_status='not-stated-in-source',
        expected_ids=['OPS-EXC-1', 'OPS-EXC-2']),
    'ops-rules': _entry(
        group='ops-rules', scope='ops', parser='md-bullet-id', source='docs/rules.md', id_pattern=r'R\d+',
        type='RULE', status='in-force', approval_status='source-reported-user-directive',
        expected_ids=['R0', 'R11', 'R1', 'R2']),
    'ops-carriers': _entry(
        group='ops-carriers', scope='ops', parser='py-literal', source='data/carriers.py', variable='CARRIERS',
        id_column='carrier', id_pattern='[a-z0-9]+(?:_[a-z0-9]+)*', id_prefix='CARRIER-', type='CONST',
        status='in-force', approval_status='not-stated-in-source',
        expected_ids=['CARRIER-road_standard', 'CARRIER-air_express']),
    'ops-spec': _entry(
        group='ops-spec', scope='ops', parser='docx-field-table', source='docs/spec.docx',
        id_pattern=r'SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*', type='REQ', status='unknown', status_field='Status',
        approval_status='not-stated-in-source', expected_ids=['SPEC-FUN-SCAN-001', 'SPEC-NFR-CMN-001']),
    'ops-backlog': _entry(
        group='ops-backlog', scope='ops', parser='xlsx-table', source='docs/backlog.xlsx', sheet='Backlog',
        id_column='ID', id_pattern=r'B-\d+', type='BKL', status='unknown', status_field='Status',
        title_field='Item', approval_status='not-stated-in-source', expected_ids=['B-01', 'B-02']),
}
ALL_GROUPS = tuple(GROUPS)


def entry(name, **extra):
    """A fresh copy of one catalogue group entry, with fields replaced."""
    return {**copy.deepcopy(GROUPS[name]), **extra}


def documents():
    """Every source document of the catalogue: relative path -> bytes."""
    text = {'docs/decisions.md': DECISIONS_MD, 'docs/ops-decisions.md': OPS_DECISIONS_MD,
            'docs/requirements.md': REQUIREMENTS_MD, 'docs/tests.md': TESTS_MD, 'docs/modules.md': MODULES_MD,
            'docs/lessons.md': LESSONS_MD, 'docs/review-1.md': REVIEW_MD, 'docs/notes.md': NOTES_MD,
            'docs/rules.md': RULES_MD, 'data/carriers.py': CARRIERS_PY}
    files = {rel: data.encode('utf-8') for rel, data in text.items()}
    files['docs/spec.docx'] = docx_bytes(spec_body())
    files['docs/backlog.xlsx'] = xlsx_bytes({'Summary': [['Sprint']], 'Backlog': BACKLOG_ROWS})
    return files


# ---------------------------------------------------------------- the project

def default_kit():
    return {'project': {'name': 'Parcel Tracker', 'owner': 'Alex Doe', 'reviewer': 'Alex Doe', 'ui_lang': 'en'},
            'people': {'default': 'alex-doe'},
            'kb': {'scopes': ['tracker', 'ops'],
                   'tests': {'group': 'tracker-tests', 'req_group': 'tracker-requirements',
                             'coverage_groups': ['tracker-requirements']}}}


def reset_caches(root=None):
    """Forget the cached kit.json and the loaded plugins (a test that rewrites kit.json calls this)."""
    kbpaths.forget(root)
    if root is None:
        kb._PLUGINS.clear()
    else:
        kb._PLUGINS.pop(str(Path(root).absolute()), None)


class Project:
    """The folder, its kb.json and the helpers to run the engine against it.

    `groups`: catalogue names in kb.json (all read-only at first); `stores`: the ones transferred to the KB
    store; `kit`: overrides merged over `default_kit()`; `kb_json=False` leaves kb.json out; `setup=False`
    writes the files and kb.json but imports and transfers nothing.
    """

    def __init__(self, groups=('tracker-decisions',), stores=(), kit=None, kb_json=True, setup=True):
        self._tmp = tempfile.TemporaryDirectory(prefix='kbt-')
        self.root = Path(self._tmp.name).resolve()
        self.groups = list(groups)
        self.kit = kitconfig.deep_merge(default_kit(), kit or {})
        self.write_kit()
        for rel, data in documents().items():
            self.write(rel, data)
        if kb_json:
            self.write_registry([entry(g) for g in self.groups])
            if setup:
                self.setup(stores)

    def close(self):
        reset_caches(self.root)
        self._tmp.cleanup()

    # --- files

    def path(self, rel):
        return self.root / rel

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)
        return path

    def read(self, rel):
        return (self.root / rel).read_text(encoding='utf-8')

    def write_kit(self, **overrides):
        """Rewrite kit.json: the project's kit with `overrides` merged over it (and remember them)."""
        self.kit = kitconfig.deep_merge(self.kit, overrides)
        self.write('kit.json', json.dumps(self.kit, indent=2) + '\n')
        reset_caches(self.root)

    @property
    def registry_path(self):
        return self.root / kbpaths.registry(self.root)

    def registry(self):
        return json.loads(self.registry_path.read_text(encoding='utf-8'))

    def write_registry(self, groups):
        kb.atomic_bytes(self.registry_path, kb.config_bytes({'schema_version': 2, 'groups': groups}))

    def cfg(self, group):
        return kb.load_config(self.root, group)

    def setup(self, stores=()):
        """Import every read-only group's verified copy; move the `stores` groups into the KB store."""
        for cfg in kb.load_groups(self.root):
            kb.atomic_bytes(kb.store_path(self.root, cfg), kb.encode_records(kb.extract(self.root, cfg)))
        for name in stores:
            store.transfer(kb, self.root, 'fixture-approver', 'Fixture transfer', group=name)
        kb.rebuild(self.root)

    # --- records

    def row(self, rid):
        return kb.get(self.root, rid)['text']

    def changed(self, rid, suffix=' Fixture change.'):
        """The record's table row with `suffix` added to its last cell."""
        return self.row(rid).rstrip('\r\n')[:-1] + suffix + '|'

    def journal(self, group=None):
        return store.journal(kb, self.root, kb.load_config(self.root, group))

    def propose(self, op='edit', rid='D4', section=None, text=None, group=None, reason='Fixture reason'):
        text = text if text is not None else self.changed(rid)
        return store.propose(kb, self.root, op, rid, section, text, reason, AI, group=group)['proposal']

    def approve(self, number, group=None, reviewer=REVIEWER):
        store.review(kb, self.root, number, 'approved', reviewer, 'Fixture OK', group=group)

    def approve_apply(self, number, group=None):
        self.approve(number, group)
        return store.apply(kb, self.root, number, AI, group=group)

    def apply_change(self, op, rid, section, text, group=None):
        return self.approve_apply(self.propose(op, rid, section, text, group=group), group)

    # --- the command line

    def cli(self, *args):
        return run_cli(self.root, *args)

    def inproc(self, *args):
        return run_main(self.root, *args)


def run_cli(root, *args):
    """`python engine/kb/kb.py --root <root> args...` -> (exit code, parsed JSON of stdout)."""
    done = subprocess.run([sys.executable, str(KB_PY), '--root', str(root), *map(str, args)],
                          capture_output=True, encoding='utf-8')
    if not done.stdout.strip():
        raise AssertionError(f'no output from kb.py {args} (exit {done.returncode}): {done.stderr}')
    return done.returncode, json.loads(done.stdout)


def run_cli_raw(root, *args):
    """The same call, as the CompletedProcess (for argparse errors, which print no JSON)."""
    return subprocess.run([sys.executable, str(KB_PY), '--root', str(root), *map(str, args)],
                          capture_output=True, encoding='utf-8')


def run_main(root, *args):
    """`kb.main` in this process -> (exit code, parsed JSON). An argparse exit gives (code, None)."""
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = kb.main(['--root', str(root), *map(str, args)])
    except SystemExit as e:
        return e.code, None
    return code, json.loads(out.getvalue()) if out.getvalue().strip() else None


class ProjectCase(unittest.TestCase):
    """A test case with a fresh `Project` in `self.p` (and `self.root`). Class attributes choose it."""

    GROUPS = ('tracker-decisions',)
    STORES = ()
    KIT = None
    SETUP = True

    def setUp(self):
        self.p = Project(self.GROUPS, self.STORES, self.KIT, setup=self.SETUP)
        self.addCleanup(self.p.close)
        self.root = self.p.root

    # short names for the helpers used everywhere
    def write(self, rel, data):
        return self.p.write(rel, data)

    def cli(self, *args):
        return self.p.cli(*args)

    def row(self, rid):
        return self.p.row(rid)

    def snapshot(self, *rels):
        """{path: bytes} of files, to compare after a refused call."""
        return {self.root / r: (self.root / r).read_bytes() for r in rels}

    def assert_unchanged(self, before):
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data, str(path))
