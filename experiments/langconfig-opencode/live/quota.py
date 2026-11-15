"""Experimental process-safe admission journal; not a production guarantee."""
import sqlite3
import os
import sys
import time
from pathlib import Path


def connect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, timeout=4, isolation_level=None)
    db.execute('PRAGMA busy_timeout=4000')
    db.execute('PRAGMA synchronous=FULL')
    return db


def initialize(path, maximum, workflow_limit=4):
    if not 1 <= maximum <= 40 or not 1 <= workflow_limit <= 40:
        raise ValueError('bad maximum')
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    db = sqlite3.connect(path, isolation_level=None)
    db.executescript('''PRAGMA synchronous=FULL;
        CREATE TABLE limits (id INTEGER PRIMARY KEY CHECK(id=1), cap INTEGER NOT NULL CHECK(cap BETWEEN 1 AND 40), workflow_cap INTEGER NOT NULL CHECK(workflow_cap BETWEEN 1 AND 40));
        CREATE TABLE workflows (id TEXT PRIMARY KEY, cap INTEGER NOT NULL CHECK(cap BETWEEN 1 AND 40));
        CREATE TABLE sessions (session TEXT PRIMARY KEY, workflow TEXT NOT NULL REFERENCES workflows(id));
        CREATE TABLE reservations (id TEXT PRIMARY KEY, session TEXT NOT NULL, workflow TEXT NOT NULL, created INTEGER NOT NULL);
    ''')
    db.execute('INSERT INTO limits VALUES(1,?,?)', (maximum, workflow_limit))
    db.close()


def start_workflow(path, workflow, cap):
    """Consume one new workflow attempt before starting its worker; no resume."""
    if not workflow or not 1 <= cap <= 40:
        raise ValueError('bad workflow')
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        limit = db.execute('SELECT workflow_cap FROM limits WHERE id=1').fetchone()
        if not limit or db.execute('SELECT count(*) FROM workflows').fetchone()[0] >= limit[0]:
            raise ValueError('workflow limit exceeded')
        if db.execute('SELECT 1 FROM workflows WHERE id=?', (workflow,)).fetchone():
            raise ValueError('workflow attempt already exists')
        db.execute('INSERT INTO workflows VALUES(?,?)', (workflow, cap))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def bind(path, session, workflow, cap):
    if not session.startswith('ses_') or not workflow or not 1 <= cap <= 40:
        raise ValueError('bad binding')
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        known = db.execute('SELECT 1 FROM workflows WHERE id=?', (workflow,)).fetchone()
        workflow_limit = db.execute('SELECT workflow_cap FROM limits WHERE id=1').fetchone()[0]
        if not known and db.execute('SELECT count(*) FROM workflows').fetchone()[0] >= workflow_limit:
            raise ValueError('workflow limit exceeded')
        db.execute('INSERT OR IGNORE INTO workflows VALUES(?,?)', (workflow, cap))
        if db.execute('SELECT cap FROM workflows WHERE id=?', (workflow,)).fetchone()[0] != cap:
            raise ValueError('workflow quota changed')
        db.execute('INSERT INTO sessions VALUES(?,?)', (session, workflow))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def reserve(path, session, request_id):
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        limits = db.execute('SELECT cap FROM limits WHERE id=1').fetchone()
        binding = db.execute('SELECT sessions.workflow, workflows.cap FROM sessions JOIN workflows ON workflows.id=sessions.workflow WHERE sessions.session=?', (session,)).fetchone()
        if not limits or not binding:
            raise ValueError('missing quota or session')
        total = db.execute('SELECT count(*) FROM reservations').fetchone()[0]
        workflow = db.execute('SELECT count(*) FROM reservations WHERE workflow=?', (binding[0],)).fetchone()[0]
        if total >= limits[0] or workflow >= binding[1]:
            raise ValueError('quota exceeded')
        db.execute('INSERT INTO reservations VALUES(?,?,?,?)', (request_id, session, binding[0], time.time_ns()))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    if command == 'reserve' and len(args) == 3:
        reserve(*args)
    else:
        raise SystemExit('invalid command')
