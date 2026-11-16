"""Isolated PostgreSQL authority and synthetic sink; not an authentication boundary."""

from dataclasses import dataclass
import hashlib
import json
import uuid

import psycopg
from psycopg.rows import dict_row


class Denied(Exception):
    pass


@dataclass(frozen=True)
class TrustedPrincipal:
    # Test host must establish identity; this type does not authenticate anyone.
    actor: str


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def initialize(dsn):
    with psycopg.connect(dsn) as db:
        db.execute('''CREATE TABLE tx_policy (project TEXT PRIMARY KEY, generation BIGINT NOT NULL,
            enabled BOOLEAN NOT NULL)''')
        db.execute('''CREATE TABLE tx_grant (project TEXT NOT NULL REFERENCES tx_policy(project),
            actor TEXT NOT NULL, scope TEXT NOT NULL, enabled BOOLEAN NOT NULL,
            PRIMARY KEY(project, actor, scope))''')
        db.execute('''CREATE TABLE tx_approval (id TEXT PRIMARY KEY, project TEXT NOT NULL,
            actor TEXT NOT NULL, scope TEXT NOT NULL, generation BIGINT NOT NULL,
            binding_hash TEXT NOT NULL, decision TEXT NOT NULL)''')
        db.execute('''CREATE TABLE tx_job (id TEXT PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES tx_approval(id),
            owner TEXT NOT NULL, epoch BIGINT NOT NULL, lease_until TIMESTAMPTZ NOT NULL, status TEXT NOT NULL)''')
        db.execute('''CREATE TABLE tx_effect (id UUID PRIMARY KEY, job_id TEXT NOT NULL REFERENCES tx_job(id),
            effect_key TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
            payload JSONB NOT NULL)''')


def seed(dsn, principal, binding):
    """Test setup only; no caller authentication or approval endpoint."""
    with psycopg.connect(dsn) as db:
        db.execute('INSERT INTO tx_policy VALUES (%s, 1, true)', (binding['project'],))
        db.execute('INSERT INTO tx_grant VALUES (%s, %s, %s, true)',
                   (binding['project'], principal.actor, binding['scope']))
        db.execute("INSERT INTO tx_approval VALUES ('approval', %s, %s, %s, 1, %s, 'approve')",
                   (binding['project'], principal.actor, binding['scope'], digest(binding)))
        db.execute("INSERT INTO tx_job VALUES ('job', 'approval', 'worker', 1, clock_timestamp() + interval '60 seconds', 'running')")


def revoke(dsn, project, *, after_lock=None):
    with psycopg.connect(dsn) as db:
        row = db.execute('SELECT generation FROM tx_policy WHERE project = %s FOR UPDATE', (project,)).fetchone()
        if not row:
            raise Denied('Missing policy')
        if after_lock:
            after_lock()
        db.execute('UPDATE tx_policy SET generation = generation + 1, enabled = false WHERE project = %s', (project,))


def takeover(dsn, job_id, owner):
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        return db.execute('''UPDATE tx_job SET owner = %s, epoch = epoch + 1,
            lease_until = clock_timestamp() + interval '60 seconds'
            WHERE id = %s AND status = 'running' AND lease_until <= clock_timestamp() RETURNING *''',
            (owner, job_id)).fetchone()


def effect(dsn, principal, binding, job_id, owner, epoch, key, payload, *, after_lock=None, before_commit=None):
    if not isinstance(principal, TrustedPrincipal) or not principal.actor or not isinstance(key, str) or not key:
        raise Denied('Invalid trusted fixture principal or key')
    binding_hash, payload_hash = digest(binding), digest(payload)
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        # Global order: policy -> grant -> approval -> job -> effect/key.
        policy = db.execute('SELECT * FROM tx_policy WHERE project = %s FOR UPDATE', (binding['project'],)).fetchone()
        if not policy or not policy['enabled']:
            raise Denied('Policy revoked')
        grant = db.execute('''SELECT * FROM tx_grant WHERE project = %s AND actor = %s AND scope = %s
            FOR UPDATE''', (binding['project'], principal.actor, binding['scope'])).fetchone()
        if not grant or not grant['enabled']:
            raise Denied('Grant revoked')
        approval = db.execute("SELECT * FROM tx_approval WHERE id = 'approval' FOR UPDATE").fetchone()
        if (not approval or approval['project'] != binding['project'] or approval['actor'] != principal.actor or
            approval['scope'] != binding['scope'] or approval['generation'] != policy['generation'] or
            approval['binding_hash'] != binding_hash or approval['decision'] != 'approve'):
            raise Denied('Stale or mismatched approval')
        job = db.execute('''SELECT * FROM tx_job WHERE id = %s AND approval_id = %s AND status = 'running'
            AND owner = %s AND epoch = %s AND lease_until > clock_timestamp() FOR UPDATE''',
            (job_id, approval['id'], owner, epoch)).fetchone()
        if not job:
            raise Denied('Stale or expired job')
        if after_lock:
            after_lock()
        receipt = db.execute('''INSERT INTO tx_effect VALUES (%s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (effect_key) DO NOTHING RETURNING *''',
            (uuid.uuid4(), job_id, key, binding_hash, payload_hash, canonical(payload))).fetchone()
        if not receipt:
            receipt = db.execute('SELECT * FROM tx_effect WHERE effect_key = %s', (key,)).fetchone()
            if (receipt['job_id'] != job_id or receipt['binding_hash'] != binding_hash or
                receipt['payload_hash'] != payload_hash):
                raise Denied('Conflicting effect key')
        if before_commit:
            before_commit()
        return receipt
