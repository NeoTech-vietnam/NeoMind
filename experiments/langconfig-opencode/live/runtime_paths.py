"""Validate experiment data paths and the owner-supplied live budget anchor."""
import json
import os
import sqlite3
from pathlib import Path

CODE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = CODE_ROOT.parents[2]


def require_data_root(value=None):
    value = os.environ.get('LIVE_GUARD_DATA') if value is None else value
    if not value or not Path(value).is_absolute():
        raise ValueError('LIVE_GUARD_DATA must be an existing absolute directory')
    root = Path(value).resolve(strict=True)
    if not root.is_dir() or root == REPO_ROOT or root.is_relative_to(REPO_ROOT) or REPO_ROOT.is_relative_to(root):
        raise ValueError('LIVE_GUARD_DATA must not overlap the checkout')
    for name in ('tmp', 'runs', 'live-attempts', 'runner-fixture'):
        child = root / name
        if child.is_symlink() or (child.exists() and not child.is_dir()):
            raise ValueError(f'unsafe experiment directory: {name}')
    return root


def verify_live_budget(root, value):
    if not value or not Path(value).is_absolute():
        raise ValueError('existing absolute shared live budget path required')
    anchor = json.loads((root / 'live-budget.anchor.json').read_text(encoding='utf-8'))
    workflow_cap = anchor.get('workflowCap', 4)
    if type(workflow_cap) is not int or workflow_cap not in (4, 5, 7):
        raise ValueError('invalid owner-approved workflow cap')
    ids = anchor.get('requiredReservationIds')
    if (type(anchor.get('schemaVersion')) is not int or anchor['schemaVersion'] != 1 or not isinstance(anchor.get('database'), str)
            or not Path(anchor['database']).is_absolute()
            or type(anchor.get('device')) is not int or type(anchor.get('inode')) is not int
            or type(anchor.get('minimumWorkflows')) is not int or anchor['minimumWorkflows'] < 1
            or type(anchor.get('minimumReservations')) is not int or anchor['minimumReservations'] < 1
            or not isinstance(ids, list) or not ids or any(not isinstance(item, str) or not item for item in ids)):
        raise ValueError('invalid live budget anchor')
    path = Path(value).resolve(strict=True)
    stat = path.stat()
    if (not path.is_file() or path.is_relative_to(REPO_ROOT) or str(path) != anchor['database']
            or (stat.st_dev, stat.st_ino) != (anchor['device'], anchor['inode'])):
        raise ValueError('live budget does not match owner anchor')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        if db.execute('SELECT cap, workflow_cap FROM limits WHERE id=1').fetchone() != (40, workflow_cap):
            raise ValueError('invalid live budget limits')
        workflows = db.execute('SELECT count(*) FROM workflows').fetchone()[0]
        reservations = db.execute('SELECT count(*) FROM reservations').fetchone()[0]
        if workflows < anchor['minimumWorkflows'] or reservations < anchor['minimumReservations']:
            raise ValueError('live budget history below anchor floor')
        if any(db.execute('SELECT 1 FROM reservations WHERE id=?', (item,)).fetchone() is None for item in ids):
            raise ValueError('live budget missing anchored reservation')
    finally:
        db.close()
    return path


if __name__ == '__main__':
    print(require_data_root())
