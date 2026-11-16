"""PostgreSQL-only fenced effect experiment; no external effects or production use."""

import hashlib
import uuid

import psycopg
from psycopg.rows import dict_row


class SinkConflict(Exception):
    pass


def initialize(dsn):
    with psycopg.connect(dsn) as db:
        db.execute('''CREATE TABLE fixture_effects (
            id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES jobs(id),
            effect_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
            payload BYTEA NOT NULL)''')


def apply(dsn, job_id, owner, epoch, effect_key, payload, *, before_commit=None):
    if not isinstance(effect_key, str) or not effect_key or not isinstance(payload, bytes):
        raise ValueError('Expected a nonempty key and bytes payload')
    payload_hash = hashlib.sha256(payload).hexdigest()
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        # The same row lock serializes this effect with lease takeover and finish.
        job = db.execute('''SELECT id FROM jobs WHERE id = %s AND status = 'running'
            AND owner = %s AND epoch = %s AND lease_until > clock_timestamp()
            FOR UPDATE''', (job_id, owner, epoch)).fetchone()
        if not job:
            raise SinkConflict('Stale or expired worker')
        receipt = db.execute('''INSERT INTO fixture_effects (id, job_id, effect_key, payload_hash, payload)
            VALUES (%s, %s, %s, %s, %s) ON CONFLICT (effect_key) DO NOTHING RETURNING *''',
            (uuid.uuid4(), job_id, effect_key, payload_hash, payload)).fetchone()
        if receipt is None:
            receipt = db.execute('SELECT * FROM fixture_effects WHERE effect_key = %s', (effect_key,)).fetchone()
            if receipt['job_id'] != job_id or receipt['payload_hash'] != payload_hash or bytes(receipt['payload']) != payload:
                raise SinkConflict('Idempotency key reused for different effect')
        if before_commit:
            before_commit()
        return receipt
