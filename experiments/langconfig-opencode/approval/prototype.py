"""Isolated SQLite approval and durable-job experiment; not production code."""

from contextlib import closing
import sqlite3
import time
import uuid


class Conflict(Exception):
    pass


def connect(path):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def initialize(path):
    with closing(connect(path)) as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
          version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'decided')),
          UNIQUE(task_id, checkpoint)
        );
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
          request_key TEXT NOT NULL UNIQUE, decision TEXT NOT NULL,
          task_id TEXT NOT NULL, checkpoint TEXT NOT NULL, version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES receipts(id),
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done')),
          owner TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease_until REAL
        );
        """)


def create_approval(path, approval_id, task_id, checkpoint, version=1):
    with closing(connect(path)) as db:
        db.execute("INSERT INTO approvals VALUES (?, ?, ?, ?, 'pending')",
                   (approval_id, task_id, checkpoint, version))


def decide(path, approval_id, task_id, checkpoint, version, decision, request_key,
           *, before_commit=None):
    """Commit decision, receipt and resume job together; retry identical requests safely."""
    if decision not in ('approve', 'reject') or not all(
        isinstance(x, str) and x for x in (approval_id, task_id, checkpoint, request_key)
    ):
        raise ValueError('Invalid decision or identity')
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        receipt = db.execute('SELECT * FROM receipts WHERE request_key = ?', (request_key,)).fetchone()
        if receipt:
            expected = (approval_id, task_id, checkpoint, version, decision)
            actual = tuple(receipt[k] for k in ('approval_id', 'task_id', 'checkpoint', 'version', 'decision'))
            if actual != expected:
                raise Conflict('Idempotency key reused with different request')
            db.commit()
            return dict(receipt)
        updated = db.execute("""UPDATE approvals SET status = 'decided'
            WHERE id = ? AND task_id = ? AND checkpoint = ? AND version = ? AND status = 'pending'
            RETURNING id""", (approval_id, task_id, checkpoint, version)).fetchone()
        if not updated:
            raise Conflict('Approval missing, stale or already decided')
        receipt_id = str(uuid.uuid4())
        db.execute('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?)',
                   (receipt_id, approval_id, request_key, decision, task_id, checkpoint, version))
        db.execute("INSERT INTO jobs (id, receipt_id, status) VALUES (?, ?, 'pending')",
                   (str(uuid.uuid4()), receipt_id))
        if before_commit:
            before_commit()
        db.commit()
        return dict(db.execute('SELECT * FROM receipts WHERE id = ?', (receipt_id,)).fetchone())
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def claim(path, owner, lease_seconds, *, now=None):
    if not owner or lease_seconds <= 0:
        raise ValueError('Invalid worker or lease')
    now = time.time() if now is None else now
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        job = db.execute("""SELECT * FROM jobs WHERE status = 'pending'
            OR (status = 'running' AND lease_until <= ?) ORDER BY rowid LIMIT 1""", (now,)).fetchone()
        if not job:
            db.commit()
            return None
        db.execute("UPDATE jobs SET status = 'running', owner = ?, epoch = epoch + 1, lease_until = ? WHERE id = ?",
                   (owner, now + lease_seconds, job['id']))
        result = dict(db.execute('SELECT * FROM jobs WHERE id = ?', (job['id'],)).fetchone())
        db.commit()
        return result
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def finish(path, job_id, owner, epoch, *, now=None):
    now = time.time() if now is None else now
    with closing(connect(path)) as db:
        result = db.execute("""UPDATE jobs SET status = 'done', lease_until = NULL
            WHERE id = ? AND status = 'running' AND owner = ? AND epoch = ? AND lease_until > ?""",
            (job_id, owner, epoch, now))
        return result.rowcount == 1


def snapshot(path):
    with closing(connect(path)) as db:
        return {name: [dict(row) for row in db.execute(f'SELECT * FROM {name} ORDER BY rowid')]
                for name in ('approvals', 'receipts', 'jobs')}
