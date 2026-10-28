"""Authoritative KB stores, one hash-chained journal per configured group.

After `transfer`, one hash-chained JSONL journal owns the decision document, the pending
proposals and the edit ledger. The decisions .md is an export: each applied change rewrites
it, and a hand edit is reported as drift, never adopted silently.

Flow: propose (AI) -> review (a person) -> apply (ledger + export). Rollback hands authority
back to the .md, which already holds every applied change.
"""

import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone

import kbpaths

OPS = ('edit', 'add', 'move', 'intro', 'remove')
INTRO = 'INTRO'  # The text between the title and the first section heading.


class StoreError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def now():
    return datetime.now(timezone.utc).isoformat()


def nonempty(value, name):
    if not isinstance(value, str) or not value.strip():
        raise StoreError(f'{name} must be nonempty')
    return value


def home(root):
    directory = root / kbpaths.store_dir(root)
    # Store writes must never traverse a junction outside this workspace.
    if not directory.resolve().is_relative_to(root.resolve()):
        raise StoreError('Store directory resolves outside the workspace')
    return directory


def journal(kb, root, cfg):
    path = kb.inside(root, cfg.get('store') or f'{kbpaths.store_dir(root)}/{cfg["group"]}.jsonl')
    if path.is_symlink() or path.parent.resolve() != home(root).resolve():
        raise StoreError('Journal must be a regular file in the store directory')
    return path


@contextmanager
def locked(root):
    directory = home(root)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / '.write.lock'
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as e:
        raise StoreError('Store is locked; inspect any interrupted writer before removing .write.lock') from e
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(str(os.getpid()))
        yield
    finally:
        lock.unlink()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


# ---------------------------------------------------------------- document edits

def parsed(kb, cfg, document):
    # The decision table keeps its own parser; other store groups use the configured one.
    return kb.parse_text(cfg or {'parser': 'decision-table', 'group': ''}, document)


