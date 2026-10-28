"""Project KB: one derived index over independently owned, scoped groups.

Read-only mode: the original document is authoritative and the JSONL is a verified copy.
Store mode (after `store transfer`): the hash-chained store is authoritative and the
document is its export. Only decision-table and id-table groups can move to store mode.
Project settings (paths, scopes, extra types, test log, plugins) come from kit.json.
"""

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kbpaths  # noqa: E402

SCHEMA = 1
INDEX_SCHEMA = 2
# Decision tables: default ID pattern and section heading prefix -> record status and the approval
# the source itself states. A group overrides them with `id_pattern`, `sections` and `link_pattern`.
DECISION_ID = r'D\d+'
SECTIONS = [
    ('## Decided', 'decided', 'source-reported-decided'),
    ('## Open', 'open', 'not-approved'),
    ('## Responses', 'recorded-response', 'not-stated-in-source'),
]
MODES = {('read-only', 'original-source'), ('store', 'kb-store')}
PARSERS = ('decision-table', 'md-table', 'md-bullet-id', 'docx-field-table', 'xlsx-table', 'id-table', 'py-literal')
# Parsers whose groups can move to the KB store (`store transfer`).
STORE_PARSERS = ('decision-table', 'id-table')
# Built-in record types; kit.json `kb.extra_types` and plugins add more.
TYPES = ('DEC', 'REQ', 'RULE', 'DEV', 'CODE', 'BKL', 'TST', 'LES', 'MOD', 'CONST')
STATUSES =('decided', 'open', 'recorded-response', 'as-built', 'in-force', 'active', 'deprecated',
            'closed', 'partly-closed', 'new', 'done', 'partly-done', 'draft', 'approved', 'blocked',
            'pass', 'partial', 'fail', 'not-tested', 'unknown')
APPROVALS = ('source-reported-decided', 'not-approved', 'not-stated-in-source', 'approved-in-kb',
             'source-reported-user-directive', 'source-reported-approved')
# Validation results added to a group at read time; never written back to kb.json.
RUNTIME_KEYS = ('export_in_sync', 'pending_proposals', 'skipped_source_ids')
WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
CELL = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
DOC_REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
PKG_REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'


class KBError(Exception):
    pass


# ---------------------------------------------------------------- project settings and plugins

class PluginAPI:
    """What a plugin's `register(api)` may add: CLI commands, record types, hook callbacks."""

    def __init__(self, kb, root):
        self.kb, self.root = kb, root
        self.commands, self.types, self.hooks = {}, [], {}

    def command(self, name, help, args, run):
        """`args(subparser)` adds the options; `run(kb, root, args)` returns a JSON-able result."""
        if name in self.commands:
            raise KBError(f'Plugin command {name} is defined twice')
        self.commands[name] = (help, args, run)

    def add_types(self, *names):
        for n in names:
            if n not in self.types:
                self.types.append(n)

    def on(self, event, fn):
        """Hook callbacks: `post_bash(kb, root, command)` returns text for the model or None; see engine/hooks."""
        self.hooks.setdefault(event, []).append(fn)


_PLUGINS = {}


