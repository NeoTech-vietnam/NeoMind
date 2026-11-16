"""Standalone PostgreSQL experiment, not integrated with LangGraph or production."""

import uuid

import psycopg
from psycopg.rows import dict_row


class Conflict(Exception):
    pass


def initialize(dsn):
    with psycopg.connect(dsn) as db:
        db.execute("""CREATE TABLE approvals (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
          version INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'decided')),
          UNIQUE(task_id, checkpoint))""")
        db.execute("""CREATE TABLE receipts (
          id UUID PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
          request_key TEXT NOT NULL UNIQUE, decision TEXT NOT NULL,
          task_id TEXT NOT NULL, checkpoint TEXT NOT NULL, version INTEGER NOT NULL)""")
        db.execute("""CREATE TABLE jobs (
          id UUID PRIMARY KEY, receipt_id UUID NOT NULL UNIQUE REFERENCES receipts(id),
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done')),
          owner TEXT, epoch BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ)""")


def create_approval(dsn, approval_id, task_id, checkpoint, version=1):
    with psycopg.connect(dsn) as db:
        db.execute("INSERT INTO approvals VALUES (%s, %s, %s, %s, 'pending')",
                   (approval_id, task_id, checkpoint, version))


def decide(dsn, approval_id, task_id, checkpoint, version, decision, request_key, *, before_commit=None):
    if decision not in ('approve', 'reject') or not all(
        isinstance(x, str) and x for x in (approval_id, task_id, checkpoint, request_key)
    ):
        raise ValueError('Invalid decision or identity')
    expected = (approval_id, task_id, checkpoint, version, decision)
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        # Serialize both competing decisions and retries for this approval.
        approval = db.execute('SELECT * FROM approvals WHERE id = %s FOR UPDATE', (approval_id,)).fetchone()
        receipt = db.execute('SELECT * FROM receipts WHERE request_key = %s', (request_key,)).fetchone()
        if receipt:
            actual = tuple(receipt[k] for k in ('approval_id', 'task_id', 'checkpoint', 'version', 'decision'))
            if actual != expected:
                raise Conflict('Idempotency key reused with different request')
            return receipt
        if not approval or (approval['task_id'], approval['checkpoint'], approval['version'], approval['status']) != (
            task_id, checkpoint, version, 'pending'
        ):
            raise Conflict('Approval missing, stale or already decided')
        db.execute("UPDATE approvals SET status = 'decided' WHERE id = %s", (approval_id,))
        receipt_id = uuid.uuid4()
        try:
            receipt = db.execute('''INSERT INTO receipts VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING *''', (receipt_id, approval_id, request_key, decision, task_id, checkpoint, version)).fetchone()
            db.execute("INSERT INTO jobs (id, receipt_id, status) VALUES (%s, %s, 'pending')",
                       (uuid.uuid4(), receipt_id))
        except psycopg.errors.UniqueViolation as exc:
            raise Conflict('Receipt or idempotency key already exists') from exc
        if before_commit:
            before_commit()
        return receipt


def claim(dsn, owner, lease_seconds):
    if not owner or lease_seconds <= 0:
        raise ValueError('Invalid worker or lease')
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        return db.execute("""UPDATE jobs SET status = 'running', owner = %s, epoch = epoch + 1,
            lease_until = clock_timestamp() + %s * interval '1 second'
            WHERE id = (SELECT id FROM jobs WHERE status = 'pending'
              OR (status = 'running' AND lease_until <= clock_timestamp())
              ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *""", (owner, lease_seconds)).fetchone()


def finish(dsn, job_id, owner, epoch):
    with psycopg.connect(dsn) as db:
        result = db.execute("""UPDATE jobs SET status = 'done', lease_until = NULL
            WHERE id = %s AND status = 'running' AND owner = %s AND epoch = %s
              AND lease_until > clock_timestamp()""", (job_id, owner, epoch))
        return result.rowcount == 1


def snapshot(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        return {name: db.execute('SELECT * FROM ' + name).fetchall()
                for name in ('approvals', 'receipts', 'jobs')}
