"""Flow commands over the whole KB: links (trace), records about a file, REQ test coverage,
what is still open, and whether cited code paths still exist."""

import re

FILE_EXT = re.compile(r'\.(c|h|cpp|hpp|cc|cs|go|rs|java|kt|js|jsx|ts|tsx|py|rb|php|swift|md|conf|hex|ld|dts|dtsi'
                      r'|overlay|cmake|json|yml|yaml|toml|ini|txt|sh|ps1|sql|html|css|a)$', re.I)


def all_records(kb, root):
    cfg, conn = kb.open_index(root)
    try:
        rows = [kb.json.loads(p) for (p,) in conn.execute('SELECT payload FROM records')]
    finally:
        conn.close()
    return cfg, rows


def id_regex(rid):
    # The ID as a whole token: not part of a longer ID (D1 in D10, X-1 in X-1.lib).
    return re.compile(r'(?<![\w.-])' + re.escape(rid) + r'(?![\w-]|\.\w)')


def brief(r):
    return {'id': r['id'], 'type': r['type'], 'group': r['group'], 'status': r['status'],
            'citation': r.get('citation') or (r['source'] + (f'#{r["source_locator"]}' if r.get('source_locator')
                                                            else f':{r.get("source_line", "")}'))}


def trace(kb, root, rid):
    record = kb.get(root, rid)
    _, rows = all_records(kb, root)
    skip = kb.hidden_types(root)
    text = record['text']
    out = [r for r in rows if r['id'] != rid and r['type'] not in skip and id_regex(r['id']).search(text)]
    find = id_regex(rid)
    into = [r for r in rows if r['id'] != rid and r['type'] not in skip and find.search(r['text'])]
    return {'id': rid, 'type': record['type'], 'group': record['group'], 'status': record['status'],
            'citation': record['citation'], 'links_to': [brief(r) for r in sorted(out, key=lambda r: r['id'])],
            'linked_from': [brief(r) for r in sorted(into, key=lambda r: r['id'])]}


def path_tokens(text):
    # Backticked paths or file names in a record: `src/core/`, `parser.c`.
    for token in re.findall(r'`([^`\s]+)`', text):
        token = token.replace('\\', '/').lstrip('./')
        if '/' in token.rstrip('/') or FILE_EXT.search(token):
            yield token  # `docs/` alone is too broad to name a file; `src/core/` is not.


def names_path(token, target):
    t = token.lower()
    if t.endswith('/'):
        return ('/' + t) in target or target.startswith(t)
    return target.endswith('/' + t) or target == t


def file_records(kb, root, path):
    target = str(path).replace('\\', '/').lower()
    _, rows = all_records(kb, root)
    skip = kb.hidden_types(root)
    order = {'LES': 0, 'MOD': 1, 'REQ': 2, 'DEC': 3}
    hits = [r for r in rows if r['type'] not in skip and any(names_path(t, target) for t in path_tokens(r['text']))]
    hits.sort(key=lambda r: (order.get(r['type'], 9), r['id']))
    return {'path': str(path), 'records': [{**brief(r), 'text': r['text'].strip()} for r in hits]}


def cells(kb, record):
    names = kb.row_cells(record.get('table_header', '')) if record.get('table_header') else []
    values = kb.row_cells(record['text'])
    return dict(zip(names, values)) if len(names) == len(values) else {}


def coverage(kb, root, group):
    """Each REQ against the TST rows that name it: met (pass at the required level or above),
    partial (tested, but lower or not passed), none, blocked; and REQs with no source.
    Levels, column names and the level of a review row come from kit.json kb.tests."""
    tc = kb.tests_cfg(root)
    levels, col = tc['levels'], tc['columns']
    top = levels[-1]
    review = tc['review_level'] or top  # A row that names the REQ but has no Level column.
    _, rows = all_records(kb, root)
    reqs = [r for r in rows if r['group'] == group and r['type'] == 'REQ']
    if not reqs:
        raise kb.KBError(f'No REQ records in {group}')
    tests = [r for r in rows if r['type'] == 'TST']
    result = {'group': group, 'reqs': len(reqs), 'met': [], 'partial': [], 'none': [], 'blocked': [], 'no_source': []}
    for req in sorted(reqs, key=lambda r: r.get('source_line', 0)):
        c = cells(kb, req)
        if c.get(col['source'], '').strip() in ('', '—', '-'):
            result['no_source'].append(req['id'])
        if req['status'] == 'blocked':
            result['blocked'].append(req['id'])
            continue
        need = c.get(col['level']) if c.get(col['level']) in levels else top
        found = id_regex(req['id'])
        best, tried = None, False
        for t in tests:
            tc_cells = cells(kb, t)
            if tc_cells.get(col['req']):
                if tc_cells[col['req']].strip() != req['id']:
                    continue
                level = tc_cells.get(col['level']) or review
            elif found.search(t['text']):
                level = review
            else:
                continue
            tried = True
            if t['status'] == 'pass' and level in levels and (best is None or levels.index(level) > levels.index(best)):
                best = level
        if best is not None and levels.index(best) >= levels.index(need):
            result['met'].append(req['id'])
        elif tried:
            result['partial'].append(req['id'])
        else:
            result['none'].append(req['id'])
    result['counts'] = {k: len(v) for k, v in result.items() if isinstance(v, list)}
    return result