def plugins(root):
    """The PluginAPI after every plugin in kit.json `plugins` registered (loaded once per root)."""
    key = str(Path(root).absolute())
    if key not in _PLUGINS:
        api = PluginAPI(sys.modules[__name__], root)
        _PLUGINS[key] = api
        for n, rel in enumerate(kbpaths.kit(root).get('plugins') or []):
            path = inside(root, rel)
            if not path.is_file():
                raise KBError(f'Plugin not found: {rel}')
            sys.path.insert(0, str(path.parent))
            spec = importlib.util.spec_from_file_location(f'aikit_plugin_{n}_{path.stem}', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if not hasattr(module, 'register'):
                raise KBError(f'Plugin {rel} has no register(api)')
            module.register(api)
    return _PLUGINS[key]


def types(root):
    extra = list(kbpaths.kbcfg(root).get('extra_types') or [])
    return TYPES + tuple(dict.fromkeys(t for t in extra + plugins(root).types if t not in TYPES))


def hidden_types(root):
    """Types left out of search, trace and file unless asked for with --type (e.g. generated size rows)."""
    return set(kbpaths.kbcfg(root).get('hidden_types') or [])


def tests_cfg(root):
    """The test log (TST) settings; `group` None means the project keeps no test log."""
    base = {'group': None, 'req_group': None, 'id_prefix': 'TST-', 'levels': ['L0', 'L1', 'L2', 'L3'],
            'add_levels': None, 'review_level': None, 'section': 'Checks', 'coverage_groups': [],
            'columns': {'req': 'REQ', 'level': 'Level', 'source': 'Source'}}
    given = kbpaths.kbcfg(root).get('tests') or {}
    out = {**base, **given, 'columns': {**base['columns'], **(given.get('columns') or {})}}
    if out['add_levels'] is None:
        out['add_levels'] = [lv for lv in out['levels'] if lv != out['review_level']]
    return out


def sha(data):
    return hashlib.sha256(data).hexdigest()


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def inside(root, relative):
    # Check lexical containment: documents deliberately resolves through OneDrive.
    rel = Path(relative)
    if rel.is_absolute() or rel.drive or rel.root or '..' in rel.parts:
        raise KBError(f'Invalid workspace-relative path: {relative}')
    return root / rel


def config_path(root):
    path = root / kbpaths.registry(root)
    if not path.exists():
        raise KBError(f'No KB config: {kbpaths.registry(root)} does not exist')
    return path


def decision_rules(cfg):
    """(id regex, sections, link regex) of a decision-table group, with the defaults filled in."""
    name = cfg.get('group', '')
    pattern = cfg.get('id_pattern', DECISION_ID)
    sections = cfg.get('sections', SECTIONS)
    try:
        full = re.compile(pattern)
        links = re.compile(cfg.get('link_pattern') or r'\b(?:' + pattern + r')\b')
    except (TypeError, re.error) as e:
        raise KBError(f'Invalid id_pattern or link_pattern for {name}') from e
    if full.groups or links.groups:
        raise KBError(f'id_pattern and link_pattern for {name} must use (?:...) groups only')
    if (not isinstance(sections, (list, tuple)) or not sections
            or not all(isinstance(s, (list, tuple)) and len(s) == 3 and all(isinstance(x, str) and x for x in s)
                       and s[0].startswith('#') and s[1] in STATUSES and s[2] in APPROVALS for s in sections)):
        raise KBError(f'sections for {name}: a list of [heading prefix, status, approval_status]')
    return full, [tuple(s) for s in sections], links


def checked_group(root, cfg):
    if not isinstance(cfg, dict):
        raise KBError('Each KB group must be an object')
    if (cfg.get('mode'), cfg.get('authority')) not in MODES:
        raise KBError('Unsupported group mode/authority')
    if not isinstance(cfg.get('group'), str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', cfg['group']):
        raise KBError('Invalid group name')
    scopes = kbpaths.scopes(root)
    if cfg.get('scope') not in scopes:
        raise KBError(f'Invalid scope for {cfg["group"]}; choose from {", ".join(scopes)}')
    if cfg.get('parser') not in PARSERS:
        raise KBError(f'Unsupported parser for {cfg["group"]}')
    ids = cfg.get('expected_ids')
    if cfg['parser'] == 'decision-table':
        full = decision_rules(cfg)[0]
    else:
        if cfg['mode'] != 'read-only' and cfg['parser'] not in STORE_PARSERS:
            raise KBError(f'{cfg["group"]}: parser {cfg["parser"]} supports read-only groups only')
        full = checked_rules(root, cfg)
        if cfg['parser'] == 'id-table':
            # The store edits rows in place, so the document's own IDs must be the KB IDs.
            # A read-only copy may prefix IDs (two Test Reviews both have TC-1.1); a store may not.
            if cfg['mode'] == 'store' and (cfg.get('id_prefix') or cfg.get('deferred_ids')):
                raise KBError(f'{cfg["group"]}: an id-table store takes no id_prefix and no deferred_ids')
            if not isinstance(cfg.get('status_column', ''), str):
                raise KBError(f'Invalid status_column for {cfg["group"]}')
    # An id-table group may start empty: a test log or lesson list fills through `store propose`.
    if (not isinstance(ids, list) or (not ids and cfg['parser'] != 'id-table')
            or not all(isinstance(x, str) and full.fullmatch(x) for x in ids)
            or len(ids) != len(set(ids))):
        raise KBError('Invalid or duplicate expected IDs')
    for key in ('source', 'store' if cfg['mode'] == 'store' else 'source'):
        if not isinstance(cfg.get(key), str) or not cfg[key]:
            raise KBError(f'Missing {key} for {cfg["group"]}')
        inside(root, cfg[key])
    return cfg


def checked_rules(root, cfg):
    # Validate a read-only parser's settings; return the regex a KB ID must match in full.
    name = cfg['group']
    pattern = cfg.get('id_pattern')
    try:
        compiled = re.compile(pattern)
    except (TypeError, re.error) as e:
        raise KBError(f'Invalid id_pattern for {name}') from e
    if compiled.groups or not pattern:
        raise KBError(f'id_pattern for {name} must be nonempty and use (?:...) groups only')
    prefix = cfg.get('id_prefix', '')
    if not isinstance(prefix, str) or not re.fullmatch(r'(?:[A-Z][A-Z0-9]*-)*', prefix):
        raise KBError(f'Invalid id_prefix for {name}; use upper-case words ending in "-"')
    known = types(root)
    if cfg.get('type') not in known:
        raise KBError(f'Invalid type for {name}; choose from {", ".join(known)}')
    if cfg.get('status') not in STATUSES:
        raise KBError(f'Invalid status for {name}; choose from {", ".join(STATUSES)}')
    if cfg.get('approval_status') not in APPROVALS:
        raise KBError(f'Invalid approval_status for {name}; choose from {", ".join(APPROVALS)}')
    section = cfg.get('section')
    if cfg['parser'] == 'md-table' and not (isinstance(section, str) and re.match(r'#+ \S', section)):
        raise KBError(f'md-table group {name} needs the heading line of its table as section')
    for key in ('status_field', 'title_field', 'id_column'):
        if not isinstance(cfg.get(key, ''), str):
            raise KBError(f'Invalid {key} for {name}')
    if cfg['parser'] == 'xlsx-table' and not (isinstance(cfg.get('sheet'), str) and cfg['sheet'].strip()):
        raise KBError(f'xlsx-table group {name} needs the sheet name')
    if cfg['parser'] == 'py-literal' and not (isinstance(cfg.get('variable'), str) and cfg['variable'].isidentifier()
                                              and cfg.get('id_column')):
        raise KBError(f'py-literal group {name} needs variable (a Python name) and id_column (the dict key)')
    deferred = cfg.get('deferred_ids', {})
    if (not isinstance(deferred, dict)
            or not all(isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip()
                       for k, v in deferred.items())):
        raise KBError(f'deferred_ids for {name} maps each source ID to a nonempty reason')
    full = re.compile(re.escape(prefix) + '(?:' + pattern + ')')
    if any(prefix + k in (cfg.get('expected_ids') or []) for k in deferred):
        raise KBError(f'A deferred ID of {name} is also expected')
    return full


def link_regex(cfg):
    # Other records of the same kind named in the text; bare numbers are never links.
    full = re.escape(cfg.get('id_prefix', '')) + '(?:' + cfg['id_pattern'] + ')'
    if re.fullmatch(full, '1'):
        return None
    return re.compile(r'(?<![\w-])' + full + r'(?![\w-])')


def load_groups(root):
    path = config_path(root)
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise KBError('KB config must be an object')
    if data.get('schema_version') != 2 or not isinstance(data.get('groups'), list):
        raise KBError('kb.json requires schema_version 2 and a groups list')
    groups = data['groups']
    names, sources, journals = set(), set(), set()
    for cfg in groups:
        checked_group(root, cfg)
        if cfg['group'] in names:
            raise KBError(f'Duplicate group: {cfg["group"]}')
        names.add(cfg['group'])
        source = inside(root, cfg['source']).resolve()
        if source in sources:
            raise KBError('Groups must have separate source/export files')
        sources.add(source)
        if cfg['mode'] == 'store':
            journal = inside(root, cfg['store']).resolve()
            if journal in journals:
                raise KBError('Groups must have separate store journals')
            journals.add(journal)
    return groups


def select_group(groups, group=None):
    if group is not None:
        for cfg in groups:
            if cfg['group'] == group:
                return cfg
        raise KBError(f'Unknown group: {group}')
    if not groups:
        raise KBError('No KB groups configured yet; add one with add-group')
    if len(groups) != 1:
        raise KBError('Multiple groups; specify --group (' + ', '.join(c['group'] for c in groups) + ')')
    return groups[0]


def load_config(root, group=None):
    return select_group(load_groups(root), group)


def config_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def write_config(root, cfg):
    # Group transitions update just one entry; runtime validation fields are never persisted.
    clean = {k: v for k, v in cfg.items() if k not in RUNTIME_KEYS}
    groups = load_groups(root)
    select_group(groups, clean['group'])
    clean.pop('schema_version', None)
    checked_group(root, clean)
    groups = [clean if c['group'] == clean['group'] else c for c in groups]
    atomic_bytes(config_path(root), config_bytes({'schema_version': 2, 'groups': groups}))


def section_of(sections, heading):
    for prefix, status, approval in sections:
        if heading.startswith(prefix):
            return status, approval
    return None


def parse(text, source, source_sha, cfg, mode='read-only', authority='original-source'):
    # A decision table: rows `| <ID> |` under a `| # |` header, status from the section heading.
    # Line numbers count from the first line whether or not it carries a BOM.
    group = cfg.get('group', '')
    full, sections, link_ids = decision_rules(cfg)
    row_id = re.compile(r'^\|\s*(' + full.pattern + r')\s*\|')
    lines = text.lstrip('﻿').splitlines(keepends=True)
    records = []
    heading = ''
    table_header = ''
    table_columns = ''
    seen = set()
    for number, line in enumerate(lines, 1):
        if line.startswith('#'):
            heading = line.rstrip('\r\n')
            table_header = ''
            table_columns = ''
        if re.match(r'^\|\s*#\s*\|', line):
            table_header = line
            table_columns = lines[number] if number < len(lines) else ''
        match = row_id.match(line)
        if not match:
            continue
        rid = match.group(1)
        if rid in seen:
            raise KBError(f'Duplicate source ID: {rid}')
        seen.add(rid)
        if not table_header:
            raise KBError(f'Missing table header for {rid}')
        known = section_of(sections, heading)
        if not known:
            raise KBError(f'Unknown decision section for {rid}: {heading}')
        status, approval = known
        links = sorted(set(link_ids.findall(line)) - {rid})
        records.append({
            'schema_version': SCHEMA, 'id': rid, 'type': 'DEC',
            'group': group, 'mode': mode, 'authority': authority,
            'status': status, 'approval_status': approval, 'links': links,
            'source': source, 'source_sha256': source_sha,
            'source_line': number, 'section': heading,
            'table_header': table_header, 'table_separator': table_columns,
            'text': line,
        })
    return records


# ---------------------------------------------------------------- read-only parsers

def md_table_rows(text, cfg):
    # Every row of the first table under the configured heading; a row without an ID is an error.
    lines = text.lstrip('﻿').splitlines(keepends=True)
    section = cfg['section']
    start = next((i for i, line in enumerate(lines)
                  if line.startswith('#') and line.rstrip('\r\n').rstrip() == section), None)
    if start is None:
        raise KBError(f'Section not found: {section}')
    i = start + 1
    while i < len(lines) and not lines[i].startswith(('#', '|')):
        i += 1
    if i + 1 >= len(lines) or not lines[i].startswith('|') or not re.match(r'^\|[\s:|-]+$', lines[i + 1]):
        raise KBError(f'No table under section: {section}')
    row_id = re.compile(r'^\|\s*(?:\*\*)?(' + cfg['id_pattern'] + r')(?:\*\*)?\s*\|')
    rows = []
    for number in range(i + 3, len(lines) + 1):
        line = lines[number - 1]
        if not line.startswith('|'):
            break
        match = row_id.match(line)
        if not match:
            raise KBError(f'Unexpected row without an ID under {section} at line {number}')
        rows.append({'source_id': match.group(1), 'source_line': number,
                     'section': lines[start].rstrip('\r\n'), 'table_header': lines[i],
                     'table_separator': lines[i + 1], 'text': line})
    return rows


def md_bullet_items(text, cfg):
    # `- **R1** ...` or `> **R0 ...`, plus its indented (or quoted) continuation lines.
    lines = text.lstrip('﻿').splitlines(keepends=True)
    opener = re.compile(r'^(- |> )\*\*(' + cfg['id_pattern'] + r')(?![\w-])')
    items, heading, i = [], '', 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('#'):
            heading = line.rstrip('\r\n')
        match = opener.match(line)
        if not match:
            i += 1
            continue
        end = i + 1
        while end < len(lines):
            nxt = lines[end]
            quoted = match.group(1) == '> '
            if (not nxt.strip() or nxt.startswith('#') or opener.match(nxt)
                    or (quoted and not nxt.startswith('>')) or (not quoted and not nxt[0].isspace())):
                break
            end += 1
        items.append({'source_id': match.group(2), 'source_line': i + 1, 'source_end_line': end,
                      'section': heading, 'text': ''.join(lines[i:end])})
        i = end
    return items


def docx_body(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = ET.fromstring(z.read('word/document.xml'))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        raise KBError('Source is not a readable DOCX') from e
    body = root.find(WORD + 'body')
    if body is None:
        raise KBError('Source is not a readable DOCX')
    return body


def docx_blocks(element):
    # Paragraphs and tables in reading order; content controls are unwrapped.
    for child in element:
        if child.tag in (WORD + 'p', WORD + 'tbl'):
            yield child
        elif child.tag in (WORD + 'sdt', WORD + 'sdtContent', WORD + 'customXml'):
            yield from docx_blocks(child)


def run_text(element, out):
    # Accepted view: tracked insertions kept; deletions, field codes and paragraph tab stops dropped.
    for child in element:
        tag = child.tag
        if tag in (WORD + 'del', WORD + 'moveFrom', WORD + 'pPr', WORD + 'rPr', WORD + 'instrText'):
            continue
        if tag == WORD + 't':
            out.append(child.text or '')
        elif tag in (WORD + 'tab', WORD + 'ptab'):
            out.append('\t')
        elif tag in (WORD + 'br', WORD + 'cr'):
            out.append('\n')
        elif tag == WORD + 'noBreakHyphen':
            out.append('-')
        else:
            run_text(child, out)
    return out


def paragraph_text(p):
    return ''.join(run_text(p, []))


def heading_level(p):
    style = p.find(f'{WORD}pPr/{WORD}pStyle')
    match = re.fullmatch(r'(?i)heading\s*(\d)', style.get(WORD + 'val', '') if style is not None else '')
    return int(match.group(1)) if match else 0


def docx_field_tables(data, cfg):
    # Two-column tables whose header cell is `Field` and that carry an `ID` row: one record each.
    full = re.compile(cfg['id_pattern'])
    headings, items, skipped, number = {}, [], [], 0
    for block in docx_blocks(docx_body(data)):
        if block.tag == WORD + 'p':
            level = heading_level(block)
            title = paragraph_text(block).strip() if level else ''
            if title:
                headings = {k: v for k, v in headings.items() if k < level}
                headings[level] = title
            continue
        number += 1
        rows = [['\n'.join(paragraph_text(p) for p in tc.findall(WORD + 'p')).strip()
                 for tc in tr.findall(WORD + 'tc')] for tr in block.findall(WORD + 'tr')]
        if len(rows) < 2 or not rows[0] or rows[0][0] != 'Field':
            continue
        fields = [(row[0], row[1] if len(row) > 1 else '') for row in rows[1:] if any(row)]
        values = dict(fields)
        if 'ID' not in values:
            continue
        sid = next(v for k, v in fields if k == 'ID')
        if not full.fullmatch(sid):
            skipped.append({'table': number, 'id': sid})
            continue
        item = {'source_id': sid, 'source_locator': f'table {number}',
                'section': ' > '.join(headings[k] for k in sorted(headings)),
                'title': values.get(cfg.get('title_field', 'Title'), ''),
                'text': '\n'.join(f'{k}: {v}' for k, v in fields)}
        status = source_status(values.get(cfg.get('status_field', ''), ''))
        if status:
            item['status'] = status
        if any(el.tag in (WORD + 'ins', WORD + 'del', WORD + 'moveFrom', WORD + 'moveTo') for el in block.iter()):
            item['tracked_changes'] = True
        items.append(item)
    return items, skipped


def source_status(value):
    # `Partly closed` -> `partly-closed`; a value outside the known list keeps the group default.
    status = re.sub(r'\s+', '-', value.strip().lower())
    return status if status in STATUSES and status != 'unknown' else None


def xlsx_sheet_rows(data, name):
    # (row number, {column letters: text}) for one sheet; cached formula results, not formulas.
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            workbook = ET.fromstring(z.read('xl/workbook.xml'))
            rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
            shared = []
            if 'xl/sharedStrings.xml' in z.namelist():
                for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(CELL + 'si'):
                    # Plain or rich text; phonetic guides (rPh) are not part of the value.
                    parts = [si.find(CELL + 't')] + [r.find(CELL + 't') for r in si.findall(CELL + 'r')]
                    shared.append(''.join(t.text or '' for t in parts if t is not None))
            sheet = next((s for s in workbook.iter(CELL + 'sheet') if s.get('name') == name), None)
            if sheet is None:
                raise KBError(f'Sheet not found: {name}')
            target = next(r.get('Target') for r in rels.findall(PKG_REL + 'Relationship')
                          if r.get('Id') == sheet.get(DOC_REL + 'id'))
            root = ET.fromstring(z.read(target.lstrip('/') if target.startswith('/') else 'xl/' + target))
    except (zipfile.BadZipFile, KeyError, ET.ParseError, StopIteration, IndexError, ValueError) as e:
        raise KBError('Source is not a readable XLSX') from e
    rows = []
    try:
        for row in root.iter(CELL + 'row'):
            cells = {}
            for c in row.findall(CELL + 'c'):
                kind, v = c.get('t'), c.find(CELL + 'v')
                if kind == 's':
                    value = shared[int(v.text)]
                elif kind == 'inlineStr':  # An empty styled cell may carry no <is> at all.
                    value = ''.join(t.text or '' for t in c.iter(CELL + 't'))
                else:
                    value = v.text if v is not None and v.text else ''
                cells[re.match(r'[A-Z]+', c.get('r')).group()] = value.strip()
            rows.append((int(row.get('r')), cells))
    except (TypeError, AttributeError, ValueError, IndexError) as e:
        raise KBError('Source is not a readable XLSX: a cell or row has no usable reference') from e
    return rows


def column_order(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def xlsx_table_rows(data, cfg):
    # Rows below the first row that holds the ID column header: one record per row with an ID.
    full = re.compile(cfg['id_pattern'])
    sheet, id_header = cfg['sheet'], cfg.get('id_column', 'ID')
    rows = xlsx_sheet_rows(data, sheet)
    start = next((n for n, (_, cells) in enumerate(rows) if id_header in cells.values()), None)
    if start is None:
        raise KBError(f'No header row with {id_header} in sheet {sheet}')
    # The table is the run of adjacent header cells around the ID column; a gap ends it, so a
    # side table on the same header row (e.g. a status count) is not read into the records.
    header = {column_order(col): (col, text) for col, text in rows[start][1].items() if text}
    first = next(n for n, (_, text) in header.items() if text == id_header)
    left = first
    while left - 1 in header:
        left -= 1
    right = first
    while right + 1 in header:
        right += 1
    headers = [header[n] for n in range(left, right + 1)]
    names = [text for _, text in headers]
    if len(names) != len(set(names)):
        raise KBError(f'Repeated column header in sheet {sheet}: {names}')
    id_col = header[first][0]
    items, skipped, part = [], [], ''
    for number, cells in rows[start + 1:]:
        sid = cells.get(id_col, '')
        if not sid:
            # A row with text but no ID titles the rows below it (e.g. "Tool work in Sprint 9").
            label = ' '.join(cells[col] for col, _ in headers if cells.get(col))
            part = label or part
            continue
        if not full.fullmatch(sid):
            skipped.append({'row': number, 'id': sid})
            continue
        values = {text: cells.get(col, '') for col, text in headers}
        item = {'source_id': sid, 'source_locator': f'sheet {sheet} row {number}',
                'section': f'{sheet} > {part}' if part else sheet,
                'title': values.get(cfg.get('title_field', 'Title'), ''),
                'text': '\n'.join(f'{text}: {cells[col]}' for col, text in headers if cells.get(col))}
        status = source_status(values.get(cfg.get('status_field', ''), ''))
        if status:
            item['status'] = status
        items.append(item)
    return items, skipped


def py_literal_rows(text, cfg):
    # One record per dict in a module-level list, e.g. a generated condition table. Read with
    # ast.literal_eval, which accepts literals only: nothing in the source runs.
    name, key, full = cfg['variable'], cfg['id_column'], re.compile(cfg['id_pattern'])
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        raise KBError(f'Source is not readable Python: {e}') from e
    node = next((n for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)), None)
    if node is None:
        raise KBError(f'No module-level assignment to {name}')
    if not isinstance(node.value, (ast.List, ast.Tuple)):
        raise KBError(f'{name} is not a list')
    items, skipped = [], []
    for n, element in enumerate(node.value.elts):
        try:
            value = ast.literal_eval(element)
        except (ValueError, TypeError, SyntaxError, RecursionError) as e:
            raise KBError(f'{name}[{n}] is not a literal (line {element.lineno})') from e
        if not isinstance(value, dict) or not isinstance(value.get(key), (str, int)) or isinstance(value.get(key), bool):
            raise KBError(f'{name}[{n}] has no {key}')
        sid = str(value[key])
        if not full.fullmatch(sid):
            skipped.append({'line': element.lineno, 'id': sid})
            continue
        items.append({'source_id': sid, 'source_line': element.lineno, 'source_locator': f'{name}[{n}]',
                      'section': name, 'title': str(value.get(cfg.get('title_field', key), '')),
                      'text': '\n'.join(f'{k}: {v}' for k, v in value.items())})
    return items, skipped


def row_cells(line):
    # Cells of one Markdown table row; an escaped `\|` stays inside its cell.
    return [c.strip() for c in re.split(r'(?<!\\)\|', line.rstrip('\r\n').strip())[1:-1]]


def heading_text(line):
    return line.rstrip('\r\n').lstrip('﻿').lstrip('#').strip()


def id_table_rows(text, cfg):
    # Every body row of every table holding an ID row; a section is the heading above the table.
    lines = text.lstrip('﻿').splitlines(keepends=True)
    row_id = re.compile(r'^\|\s*(?:\*\*)?(' + cfg['id_pattern'] + r')(?:\*\*)?\s*\|')
    column = cfg.get('status_column', '')
    rows, heading, i = [], '', 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('#'):
            heading = line.rstrip('\r\n')
        if not (line.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+$', lines[i + 1])):
            i += 1
            continue
        header, separator, end = line, lines[i + 1], i + 2
        while end < len(lines) and lines[end].startswith('|'):
            end += 1
        body = range(i + 2, end)
        if any(row_id.match(lines[n]) for n in body):
            names = row_cells(header)
            for n in body:
                match = row_id.match(lines[n])
                if not match:
                    raise KBError(f'Unexpected row without an ID in the table under {heading} at line {n + 1}')
                item = {'source_id': match.group(1), 'source_line': n + 1, 'section': heading,
                        'table_header': header, 'table_separator': separator, 'text': lines[n]}
                cells = row_cells(lines[n])
                if column in names and len(cells) == len(names):
                    status = source_status(cells[names.index(column)])
                    if status:
                        item['status'] = status
                rows.append(item)
        i = end
    return rows


def parse_text(cfg, text, source='', source_sha='', mode='read-only', authority='original-source'):
    """Records of a Markdown group from its text; the store uses this for its own document."""
    if cfg['parser'] == 'decision-table':
        return parse(text, source, source_sha, cfg, mode=mode, authority=authority)
    return parse_source(cfg, text.lstrip('﻿').encode('utf-8'), source_sha, mode, authority, source)[0]


def section_line(cfg, lines, section):
    """Index of the heading a store `add`/`move` targets: a status name, or a heading's text."""
    if cfg['parser'] == 'decision-table':
        sections = decision_rules(cfg)[1]
        prefix = next((p for p, status, _ in sections if status == section), None)
        if not prefix:
            raise KBError('Section must be one of: ' + ', '.join(s for _, s, _ in sections))
        found = [i for i, line in enumerate(lines) if line.lstrip('﻿').startswith(prefix)]
    else:
        wanted = heading_text(section or '')
        found = [i for i, line in enumerate(lines) if line.lstrip('﻿').startswith('#')
                 and heading_text(line) == wanted]
        if not wanted or len(found) > 1:
            raise KBError(f'Section must name exactly one heading: {section}')
    if not found:
        raise KBError(f'Section not found: {section}')
    return found[0]


def in_section(cfg, record, section):
    if cfg['parser'] == 'decision-table':
        return record['status'] == section
    return heading_text(record['section']) == heading_text(section or '')


def store_id_ok(cfg, rid):
    pattern = decision_rules(cfg)[0].pattern if cfg['parser'] == 'decision-table' else cfg['id_pattern']
    return isinstance(rid, str) and re.fullmatch(pattern, rid) is not None


def parse_source(cfg, data, source_sha, mode='read-only', authority='original-source', source=None):
    """Return (records, notes) for the bytes of one group's source."""
    source = cfg['source'] if source is None else source
    if cfg['parser'] == 'decision-table':
        return parse(data.decode('utf-8-sig'), source, source_sha, cfg, mode=mode, authority=authority), {}
    skipped = []
    if cfg['parser'] == 'id-table':
        items = id_table_rows(data.decode('utf-8-sig'), cfg)
    elif cfg['parser'] == 'docx-field-table':
        items, skipped = docx_field_tables(data, cfg)
    elif cfg['parser'] == 'xlsx-table':
        items, skipped = xlsx_table_rows(data, cfg)
    elif cfg['parser'] == 'py-literal':
        items, skipped = py_literal_rows(data.decode('utf-8-sig'), cfg)
    elif cfg['parser'] == 'md-table':
        items = md_table_rows(data.decode('utf-8-sig'), cfg)
    else:
        items = md_bullet_items(data.decode('utf-8-sig'), cfg)
    deferred = cfg.get('deferred_ids', {})
    links = link_regex(cfg)
    records, seen = [], set()
    for item in items:
        sid = item['source_id']
        if sid in deferred:
            continue
        if sid in seen:
            raise KBError(f'Duplicate source ID: {sid}')
        seen.add(sid)
        rid = cfg.get('id_prefix', '') + sid
        records.append({
            'schema_version': SCHEMA, 'id': rid, 'type': cfg['type'], 'group': cfg['group'],
            'mode': mode, 'authority': authority,
            'status': item.pop('status', cfg['status']), 'approval_status': cfg['approval_status'],
            'links': sorted(set(links.findall(item['text'])) - {rid}) if links else [],
            'source': source, 'source_sha256': source_sha, **item})
    return records, {'deferred_ids': deferred, 'skipped_source_ids': skipped}


def parse_cached(root, cfg, data):
    """parse_source with a derived cache in .cache/parse, keyed by parser settings, source and code.

    The cache only saves parsing time (the SRS DOCX takes ~0.6 s); a damaged or altered entry is
    ignored and rewritten, and a changed source or tool gives a new key.
    """
    settings = {k: v for k, v in cfg.items() if k not in RUNTIME_KEYS and k != 'expected_ids'}
    key = sha(config_bytes({'cfg': settings, 'source': sha(data), 'code': sha(Path(__file__).read_bytes())}))
    folder = root / kbpaths.cache_dir(root) / 'parse'
    path = folder / f'{cfg["group"]}-{key[:16]}.json'
    try:
        entry = json.loads(path.read_text(encoding='utf-8'))
        body = {'key': key, 'records': entry['records'], 'notes': entry['notes']}
        if entry.get('check') == sha(config_bytes(body)):
            return entry['records'], entry['notes']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    records, notes = parse_source(cfg, data, sha(data))
    body = {'key': key, 'records': records, 'notes': notes}
    try:
        for old in folder.glob(f'{cfg["group"]}-*.json'):
            old.unlink(missing_ok=True)
        atomic_bytes(path, config_bytes({**body, 'check': sha(config_bytes(body))}))
    except OSError:
        pass  # A cache that cannot be written only costs time.
    return records, notes


TEXT_PARSERS = ('decision-table', 'md-table', 'md-bullet-id', 'id-table', 'py-literal')


def source_bytes(root, cfg):
    """A read-only group's source as the KB sees it. Text sources are read with LF line ends, so a
    Git autocrlf checkout (CRLF) is not a change; any change of content still is."""
    try:
        data = inside(root, cfg['source']).read_bytes()
    except OSError as e:
        raise KBError(f'Source unavailable: {cfg["source"]}') from e
    return data.replace(b'\r\n', b'\n') if cfg['parser'] in TEXT_PARSERS else data


def extract_with_notes(root, cfg):
    data = source_bytes(root, cfg)
    records, notes = parse_cached(root, cfg, data)
    seen = {r['id'] for r in records}
    expected = set(cfg['expected_ids'])
    if seen != expected:
        raise KBError(f'Source IDs changed; missing={sorted(expected-seen)}, '
                      f'unexpected={sorted(seen-expected)}. Review pilot scope first.')
    order = {rid: n for n, rid in enumerate(cfg['expected_ids'])}
    return sorted(records, key=lambda r: order[r['id']]), notes


def extract(root, cfg):
    return extract_with_notes(root, cfg)[0]


def store_path(root, cfg=None):
    cfg = cfg or load_config(root)
    return root / kbpaths.copies_dir(root) / f'{cfg["group"]}.jsonl'


def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def encode_records(records):
    return ''.join(json.dumps(r, ensure_ascii=False, sort_keys=True) + '\n'
                   for r in records).encode('utf-8')


def import_source(root, group=None):
    cfg = load_config(root, group)
    if cfg['mode'] == 'store':
        raise KBError('The KB store is authoritative; change decisions with `store propose`')
    atomic_bytes(store_path(root, cfg), encode_records(extract(root, cfg)))
    result = rebuild(root)
    result['authority'] = 'original-source'
    return result


def validated_group(root, cfg):
    if cfg['mode'] == 'store':
        import store
        return store.validated(sys.modules[__name__], root, cfg)
    path = store_path(root, cfg)
    if not path.exists():
        raise KBError('Pilot has not been imported; run import first')
    payload = path.read_bytes()
    try:
        records = [json.loads(line) for line in payload.decode('utf-8').splitlines() if line]
    except (ValueError, UnicodeError) as e:
        raise KBError('Pilot JSONL is invalid; re-import from the original source') from e
    current_hash = sha(source_bytes(root, cfg))
    # A changed source is STALE even when its ID set changed too; import then reports the IDs.
    if any(r.get('source_sha256') != current_hash for r in records):
        raise KBError('STALE: original source changed; review it and run import again')
    current, notes = extract_with_notes(root, cfg)
    if records != current:
        raise KBError('Pilot records differ from the original source; run import again')
    if notes.get('skipped_source_ids'):
        cfg = {**cfg, 'skipped_source_ids': notes['skipped_source_ids']}
    return cfg, records, sha(payload)


def group_error(group, e):
    # Name the group in the message and keep the exception type when it allows a plain message.
    try:
        return type(e)(f'{group}: {e}')
    except TypeError:
        return KBError(f'{group}: {e}')


def validated_records(root, strict=True):
    """Validate every group. Not strict: a failing group is reported as unavailable, not raised."""
    configs, records, fingerprints, owners = [], [], [], {}
    unavailable, errors = [], {}
    for cfg in load_groups(root):
        try:
            checked, rows, fingerprint = validated_group(root, cfg)
        except (KBError, ValueError) as e:
            error = group_error(cfg['group'], e)
            if strict:
                raise error from e
            unavailable.append({'group': cfg['group'], 'scope': cfg['scope'], 'error': str(error)})
            errors[cfg['group']] = error
            fingerprints.append({'unavailable': cfg['group']})
            continue
        for r in rows:
            if r['id'] in owners:
                raise KBError(f'Duplicate ID {r["id"]} in groups {owners[r["id"]]} and {cfg["group"]}')
            owners[r['id']] = cfg['group']
            records.append({**r, 'scope': cfg['scope']})
        configs.append(checked)
        fingerprints.append({'config': cfg, 'fingerprint': fingerprint})
    summary = {'groups': configs, 'unavailable': unavailable, 'errors': errors}
    if len(configs) == 1:
        summary.update(configs[0])
    return summary, records, sha(config_bytes(fingerprints))


def raise_unavailable(summary, entries=None):
    # One failing group keeps its own error type (a STALE or a broken journal); several are combined.
    entries = summary['unavailable'] if entries is None else entries
    if len(entries) == 1:
        raise summary['errors'][entries[0]['group']]
    raise KBError('KB groups unavailable: ' + '; '.join(u['error'] for u in entries))


def unavailable_note(entries):
    return {'unavailable_groups': entries,
            'warning': 'Some KB groups are unavailable; these results exclude them: '
                       + ', '.join(u['group'] for u in entries) + '. Run `lint` for the cause.'}


def db_path(root):
    return root / kbpaths.cache_dir(root) / 'kb.sqlite'


def rebuild(root):
    cfg, records, store_hash = validated_records(root, strict=False)
    if not cfg['groups'] and cfg['unavailable']:
        raise_unavailable(cfg)
    target = db_path(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, scratch = tempfile.mkstemp(prefix='kb-', suffix='.sqlite', dir=target.parent)
    os.close(fd)
    conn = None
    try:
        conn = sqlite3.connect(scratch)
        conn.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        conn.execute('CREATE TABLE records (id TEXT PRIMARY KEY, grp TEXT, scope TEXT, type TEXT, status TEXT, payload TEXT)')
        conn.execute('CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, text, tokenize="unicode61 remove_diacritics 2")')
        conn.executemany('INSERT INTO meta VALUES (?, ?)',
                         [('schema', str(INDEX_SCHEMA)), ('store_hash', store_hash)])
        for r in records:
            conn.execute('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)',
                         (r['id'], r['group'], r['scope'], r['type'], r['status'], json.dumps(r, ensure_ascii=False)))
            conn.execute('INSERT INTO fts VALUES (?, ?)',
                         (r['id'], r['section'] + '\n' + r['text']))
        conn.commit()
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        conn.close()
        conn = None
        # Reject a change during the build before publishing the derived index.
        if validated_records(root, strict=False)[2] != store_hash:
            raise KBError('KB groups changed during rebuild; retry')
        os.replace(scratch, target)
    finally:
        if conn is not None:
            conn.close()
        if os.path.exists(scratch):
            os.unlink(scratch)
    result = {'groups': [{'group': c['group'], 'scope': c['scope'], 'mode': c['mode']} for c in cfg['groups']],
              'records': len(records),
              'index': target.relative_to(root).as_posix(), 'integrity': 'ok'}
    if cfg['unavailable']:
        result.update(unavailable_note(cfg['unavailable']))
    return result


def open_index(root):
    cfg, expected, fingerprint = validated_records(root, strict=False)
    if not cfg['groups'] and cfg['unavailable']:
        raise_unavailable(cfg)
    target = db_path(root)
    ready = False
    if target.exists():
        c = None
        try:
            c = sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)
            meta = dict(c.execute('SELECT key, value FROM meta'))
            actual = c.execute('SELECT id, grp, scope, type, status, payload FROM records ORDER BY id').fetchall()
            wanted = sorted((r['id'], r['group'], r['scope'], r['type'], r['status'], json.dumps(r, ensure_ascii=False))
                            for r in expected)
            fts = c.execute('SELECT id, text FROM fts ORDER BY id').fetchall()
            wanted_fts = sorted((r['id'], r['section'] + '\n' + r['text']) for r in expected)
            ready = (meta.get('schema') == str(INDEX_SCHEMA)
                     and meta.get('store_hash') == fingerprint and actual == wanted
                     and fts == wanted_fts
                     and c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok')
        except sqlite3.Error:
            pass
        finally:
            if c is not None:
                c.close()
    if not ready:
        rebuild(root)
    return cfg, sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)


def citation(record):
    if record.get('source_locator'):
        return {**record, 'citation': f'{record["source"]}#{record["source_locator"].replace(" ", "-")}'}
    return {**record, 'citation': f'{record["source"]}:{record["source_line"]}'}


def drift_note(cfg):
    if cfg.get('export_in_sync', True):
        return {}
    return {'warning': 'EXPORT DRIFT: the document differs from the KB store; '
                       'this answer comes from the store. Run `store diff`.'}


def record_answer(record, configs):
    cfg = select_group(configs['groups'], record['group'])
    return {**citation(record), **drift_note(cfg)}


def get(root, rid):
    cfg, conn = open_index(root)
    try:
        result = conn.execute('SELECT payload FROM records WHERE id = ?', (rid,)).fetchone()
    finally:
        conn.close()
    if not result:
        if cfg['unavailable']:
            expected = {c['group']: c['expected_ids'] for c in load_groups(root)}
            owners = [u for u in cfg['unavailable'] if rid in expected.get(u['group'], [])]
            if owners:
                raise_unavailable(cfg, owners)
            raise KBError(f'ID not found in available KB groups: {rid}; unavailable: '
                          + '; '.join(u['error'] for u in cfg['unavailable']))
        raise KBError(f'ID not found in configured KB groups: {rid}')
    return record_answer(json.loads(result[0]), cfg)


def search(root, query, kind=None, status=None, limit=10, scope=None):
    # Treat user input as literal words, not FTS operators or SQL.
    words = re.findall(r'\w+', query, flags=re.UNICODE)
    if not words:
        raise KBError('Search needs at least one word')
    expression = ' AND '.join('"' + w + '"' for w in words)
    sql = ('SELECT r.payload FROM fts JOIN records r ON r.id=fts.id '
           'WHERE fts MATCH ?')
    args = [expression]
    if kind and kind not in types(root):
        raise KBError(f'Invalid type: {kind}')
    if status and status not in STATUSES:
        raise KBError(f'Invalid status: {status}')
    # Hidden types (e.g. many generated size rows per build) would crowd decisions out of a search;
    # they answer only when asked for with --type.
    hide = sorted(hidden_types(root)) if not kind else []
    marks = ','.join('?' * len(hide))
    if kind:
        sql += ' AND r.type=?'
        args.append(kind)
    elif hide:
        sql += f' AND r.type NOT IN ({marks})'
        args += hide
    if status:
        sql += ' AND r.status=?'
        args.append(status)
    if scope is not None:
        if scope not in kbpaths.scopes(root):
            raise KBError(f'Invalid scope: {scope}')
        sql += ' AND r.scope=?'
        args.append(scope)
    sql += ' ORDER BY bm25(fts), r.id LIMIT ?'
    args.append(limit)
    cfg, conn = open_index(root)
    missing = [u for u in cfg['unavailable'] if scope is None or u['scope'] == scope]
    if missing and not any(scope is None or c['scope'] == scope for c in cfg['groups']):
        conn.close()
        raise_unavailable(cfg, missing)  # Every group in the requested scope failed.
    try:
        rows = conn.execute(sql, args).fetchall()
        hidden = None
        if hide:
            count_sql = (sql.replace('SELECT r.payload', 'SELECT COUNT(*)', 1)
                         .replace(f' AND r.type NOT IN ({marks})', f' AND r.type IN ({marks})'))
            count_sql = count_sql.rsplit(' ORDER BY', 1)[0]
            hidden = conn.execute(count_sql, args[:-1]).fetchone()[0]
    finally:
        conn.close()
    results = [record_answer(json.loads(row[0]), cfg) for row in rows]
    if hidden:
        named = ', '.join(hide)
        extra = {'hidden_rows': hidden,
                 'hidden_note': f'{hidden} {named} rows also match; add --type {hide[0]} to see them'}
    else:
        extra = {}
    warning = {'warning': 'EXPORT DRIFT: see warnings on affected records'} if any('warning' in r for r in results) else {}
    if missing:
        note = unavailable_note(missing)
        warning = {**note, 'warning': ' '.join(filter(None, [warning.get('warning'), note['warning']]))}
    return {'query': query, 'scope': scope or 'all',
            'results': results,
            'empty_result_note': 'No hit is not proof of absence; retry source wording or inspect the owner file.'
            if not rows else None, **extra, **warning}


def lint(root, allow_drift=False, strict=True):
    cfg, records, _ = validated_records(root, strict=strict)
    ids = {r['id'] for r in records}
    groups = []
    for c in cfg['groups']:
        if not c.get('export_in_sync', True) and not allow_drift:
            raise KBError(f'{c["group"]}: EXPORT DRIFT: run `store diff --group {c["group"]}`')
        rows = [r for r in records if r['group'] == c['group']]
        summary = {'group': c['group'], 'scope': c['scope'], 'mode': c['mode'], 'authority': c['authority'],
                   'parser': c['parser'],
                   'records': len(rows), 'source_hash_verified': True, 'verbatim_rows_verified': True,
                   'external_links_not_in_pilot': sorted({link for r in rows for link in r['links']} - ids)}
        if c['mode'] == 'store':
            summary.update(export_in_sync=c['export_in_sync'], pending_proposals=c['pending_proposals'])
        if c['parser'] != 'decision-table':
            summary.update(deferred_ids=c.get('deferred_ids', {}),
                           skipped_source_ids=c.get('skipped_source_ids', []))
        groups.append(summary)
    result = {'ok': all(c.get('export_in_sync', True) for c in groups) and not cfg['unavailable'],
              'groups': groups, 'records': len(records),
              'pending_proposals': sum(c.get('pending_proposals', 0) for c in groups)}
    if cfg['unavailable']:
        result['unavailable_groups'] = cfg['unavailable']
    if len(groups) == 1:
        result.update(groups[0])
    return result


def take_snapshot(root, action, group, reason, config):
    taken = datetime.now(timezone.utc)
    snapshot = root / kbpaths.snapshots_dir(root) / f'config-{taken.strftime("%Y%m%dT%H%M%S%fZ")}'
    atomic_bytes(snapshot / 'kb.json', config)
    atomic_bytes(snapshot / 'manifest.json', config_bytes({
        'action': action, 'group': group, 'reason': reason, 'sha256': sha(config), 'taken': taken.isoformat()}))
    return snapshot


def add_group(root, entry, reason):
    """Add one read-only group: validate, snapshot kb.json, import its verified copy, rebuild."""
    import store
    store.nonempty(reason, 'Reason')
    if not isinstance(entry, dict):
        raise KBError('A group entry must be a JSON object')
    entry = {k: v for k, v in entry.items() if k not in RUNTIME_KEYS}
    if (entry.get('mode'), entry.get('authority')) != ('read-only', 'original-source') or 'store' in entry:
        raise KBError('add-group adds read-only groups only (mode read-only, authority original-source)')
    with store.locked(root):
        path = config_path(root)
        old = path.read_bytes()
        groups = load_groups(root)
        if any(g['group'] == entry.get('group') for g in groups):
            raise KBError(f'Group {entry["group"]} already exists')
        checked_group(root, entry)
        records = extract(root, entry)  # Readable source with exactly the expected IDs.
        snapshot = take_snapshot(root, 'add-group', entry['group'], reason, old)
        copy = store_path(root, entry)
        try:
            atomic_bytes(path, config_bytes({'schema_version': 2, 'groups': groups + [entry]}))
            load_groups(root)  # Separate source files across groups.
            atomic_bytes(copy, encode_records(records))
            validated_group(root, entry)
            result = rebuild(root)  # Fails on an ID that another group already owns.
        except BaseException:
            atomic_bytes(path, old)
            copy.unlink(missing_ok=True)
            raise
    return {**result, 'added': entry['group'], 'group_records': len(records),
            'snapshot': snapshot.relative_to(root).as_posix()}


def remove_group(root, group, reason):
    """Roll back one read-only group: snapshot kb.json and its copy, drop only that entry, rebuild."""
    import store
    store.nonempty(reason, 'Reason')
    with store.locked(root):
        path = config_path(root)
        groups = load_groups(root)
        cfg = select_group(groups, group)
        if cfg['mode'] != 'read-only':
            raise KBError(f'{group} is a store group; run `store rollback` before removing it')
        remaining = [g for g in groups if g['group'] != group]
        snapshot = take_snapshot(root, 'remove-group', group, reason, path.read_bytes())
        atomic_bytes(path, config_bytes({'schema_version': 2, 'groups': remaining}))
        copy = store_path(root, cfg)
        if copy.exists():
            os.replace(copy, snapshot / copy.name)
    return {**rebuild(root), 'removed': group, 'snapshot': snapshot.relative_to(root).as_posix()}


def trace(root, rid):
    import flow
    return flow.trace(sys.modules[__name__], root, rid)


def file_records(root, path):
    import flow
    return flow.file_records(sys.modules[__name__], root, path)


def coverage(root, group=None):
    import flow
    group = group or tests_cfg(root)['req_group']
    if not group:
        raise KBError('coverage needs --group, or kb.tests.req_group in kit.json')
    return flow.coverage(sys.modules[__name__], root, group)


def test_import_review(root, source, group, reason, id_prefix=''):
    """Add a test review document as a read-only TST group: one record per test-case row. The row ID
    pattern, the result column and the scope come from kit.json kb.tests (review_id_pattern,
    review_status_column, scope)."""
    tc = tests_cfg(root)
    scope = tc.get('scope') or kbpaths.scopes(root)[0]
    entry = {'group': group, 'scope': scope, 'mode': 'read-only', 'authority': 'original-source',
             'parser': 'id-table', 'source': source, 'id_pattern': tc.get('review_id_pattern') or r'TC-\d+(?:\.\d+)*',
             'type': 'TST', 'status': 'unknown', 'status_column': tc.get('review_status_column') or 'Result',
             'approval_status': 'not-stated-in-source'}
    if id_prefix:
        entry['id_prefix'] = id_prefix
    try:
        data = inside(root, source).read_bytes()
    except OSError as e:
        raise KBError(f'Source unavailable: {source}') from e
    ids = [r['id'] for r in parse_source({**entry, 'expected_ids': ['x']}, data, sha(data))[0]]
    if not ids:
        raise KBError(f'{source} has no rows matching {entry["id_pattern"]}')
    return add_group(root, {**entry, 'expected_ids': ids}, reason)


def contested(root):
    import flow
    return flow.contested(sys.modules[__name__], root)


def code_paths(root, repos=None):
    import flow
    return flow.code_paths(sys.modules[__name__], root, repos)


def review_export(root, out, groups=None):
    import review
    return review.export(sys.modules[__name__], root, out, groups)


def review_import(root, path, approve_as=None, reason=None):
    import review
    return review.import_(sys.modules[__name__], root, path, approve_as, reason)


TEST_RESULTS = ('pass', 'partial', 'fail')


def cell(value, name):
    # One table cell: a single line, pipes escaped.
    text = ' '.join(str(value or '').split())
    if not text:
        raise KBError(f'{name} must be nonempty')
    return text.replace('|', '\\|')


def test_add(root, req, level, cmd, output, result, build, reason, actor, group=None, date=None):
    """Propose one TST row (a check the AI ran) for the reviewer; levels and group from kit.json kb.tests."""
    import store
    tc = tests_cfg(root)
    group = group or tc['group']
    if not group:
        raise KBError('test add needs --group, or kb.tests.group in kit.json')
    if level not in tc['add_levels']:
        raise KBError(f'Level must be one of {", ".join(tc["add_levels"])}')
    if result not in TEST_RESULTS:
        raise KBError(f'result must be one of {", ".join(TEST_RESULTS)}')
    target = get(root, req) if req else None
    if not target or target['type'] != 'REQ':
        raise KBError(f'{req} is not a REQ record')
    cfg = select_group(load_groups(root), group)
    status = store.status(sys.modules[__name__], root, group)
    # IDs in the store now, plus IDs held by add proposals that are not applied yet.
    taken = ({r['id'] for r in validated_group(root, cfg)[1]}
             | {p['id'] for p in status['proposals'] if p['op'] == 'add'})
    prefix = tc['id_prefix']
    own = re.compile(re.escape(prefix) + r'(\d+)')
    number = max([int(own.fullmatch(i).group(1)) for i in taken if own.fullmatch(i)] + [0]) + 1
    rid = f'{prefix}{number:03d}'
    row = '| ' + ' | '.join([rid, req, level, date or datetime.now().strftime('%Y-%m-%d'), cell(build, 'Build'),
                             cell(cmd, 'Command'), cell(output, 'Output'), result.capitalize()]) + ' |'
    return store.propose(sys.modules[__name__], root, 'add', rid, tc['section'], row, reason, actor, group=group)


def main(argv=None):
    import store
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=None, help='project root (default: the one holding kit.json)')
    early = argparse.ArgumentParser(add_help=False)
    early.add_argument('--root', type=Path, default=None)
    pre, _ = early.parse_known_args(argv)
    try:
        root = (pre.root or kbpaths.default_root()).resolve()
        api = plugins(root)
        reviewer = kbpaths.reviewer(root)
    except (KBError, kbpaths.kitconfig.ConfigError, OSError, ValueError) as e:
        emit({'ok': False, 'error': str(e)})
        return 2
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['import', 'rebuild', 'lint', 'status']:
        p = sub.add_parser(name)
        if name == 'import':
            p.add_argument('--group')
        if name == 'lint':
            p.add_argument('--code', action='store_true',
                           help='also check that code paths cited in MOD/LES/REQ/DEV records still exist')
    sub.add_parser('contested', help='Open decisions, blocked REQs, pending proposals, unavailable groups, gaps')
    p = sub.add_parser('add-group', help='Add one read-only group from a JSON entry file')
    p.add_argument('--file', type=Path, required=True)
    p.add_argument('--reason', required=True)
    p = sub.add_parser('remove-group', help='Remove one read-only group (rollback of add-group)')
    p.add_argument('--group', required=True)
    p.add_argument('--reason', required=True)
    sub.add_parser('trace', help='A record, the records it names and the records that name it').add_argument('id')
    sub.add_parser('file', help='Records that name a file or folder (LES, MOD, REQ first)').add_argument('path')
    p = sub.add_parser('coverage', help='REQ test coverage: met, partial, none, blocked, no source')
    p.add_argument('--group', help='the REQ group; default kb.tests.req_group')
    p = sub.add_parser('review', help='Review sheet for the KB store: export, mark Keep/Remove/Change, import')
    p.add_argument('action', choices=['export', 'import'])
    p.add_argument('--out', type=Path, help='export: the .xlsx to write')
    p.add_argument('--group', action='append', help='export: one store group (repeatable); default all')
    p.add_argument('--file', type=Path, help='import: the marked .xlsx')
    p.add_argument('--approve-as', help=f'import: reviewer name, only after {reviewer} said OK in chat')
    p.add_argument('--reason', help='import with --approve-as: quote the OK')
    p = sub.add_parser('test', help='TST: `add` proposes one check the AI ran; `import-review` adds a test review')
    p.add_argument('action', choices=['add', 'import-review'])
    p.add_argument('--req')
    p.add_argument('--level')
    p.add_argument('--cmd')
    p.add_argument('--output', help='one line: the output that shows the result')
    p.add_argument('--result', choices=TEST_RESULTS)
    p.add_argument('--build', help='build label or version')
    p.add_argument('--reason', required=True)
    p.add_argument('--actor')
    p.add_argument('--group', help='add: default kb.tests.group; import-review: the new group name')
    p.add_argument('--source', help='import-review: project-relative path of the test review .md')
    p.add_argument('--id-prefix', default='', help='import-review: e.g. R1- when test IDs repeat across reviews')
    sub.add_parser('get').add_argument('id')
    p = sub.add_parser('search')
    p.add_argument('query')
    p.add_argument('--type')
    p.add_argument('--status', choices=STATUSES)
    p.add_argument('--limit', type=int, choices=range(1, 51), default=10)
    p.add_argument('--scope', choices=kbpaths.scopes(root))
    store.add_parser(sub)
    clash = sorted(set(api.commands) & set(sub.choices))
    if clash:
        emit({'ok': False, 'error': f'Plugin command name already used by the KB: {", ".join(clash)}'})
        return 2
    for name, (help_text, add_args, _) in api.commands.items():
        add_args(sub.add_parser(name, help=help_text))
    args = parser.parse_args(argv)
    try:
        if args.command in api.commands:
            result = api.commands[args.command][2](sys.modules[__name__], root, args)
        elif args.command == 'store':
            result = store.dispatch(sys.modules[__name__], root, args)
        elif args.command == 'import':
            result = import_source(root, args.group)
        elif args.command == 'add-group':
            result = add_group(root, json.loads(args.file.read_text(encoding='utf-8-sig')), args.reason)
        elif args.command == 'remove-group':
            result = remove_group(root, args.group, args.reason)
        elif args.command == 'review':
            if args.action == 'export':
                if not args.out:
                    raise KBError('review export needs --out')
                result = review_export(root, args.out, args.group)
            else:
                if not args.file:
                    raise KBError('review import needs --file')
                result = review_import(root, args.file, args.approve_as, args.reason)
        elif args.command == 'test' and args.action == 'import-review':
            if not (args.source and args.group):
                raise KBError('test import-review needs --source and --group')
            result = test_import_review(root, args.source, args.group, args.reason, id_prefix=args.id_prefix)
        elif args.command == 'test':
            missing =[n for n in ('req', 'level', 'cmd', 'output', 'result', 'build', 'actor') if not getattr(args, n)]
            if missing:
                raise KBError('test add needs ' + ', '.join('--' + n for n in missing))
            result = test_add(root, args.req, args.level, args.cmd, args.output, args.result, args.build,
                              args.reason, args.actor, args.group)
        elif args.command == 'trace':
            result = trace(root, args.id)
        elif args.command == 'file':
            result = file_records(root, args.path)
        elif args.command == 'coverage':
            result = coverage(root, args.group)
        elif args.command == 'rebuild':
            result = rebuild(root)
        elif args.command == 'get':
            result = get(root, args.id)
        elif args.command == 'search':
            result = search(root, args.query, args.type, args.status, args.limit, args.scope)
        elif args.command == 'status':
            # Status reports a failing group instead of stopping; lint stays strict.
            result = lint(root, allow_drift=True, strict=False)
            result['index_exists'] = db_path(root).exists()
        elif args.command == 'contested':
            result = contested(root)
        else:
            result = lint(root)
            if args.code:
                result['code_paths'] = code_paths(root)
                result['ok'] = result['ok'] and result['code_paths']['ok']
        emit(result)
        return 0
    except (KBError, OSError, ValueError, KeyError, sqlite3.Error) as e:
        emit({'ok': False, 'error': str(e), 'command': args.command})
        return 2


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