def table_of(kb, cfg, lines, section):
    # Return the header line and the insert position after the last row of the section's table.
    cfg = cfg or {'parser': 'decision-table'}
    try:
        start = kb.section_line(cfg, lines, section)
    except kb.KBError as e:
        raise StoreError(str(e)) from e
    decision = cfg['parser'] == 'decision-table'
    i = start + 1
    while i < len(lines) and not lines[i].startswith('#'):
        if (re.match(r'^\|\s*#\s*\|', lines[i]) if decision
                else lines[i].startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+$', lines[i + 1])):
            end = i + 2
            while end < len(lines) and lines[end].startswith('|'):
                end += 1
            return lines[i], end
        i += 1
    raise StoreError(f'No table under section: {section}')


def pipes(line):
    # Column separators only; an escaped `\|` is text inside a cell.
    return len(re.findall(r'(?<!\\)\|', line))


def checked_row(text, rid, header, ending):
    body = text.rstrip('\r\n')
    if ('\n' in body or '\r' in body
            or not re.match(r'^\|\s*' + re.escape(rid) + r'\s*\|', body)
            or not body.endswith('|')
            or pipes(body) != pipes(header.rstrip('\r\n'))):
        raise StoreError(f'Row must be one line, start with | {rid} | and match the table columns '
                         f'({header.rstrip()})')
    return body + ending


def intro_span(lines):
    if not lines or not lines[0].lstrip('﻿').startswith('# '):
        raise StoreError('Document must start with a title line')
    return 1, next((i for i in range(1, len(lines)) if lines[i].startswith('#')), len(lines))


def current_text(kb, document, rid, cfg=None):
    # The text a proposal replaces; a proposal is STALE when this changed after it was made.
    if rid == INTRO:
        start, end = intro_span(document.splitlines(keepends=True))
        return ''.join(document.splitlines(keepends=True)[start:end])
    return {r['id']: r['text'] for r in parsed(kb, cfg, document)}.get(rid)


def transform(kb, document, op, rid, section, text, cfg=None):
    """Apply one operation; return the new document, the replaced text ('' for add) and the new text."""
    if op not in OPS:
        raise StoreError('Unsupported operation: ' + str(op))
    rules = cfg or {'parser': 'decision-table'}
    records = {r['id']: r for r in parsed(kb, cfg, document)}
    lines = document.splitlines(keepends=True)
    ending = '\r\n' if lines and lines[0].endswith('\r\n') else '\n'
    if op == 'intro':
        if rid != INTRO:
            raise StoreError(f'intro edits use the ID {INTRO}')
        start, end = intro_span(lines)
        body = text.replace('\r\n', '\n').rstrip('\n').split('\n')
        if any(line.startswith(('#', '|')) for line in body):
            raise StoreError('Intro text must not contain headings or table rows')
        new = ''.join(line + ending for line in body) + ending
        before = ''.join(lines[start:end])
        if new == before:
            raise StoreError('Edit has no change')
        result = ''.join(lines[:start]) + new + ''.join(lines[end:])
        if {r['id'] for r in parsed(kb, cfg, result)} != set(records):
            raise StoreError('Operation would change record IDs')
        return result, before, new
    if op in ('add', 'move'):
        try:
            kb.section_line(rules, lines, section)
        except kb.KBError as e:
            raise StoreError(str(e)) from e
    if op == 'add':
        if not kb.store_id_ok(rules, rid):
            raise StoreError('New ID must look like D6 or F7' if rules['parser'] == 'decision-table'
                             else f'New ID must match {rules["id_pattern"]}')
        if rid in records:
            raise StoreError(f'STALE: {rid} already exists; propose an edit instead')
        before = ''
    else:
        if rid not in records:
            raise StoreError(f'STALE: {rid} is not in the store')
        before = records[rid]['text']
        index = records[rid]['source_line'] - 1
    if op == 'edit':
        row = checked_row(text, rid, records[rid]['table_header'], ending)
        if row == before:
            raise StoreError('Edit has no change')
        lines[index] = row
    elif op == 'remove':
        # The row leaves the document; the ledger keeps its text as `before`.
        if records[rid].get('source_end_line', records[rid]['source_line']) != records[rid]['source_line']:
            raise StoreError(f'{rid} spans several lines; remove supports one table row')
        del lines[index]
        row = ''
    else:
        if op == 'move':
            if kb.in_section(rules, records[rid], section):
                raise StoreError(f'{rid} is already in section {section}')
            del lines[index]
        header, end = table_of(kb, cfg, lines, section)
        row = checked_row(text, rid, header, ending)
        if end == len(lines) and lines and not lines[-1].endswith(('\n', '\r')):
            lines[-1] += ending
        lines.insert(end, row)
    result = ''.join(lines)
    try:
        ids = {r['id'] for r in parsed(kb, cfg, result)}
    except kb.KBError as e:
        raise StoreError(f'Operation would leave an unreadable document: {e}') from e
    wanted = set(records) | {rid} if op == 'add' else set(records) - {rid} if op == 'remove' else set(records)
    if ids != wanted:
        raise StoreError('Operation would change other record IDs')
    return result, before, row


# ---------------------------------------------------------------- journal replay

def read_events(path):
    if not path.exists():
        raise StoreError('KB store journal is missing: ' + path.name)
    try:
        events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
    except ValueError as e:
        raise StoreError('KB store journal is not valid JSONL') from e
    previous = ''
    for seq, event in enumerate(events, 1):
        core = {k: v for k, v in event.items() if k != 'hash'}
        if (event.get('schema_version') != 1 or event.get('seq') != seq
                or event.get('previous') != previous or event.get('hash') != digest(packed(core))):
            raise StoreError('Journal sequence or hash chain is invalid')
        previous = event['hash']
    return events


def replay(kb, events, cfg=None):
    if not events or events[0]['kind'] != 'transfer':
        raise StoreError('Journal does not start with a transfer')
    first = events[0]
    document = first['document']
    if digest(document.encode('utf-8')) != first['source_sha256']:
        raise StoreError('Transferred document hash mismatch')
    proposals, changes = {}, {}
    for event in events[1:]:
        kind = event['kind']
        if kind == 'propose':
            nonempty(event['actor'], 'Actor')
            nonempty(event['reason'], 'Reason')
            proposals[event['seq']] = {**event, 'review': 'pending', 'applied': False}
        elif kind == 'review':
            nonempty(event['reason'], 'Reason')
            p = proposals[event['proposal']]
            if nonempty(event['reviewed_by'], 'Reviewer').strip().lower() == p['actor'].strip().lower():
                raise StoreError('The reviewer must not be the proposal author')
            allowed = (p['review'] == 'pending'
                       or (p['review'] == 'approved' and not p['applied'] and event['decision'] == 'rejected'))
            if not allowed or event['decision'] not in ('approved', 'rejected'):
                raise StoreError('Proposal has already been reviewed or review is invalid')
            p['review'] = event['decision']
            p['reviewed_by'] = event['reviewed_by']
            p['review_reason'] = event['reason']
        elif kind == 'apply':
            nonempty(event['actor'], 'Actor')
            p = proposals[event['proposal']]
            if p['review'] != 'approved' or p['applied']:
                raise StoreError('Apply needs an approved, unapplied proposal')
            if event['before_sha256'] != digest(document.encode('utf-8')):
                raise StoreError('Ledger before hash mismatch')
            if p['op'] != 'add' and current_text(kb, document, p['id'], cfg) != p['before']:
                raise StoreError('STALE proposal: the row changed since it was proposed; propose again')
            document, _, _ = transform(kb, document, p['op'], p['id'], p.get('section'), p['after'], cfg)
            if event['after_sha256'] != digest(document.encode('utf-8')):
                raise StoreError('Ledger after hash mismatch')
            p['applied'] = True
            changes[p['id']] = {'proposal': p['seq'], 'apply': event['seq'], 'op': p['op'],
                                'approved_by': p['reviewed_by'], 'reason': p['reason']}
        elif kind == 'restore':
            if event['document_sha256'] != digest(document.encode('utf-8')):
                raise StoreError('Restore hash mismatch')
        elif kind == 'rollback':
            raise StoreError('Journal was rolled back; it is archived, not active')
        else:
            raise StoreError('Unsupported store event: ' + kind)
    return {'document': document, 'proposals': proposals, 'changes': changes,
            'source': first['source'], 'events': len(events)}


def append(kb, path, events, kind, cfg=None, **fields):
    event = {'schema_version': 1, 'seq': len(events) + 1,
             'previous': events[-1]['hash'] if events else '', 'kind': kind, 'time': now(), **fields}
    event['hash'] = digest(packed(event))
    if kind != 'rollback':
        replay(kb, events + [event], cfg)  # Validate before touching the only store.
    atomic(path, b''.join(packed(e) + b'\n' for e in events + [event]))
    return event


def load(kb, root, cfg):
    path = journal(kb, root, cfg)
    events = read_events(path)
    try:
        state = replay(kb, events, cfg)
    except (KeyError, TypeError, IndexError, AttributeError) as e:
        raise StoreError('Malformed store journal') from e
    if state['source'] != cfg['source']:
        raise StoreError('Journal belongs to a different document')
    target = kb.inside(root, cfg['source'])
    on_disk = target.read_bytes() if target.exists() else None
    # Git autocrlf may rewrite the export with CRLF on checkout; only a content change is drift.
    state['in_sync'] = (on_disk is not None and on_disk.replace(b'\r\n', b'\n')
                        == state['document'].encode('utf-8').replace(b'\r\n', b'\n'))
    state['on_disk'] = on_disk
    return path, events, state


def unresolved(state):
    return [n for n, p in state['proposals'].items()
            if p['review'] == 'pending' or (p['review'] == 'approved' and not p['applied'])]


def records(kb, cfg, state):
    data = state['document'].encode('utf-8')
    result = []
    for r in kb.parse_text(cfg, state['document'], cfg['source'], digest(data), mode='store', authority='kb-store'):
        r['store'] = cfg['store']
        change = state['changes'].get(r['id'])
        if change:
            r['approval_status'] = 'approved-in-kb'
            r['approved_by'] = change['approved_by']
            r['store_seq'] = change['apply']
        result.append(r)
    return result


def validated(kb, root, cfg):
    path, _, state = load(kb, root, cfg)
    cfg = {**cfg, 'export_in_sync': state['in_sync'], 'pending_proposals': len(unresolved(state))}
    return cfg, records(kb, cfg, state), digest(path.read_bytes())


def selected_config(kb, root, group=None):
    groups = kb.load_groups(root)
    if group is not None:
        return kb.select_group(groups, group)
    stores = [cfg for cfg in groups if cfg['mode'] == 'store']
    return kb.select_group(stores or groups)


def store_config(kb, root, group=None):
    cfg = selected_config(kb, root, group)
    if cfg['mode'] != 'store':
        raise StoreError('The KB store is not active; run `store transfer` first')
    return cfg


def unique_document(kb, root, cfg, document):
    # Refuse cross-group additions before the journal can contain an invalid decision set.
    # A group that fails validation (e.g. STALE) still owns the IDs its config expects.
    summary, existing, _ = kb.validated_records(root, strict=False)
    elsewhere = {r['id']: r['group'] for r in existing if r['group'] != cfg['group']}
    expected = {c['group']: c['expected_ids'] for c in kb.load_groups(root)}
    for item in summary['unavailable']:
        if item['group'] != cfg['group']:
            for rid in expected[item['group']]:
                elsewhere.setdefault(rid, item['group'])
    for r in kb.parse_text(cfg, document):
        if r['id'] in elsewhere:
            raise StoreError(f'Duplicate ID {r["id"]} in groups {cfg["group"]} and {elsewhere[r["id"]]}')


def require_sync(state):
    if not state['in_sync']:
        raise StoreError('EXPORT DRIFT: the document was changed outside the KB. '
                         'Run `store diff`, then propose the change or `store restore`.')


def export(kb, root, cfg, document):
    atomic(kb.inside(root, cfg['source']), document.encode('utf-8'))


# ---------------------------------------------------------------- commands

def transfer(kb, root, approved_by, reason, group=None):
    nonempty(approved_by, 'Approver')
    nonempty(reason, 'Reason')
    with locked(root):
        cfg = selected_config(kb, root, group)
        if cfg.get('parser') not in kb.STORE_PARSERS:
            raise StoreError('Only decision-table or id-table groups can move to the KB store; '
                             f'{cfg["group"]} stays read-only with its source as authority')
        if cfg['mode'] != 'read-only':
            raise StoreError('The KB store is already authoritative')
        if cfg.get('id_prefix'):
            raise StoreError(f'{cfg["group"]} adds an id_prefix to the document IDs; a store edits the document '
                             'rows by their own IDs, so it stays read-only')
        kb.validated_records(root)  # The pilot copy must match the document first.
        raw = kb.inside(root, cfg['source']).read_bytes()
        path = journal(kb, root, cfg)
        if path.exists():
            events = read_events(path)
            if len(events) != 1 or events[0]['source_sha256'] != digest(raw):
                raise StoreError('A store journal already exists; archive it before a new transfer')
        else:
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            snapshot = root / kbpaths.snapshots_dir(root) / f'transfer-{stamp}'
            atomic(snapshot / Path(cfg['source']).name, raw)
            atomic(snapshot / 'manifest.json', packed({'source': cfg['source'], 'sha256': digest(raw),
                                                       'taken': now()}))
            append(kb, path, [], 'transfer', cfg, source=cfg['source'], source_sha256=digest(raw),
                   document=raw.decode('utf-8'), approved_by=approved_by, reason=reason,
                   snapshot=snapshot.relative_to(root).as_posix())
        _, _, state = load(kb, root, {**cfg, 'store': path.relative_to(root).as_posix()})
        if state['document'].encode('utf-8') != raw:
            raise StoreError('Transferred document is not byte-identical; config left unchanged')
        kb.write_config(root, {**cfg, 'mode': 'store', 'authority': 'kb-store',
                               'store': path.relative_to(root).as_posix()})
    kb.rebuild(root)
    return {**status(kb, root, cfg['group']), 'byte_identical_to_source': True}


def status(kb, root, group=None):
    cfg = store_config(kb, root, group)
    _, events, state = load(kb, root, cfg)
    return {'group': cfg['group'], 'scope': cfg['scope'],
            'mode': 'store', 'authority': 'kb-store', 'events': len(events),
            'records': len(records(kb, cfg, state)), 'export_in_sync': state['in_sync'],
            'document_sha256': digest(state['document'].encode('utf-8')),
            'proposals': [{'proposal': n, 'op': p['op'], 'id': p['id'], 'review': p['review'],
                           'applied': p['applied'], 'reason': p['reason']}
                          for n, p in state['proposals'].items()],
            'unresolved': unresolved(state)}


def require_les_path(kb, cfg, document, rid, op):
    """A lesson reaches the editor only through a backticked path in `Applies to` (kb.py file, the edit
    hook, lint --code). Refuse an LES row that names none, so it cannot enter the store unseen."""
    if cfg.get('type') != 'LES' or op not in ('add', 'edit'):
        return
    import flow
    record = next((r for r in kb.parse_text(cfg, document) if r['id'] == rid), None)
    if record is None:
        return
    names, values = kb.row_cells(record.get('table_header', '')), kb.row_cells(record['text'])
    if 'Applies to' not in names or len(values) != len(names):
        return
    if not list(flow.path_tokens(values[names.index('Applies to')])):
        raise StoreError(f'{rid}: Applies to names no file or folder in backticks (e.g. `src/core/parser.c` or '
                         '`src/core/`), so the edit hook and `kb.py file` would never show it. '
                         'Put the exact path in backticks; a module name alone is not found.')


def propose(kb, root, op, rid, section, text, reason, actor, group=None):
    with locked(root):
        cfg = store_config(kb, root, group)
        path, events, state = load(kb, root, cfg)
        require_sync(state)
        document, before, after = transform(kb, state['document'], op, rid, section, text, cfg)
        require_les_path(kb, cfg, document, rid, op)
        unique_document(kb, root, cfg, document)
        event = append(kb, path, events, 'propose', cfg, op=op, id=rid, section=section,
                       before=before, after=after, reason=nonempty(reason, 'Reason'),
                       actor=nonempty(actor, 'Actor'))
    return {'group': cfg['group'], 'scope': cfg['scope'],
            'mode': 'store', 'proposal': event['seq'], 'review': 'pending', 'op': op, 'id': rid,
            'before': before, 'after': after, 'reason': reason}


PENDING_TEXT = {
    'en': {'waiting': 'Waiting for review', 'approved': 'Approved, not applied', 'reason': 'Reason',
           'hook_sees': 'Hook sees', 'hook_none': '**nothing**: put the path in backticks',
           'before': 'Before', 'after': 'After', 'new_row': 'New row',
           'title': '# KB: proposals waiting for {who}',
           'note': 'Written by `kb.py store pending --out`, read only. {waiting} waiting, {approved} approved '
                   'but not applied. Review in chat by group and #.',
           'empty': 'No proposal is waiting.'},
    'vi': {'waiting': 'Chờ duyệt', 'approved': 'Đã duyệt, chưa apply', 'reason': 'Lý do',
           'hook_sees': 'Hook thấy', 'hook_none': '**không** — cần đường dẫn trong backtick',
           'before': 'Trước', 'after': 'Sau', 'new_row': 'Dòng mới',
           'title': '# KB — đề xuất chờ {who}',
           'note': 'Sinh bằng `kb.py store pending --out`, chỉ để đọc. {waiting} chờ duyệt, '
                   '{approved} đã duyệt chưa apply. Duyệt trong chat theo nhóm và số #.',
           'empty': 'Không có đề xuất nào đang chờ.'},
}


def pending(kb, root, group=None, out=None):
    """Proposals waiting for the reviewer (not reviewed) and approved ones not yet applied, with their text.
    With `out`, also write them as Markdown to read or put on the canvas."""
    import flow
    groups = [c for c in kb.load_groups(root) if c['mode'] == 'store' and (group is None or c['group'] == group)]
    if group is not None and not groups:
        raise StoreError(f'No store group {group}')
    waiting, approved, lines, headers, types = [], [], [], {}, {}
    for cfg in groups:
        _, _, state = load(kb, root, cfg)
        first = next((r for r in kb.parse_text(cfg, state['document']) if r.get('table_header')), {})
        headers[cfg['group']] = (first.get('table_header', '') + first.get('table_separator', '')).rstrip('\n')
        types[cfg['group']] = cfg.get('type')
        for n, p in sorted(state['proposals'].items()):
            if p['applied'] or p['review'] == 'rejected':
                continue
            item = {'group': cfg['group'], 'proposal': n, 'op': p['op'], 'id': p['id'], 'section': p.get('section'),
                    'reason': p['reason'], 'actor': p['actor'], 'before': p['before'], 'after': p['after']}
            (waiting if p['review'] == 'pending' else approved).append(item)
    t = PENDING_TEXT.get(kbpaths.ui_lang(root), PENDING_TEXT['en'])
    for title, items in ((t['waiting'], waiting), (t['approved'], approved)):
        if not items:
            continue
        lines += [f'## {title} ({len(items)})', '']
        for x in items:
            row = x['after'].startswith('|')
            header = headers[x['group']] if row else ''
            lines += [f'### {x["group"]} #{x["proposal"]} · {x["op"]} {x["id"]}', '', f'- {t["reason"]}: {x["reason"]}']
            cells = kb.row_cells(x['after']) if row else []
            if types[x['group']] == 'LES' and len(cells) > 1:
                found = list(flow.path_tokens(cells[1]))
                lines.append(f'- {t["hook_sees"]}: ' + (', '.join(found) if found else t['hook_none']))
            if x['op'] == 'edit' and x['before']:
                lines += ['', f'**{t["before"]}:**', '', header, x['before'].rstrip('\n')]
            lines += ['', f'**{t["new_row"]}:**' if x['op'] == 'add' else f'**{t["after"]}:**', '', header, x['after'].rstrip('\n'), '']
    if out is not None:
        out = Path(out)
        who = kbpaths.reviewer(root)
        body = [t['title'].format(who=who), '',
                '> ' + t['note'].format(waiting=len(waiting), approved=len(approved)), ''] + lines
        if not lines:
            body.append(t['empty'])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(re.sub(r'\n{3,}', '\n\n', '\n'.join(body)) + '\n', encoding='utf-8')
    result = {'pending': waiting, 'approved_not_applied': approved}
    if out is not None:
        result['written'] = str(out)
    return result


def review(kb, root, number, decision, reviewer, reason, group=None):
    with locked(root):
        cfg = store_config(kb, root, group)
        path, events, state = load(kb, root, cfg)
        if number not in state['proposals']:
            raise StoreError(f'No proposal {number}')
        append(kb, path, events, 'review', cfg, proposal=number, decision=decision,
               reviewed_by=reviewer, reason=reason)
    return status(kb, root, cfg['group'])


def apply(kb, root, number, actor, group=None):
    with locked(root):
        cfg = store_config(kb, root, group)
        path, events, state = load(kb, root, cfg)
        require_sync(state)
        p = state['proposals'].get(number)
        if not p:
            raise StoreError(f'No proposal {number}')
        if p['review'] != 'approved' or p['applied']:
            raise StoreError('Apply needs an approved, unapplied proposal')
        document, _, _ = transform(kb, state['document'], p['op'], p['id'], p.get('section'), p['after'], cfg)
        require_les_path(kb, cfg, document, p['id'], p['op'])  # Also catches rows proposed before the check.
        unique_document(kb, root, cfg, document)
        append(kb, path, events, 'apply', cfg, proposal=number, actor=nonempty(actor, 'Actor'),
               before_sha256=digest(state['document'].encode('utf-8')),
               after_sha256=digest(document.encode('utf-8')))
        # The journal is the source; a failed export shows up as drift and `restore` repairs it.
        export(kb, root, cfg, document)
    kb.rebuild(root)
    return {**status(kb, root, cfg['group']), 'applied': number, 'id': p['id'], 'op': p['op'],
            'before': p['before'], 'after': p['after']}


def diff(kb, root, group=None):
    cfg = store_config(kb, root, group)
    _, _, state = load(kb, root, cfg)
    disk = (state['on_disk'] or b'').decode('utf-8', errors='replace')
    return {'group': cfg['group'], 'scope': cfg['scope'],
            'mode': 'store', 'export_in_sync': state['in_sync'],
            'diff': ''.join(difflib.unified_diff(state['document'].splitlines(keepends=True),
                                                 disk.splitlines(keepends=True),
                                                 fromfile='kb-store', tofile='document-on-disk'))}


def restore(kb, root, actor, reason, group=None):
    with locked(root):
        cfg = store_config(kb, root, group)
        path, events, state = load(kb, root, cfg)
        if state['in_sync']:
            return {**status(kb, root, cfg['group']), 'restored': False}
        # Keep the overwritten text in the ledger so a hand edit is never lost.
        append(kb, path, events, 'restore', cfg, actor=nonempty(actor, 'Actor'),
               reason=nonempty(reason, 'Reason'),
               document_sha256=digest(state['document'].encode('utf-8')),
               overwritten=None if state['on_disk'] is None
               else state['on_disk'].decode('utf-8', errors='replace'))
        export(kb, root, cfg, state['document'])
    return {**status(kb, root, cfg['group']), 'restored': True}


def ledger(kb, root, group=None):
    cfg = store_config(kb, root, group)
    events = read_events(journal(kb, root, cfg))
    return {'group': cfg['group'], 'scope': cfg['scope'],
            'mode': 'store', 'events': [{k: (v if k not in ('document', 'overwritten') else
                                             f'<{len(v or "")} chars>') for k, v in e.items()}
                                        for e in events]}


def rollback(kb, root, approved_by, reason, group=None):
    nonempty(approved_by, 'Approver')
    nonempty(reason, 'Reason')
    with locked(root):
        cfg = store_config(kb, root, group)
        path, events, state = load(kb, root, cfg)
        require_sync(state)
        if unresolved(state):
            raise StoreError(f'Resolve proposals {unresolved(state)} before rollback')
        append(kb, path, events, 'rollback', cfg, approved_by=approved_by, reason=reason,
               document_sha256=digest(state['document'].encode('utf-8')))
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        archive = home(root) / 'archive' / f'{path.stem}-{stamp}.jsonl'
        archive.parent.mkdir(parents=True, exist_ok=True)
        os.replace(path, archive)
        ids = [r['id'] for r in kb.parse_text(cfg, state['document'])]
        restored = {k: v for k, v in cfg.items() if k != 'store' and k not in kb.RUNTIME_KEYS}
        kb.write_config(root, {**restored, 'mode': 'read-only', 'authority': 'original-source',
                               'expected_ids': ids})
    result = kb.import_source(root, group=cfg['group'])
    return {**result, 'archived_journal': archive.relative_to(root).as_posix()}


def add_parser(sub):
    store = sub.add_parser('store', help='Authoritative KB store: transfer, propose, review, apply')
    store.add_argument('--group', help='Group to operate on; required with multiple store groups')
    commands = store.add_subparsers(dest='store_command', required=True)
    for name in ('status', 'diff', 'ledger'):
        commands.add_parser(name)
    p = commands.add_parser('pending', help='proposals waiting for review or apply, with their text; all store '
                                            'groups unless --group')
    p.add_argument('--out', type=Path, help='also write them as Markdown here')
    for name in ('transfer', 'rollback'):
        p = commands.add_parser(name)
        p.add_argument('--approved-by', required=True)
        p.add_argument('--reason', required=True)
    p = commands.add_parser('propose')
    p.add_argument('op', choices=OPS)
    p.add_argument('id')
    p.add_argument('--section', help='decided/open/recorded-response for decisions; a heading text for id-table')
    p.add_argument('--text-file', type=Path, help='the whole row (or intro text); not used by remove')
    p.add_argument('--reason', required=True)
    p.add_argument('--actor', required=True)
    p = commands.add_parser('review')
    p.add_argument('proposal', type=int)
    p.add_argument('--decision', choices=['approved', 'rejected'], required=True)
    p.add_argument('--reviewed-by', required=True)
    p.add_argument('--reason', required=True)
    p = commands.add_parser('apply')
    p.add_argument('proposal', type=int)
    p.add_argument('--actor', required=True)
    p = commands.add_parser('restore')
    p.add_argument('--actor', required=True)
    p.add_argument('--reason', required=True)
    # Accept both `store --group NAME status` and `store status --group NAME`.
    import argparse
    for command in commands.choices.values():
        command.add_argument('--group', default=argparse.SUPPRESS)


def dispatch(kb, root, args):
    command = args.store_command
    if command == 'pending':
        return pending(kb, root, getattr(args, 'group', None), args.out)
    if command == 'transfer':
        return transfer(kb, root, args.approved_by, args.reason, args.group)
    if command == 'rollback':
        return rollback(kb, root, args.approved_by, args.reason, args.group)
    if command == 'propose':
        if args.op in ('add', 'move') and not args.section:
            raise StoreError('add and move need --section')
        if args.op != 'remove' and not args.text_file:
            raise StoreError(f'{args.op} needs --text-file')
        text = '' if args.op == 'remove' else args.text_file.read_bytes().decode('utf-8-sig')
        return propose(kb, root, args.op, args.id, args.section, text, args.reason, args.actor, args.group)
    if command == 'review':
        return review(kb, root, args.proposal, args.decision, args.reviewed_by, args.reason, args.group)
    if command == 'apply':
        return apply(kb, root, args.proposal, args.actor, args.group)
    if command == 'restore':
        return restore(kb, root, args.actor, args.reason, args.group)
    return {'status': status, 'diff': diff, 'ledger': ledger}[command](kb, root, args.group)