# ---------------------------------------------------------------- what is still open

def contested(kb, root):
    """Everything that waits for a decision or a fix: open decisions, blocked REQs, proposals not
    yet reviewed or applied, unavailable groups, deferred source IDs, and REQ coverage gaps
    (for the groups in kit.json kb.tests.coverage_groups)."""
    import store
    cfg, rows = all_records(kb, root)
    wanted = set(kb.tests_cfg(root)['coverage_groups'] or [])
    out = {'open_decisions': [brief(r) for r in rows if r['type'] == 'DEC' and r['status'] == 'open'],
           'blocked': [brief(r) for r in rows if r['status'] == 'blocked'],
           'pending_proposals': [], 'unavailable_groups': cfg['unavailable'], 'deferred_ids': {}, 'coverage': {}}
    for g in cfg['groups']:
        if g['mode'] == 'store':
            for p in store.status(kb, root, g['group'])['proposals']:
                if p['review'] == 'pending' or (p['review'] == 'approved' and not p['applied']):
                    out['pending_proposals'].append({'group': g['group'], **p})
        if g.get('deferred_ids'):
            out['deferred_ids'][g['group']] = g['deferred_ids']
        if g['group'] in wanted and any(r['group'] == g['group'] and r['type'] == 'REQ' for r in rows):
            out['coverage'][g['group']] = coverage(kb, root, g['group'])['counts']
    out['counts'] = {k: len(v) for k, v in out.items() if isinstance(v, (list, dict)) and k != 'coverage'}
    return out


# ---------------------------------------------------------------- do cited paths still exist

CODE_TYPES = ('MOD', 'LES', 'REQ', 'DEV')


def repo_files(repo):
    # Tracked files when the folder is a Git repo (fast, skips build output); else every file.
    import subprocess
    r = subprocess.run(['git', '-C', str(repo), 'ls-files'], capture_output=True, encoding='utf-8')
    if r.returncode == 0 and r.stdout.strip() and (repo / '.git').exists():
        return [line for line in r.stdout.splitlines() if line]
    return [p.relative_to(repo).as_posix() for p in repo.rglob('*') if p.is_file()]


def default_repos(kb, root):
    """The project root and every repo in kit.json `repos` that exists."""
    out = [root]
    for repo in kb.kbpaths.kit(root).get('repos') or []:
        path = root / repo['path']  # Not resolved: a repo reached through a link keeps its project path.
        if path.is_dir() and path not in out:
            out.append(path)
    return out


def code_paths(kb, root, repos=None):
    """Check every backticked path in MOD/LES/REQ/DEV records: OK, MOVED (same name elsewhere),
    GONE (its top folder exists but the path does not), UNVERIFIABLE (outside every repo)."""
    from pathlib import Path
    repos = [Path(r) for r in (repos or default_repos(kb, root))]
    files = {r: repo_files(r) for r in repos}
    by_name, tops, all_paths = {}, set(), set()
    for repo, names in files.items():
        try:
            prefix = repo.relative_to(root).as_posix() + '/' if repo != root else ''
        except ValueError:
            prefix = ''  # A repo outside the project root: its paths are cited from its own root.
        for f in names:
            full = prefix + f
            all_paths.add((repo, f))
            all_paths.add((repo, full))  # A record may cite the path from the project root.
            by_name.setdefault(f.rsplit('/', 1)[-1].lower(), []).append(full)
            tops.add(f.split('/', 1)[0].lower())
    _, rows = all_records(kb, root)
    results = []
    for r in rows:
        if r['type'] not in CODE_TYPES:
            continue
        for token in sorted(set(path_tokens(r['text']))):
            t = token.rstrip('/').lower()
            folder = token.endswith('/')
            hit = any(f.lower() == t or f.lower().endswith('/' + t) or
                      (folder or '/' in t) and (f.lower().startswith(t + '/') or ('/' + t + '/') in ('/' + f.lower()))
                      for _, f in all_paths)
            if hit:
                status, cands = 'OK', []
            else:
                cands = [] if folder else sorted(by_name.get(t.rsplit('/', 1)[-1], []))
                if cands:
                    status = 'MOVED'
                elif '/' in t and t.split('/', 1)[0] in tops:
                    status = 'GONE'
                else:
                    status = 'UNVERIFIABLE'
            item = {'id': r['id'], 'type': r['type'], 'group': r['group'], 'path': token, 'status': status}
            if cands:
                item['candidates'] = cands[:5]
            results.append(item)
    counts = {s: sum(1 for x in results if x['status'] == s) for s in ('OK', 'MOVED', 'GONE', 'UNVERIFIABLE')}
    return {'ok': not counts['MOVED'] and not counts['GONE'], 'counts': counts,
            'paths': sorted(results, key=lambda x: (x['status'] == 'OK', x['id'], x['path']))}
