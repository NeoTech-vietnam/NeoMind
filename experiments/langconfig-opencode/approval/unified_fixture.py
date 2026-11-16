"""Unified PostgreSQL authority with a separate LangGraph saver; fixture only."""

from dataclasses import dataclass
import hashlib
import json
import uuid

import psycopg
from psycopg.rows import dict_row
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import Command

import langgraph_fixture as lg


class Denied(Exception):
    pass


@dataclass(frozen=True)
class TrustedPrincipal:
    actor: str  # Supplied by trusted fixture host, not authenticated here.


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def setup(dsn, binding):
    with psycopg.connect(dsn) as db:
        db.execute('''CREATE TABLE unified_policy (project TEXT PRIMARY KEY, generation BIGINT NOT NULL, enabled BOOLEAN NOT NULL)''')
        db.execute('''CREATE TABLE unified_grant (project TEXT NOT NULL, actor TEXT NOT NULL, scope TEXT NOT NULL,
            enabled BOOLEAN NOT NULL, PRIMARY KEY(project, actor, scope))''')
        db.execute('''CREATE TABLE unified_request (id TEXT PRIMARY KEY, project TEXT NOT NULL, scope TEXT NOT NULL,
            task TEXT NOT NULL, checkpoint TEXT NOT NULL, binding_hash TEXT NOT NULL, generation BIGINT NOT NULL,
            status TEXT NOT NULL)''')
        db.execute('''CREATE TABLE unified_receipt (id UUID PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES unified_request(id),
            actor TEXT NOT NULL, decision TEXT NOT NULL, generation BIGINT NOT NULL, binding_hash TEXT NOT NULL)''')
        db.execute('''CREATE TABLE unified_job (id UUID PRIMARY KEY, receipt_id UUID NOT NULL UNIQUE REFERENCES unified_receipt(id),
            owner TEXT, epoch BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ, status TEXT NOT NULL)''')
        db.execute('''CREATE TABLE unified_effect (id UUID PRIMARY KEY, receipt_id UUID NOT NULL REFERENCES unified_receipt(id),
            effect_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL)''')
        db.execute('''CREATE TABLE unified_completion (receipt_id UUID PRIMARY KEY REFERENCES unified_receipt(id),
            effect_id UUID NOT NULL REFERENCES unified_effect(id), thread TEXT NOT NULL, checkpoint_id TEXT NOT NULL)''')
        db.execute('INSERT INTO unified_policy VALUES (%s, 1, true)', (binding['project'],))
        db.execute("INSERT INTO unified_grant VALUES (%s, 'alice', %s, true)", (binding['project'], binding['scope']))
        db.execute("INSERT INTO unified_request VALUES ('request', %s, %s, %s, %s, %s, 1, 'pending')",
                   (binding['project'], binding['scope'], binding['task'], binding['checkpoint'], digest(binding)))


def decide(dsn, principal, binding, decision):
    if not isinstance(principal, TrustedPrincipal) or not principal.actor or decision not in ('approve', 'reject'):
        raise Denied('Invalid principal or decision')
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        # Fixed order for authority: policy -> grant -> request -> receipt -> job -> effect.
        policy = db.execute('SELECT * FROM unified_policy WHERE project = %s FOR UPDATE', (binding['project'],)).fetchone()
        grant = db.execute('SELECT * FROM unified_grant WHERE project = %s AND actor = %s AND scope = %s FOR UPDATE',
                           (binding['project'], principal.actor, binding['scope'])).fetchone()
        req = db.execute("SELECT * FROM unified_request WHERE id = 'request' FOR UPDATE").fetchone()
        if (not policy or not policy['enabled'] or not grant or not grant['enabled'] or not req or
            req['status'] != 'pending' or req['generation'] != policy['generation'] or
            req['binding_hash'] != digest(binding)):
            raise Denied('Decision not authorized or stale')
        receipt_id, job_id = uuid.uuid4(), uuid.uuid4()
        db.execute("UPDATE unified_request SET status = 'decided' WHERE id = 'request'")
        db.execute("INSERT INTO unified_receipt VALUES (%s, 'request', %s, %s, %s, %s)",
                   (receipt_id, principal.actor, decision, policy['generation'], digest(binding)))
        db.execute("INSERT INTO unified_job (id, receipt_id, status) VALUES (%s, %s, 'pending')", (job_id, receipt_id))
        return receipt_id, job_id


def claim(dsn, job_id, owner):
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        return db.execute("""UPDATE unified_job SET owner = %s, epoch = epoch + 1,
            lease_until = clock_timestamp() + interval '60 seconds', status = 'running'
            WHERE id = %s AND status = 'pending' RETURNING *""", (owner, job_id)).fetchone()


def revoke(dsn, project):
    with psycopg.connect(dsn) as db:
        db.execute('UPDATE unified_policy SET enabled = false, generation = generation + 1 WHERE project = %s', (project,))


def _check(db, binding, receipt_id, job_id, owner, epoch, expected_status):
    policy = db.execute('SELECT * FROM unified_policy WHERE project = %s FOR UPDATE', (binding['project'],)).fetchone()
    # Lookup actor without locking; immutable receipt is verified/locked below.
    actor_row = db.execute('SELECT actor FROM unified_receipt WHERE id = %s', (receipt_id,)).fetchone()
    if not policy or not policy['enabled'] or not actor_row:
        raise Denied('Policy or receipt unavailable')
    grant = db.execute('SELECT * FROM unified_grant WHERE project = %s AND actor = %s AND scope = %s FOR UPDATE',
                       (binding['project'], actor_row['actor'], binding['scope'])).fetchone()
    req = db.execute("SELECT * FROM unified_request WHERE id = 'request' FOR UPDATE").fetchone()
    receipt = db.execute('SELECT * FROM unified_receipt WHERE id = %s FOR UPDATE', (receipt_id,)).fetchone()
    job = db.execute('SELECT * FROM unified_job WHERE id = %s FOR UPDATE', (job_id,)).fetchone()
    if (not grant or not grant['enabled'] or not req or not receipt or not job or
        req['project'] != binding['project'] or req['scope'] != binding['scope'] or
        req['task'] != binding['task'] or req['checkpoint'] != binding['checkpoint'] or
        req['binding_hash'] != digest(binding) or req['status'] != 'decided' or
        req['generation'] != policy['generation'] or receipt['generation'] != policy['generation'] or
        receipt['request_id'] != req['id'] or receipt['actor'] != actor_row['actor'] or
        receipt['binding_hash'] != digest(binding) or receipt['decision'] != 'approve' or
        job['receipt_id'] != receipt_id or job['status'] != expected_status or
        job['owner'] != owner or job['epoch'] != epoch or
        not db.execute('SELECT %s::timestamptz > clock_timestamp() AS live', (job['lease_until'],)).fetchone()['live']):
        raise Denied('Authority, binding or job stale')


def admission(dsn, binding, receipt_id, job_id, owner, epoch):
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        _check(db, binding, receipt_id, job_id, owner, epoch, 'running')
        db.execute("UPDATE unified_job SET status = 'dispatched' WHERE id = %s", (job_id,))


def revalidate_dispatched(dsn, binding, receipt_id, job_id, owner, epoch):
    """Fixture-only authority check; transaction ends before any external action."""
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        _check(db, binding, receipt_id, job_id, owner, epoch, 'dispatched')


def _effect_on_connection(db, binding, receipt_id, job_id, owner, epoch, *, before_commit=None):
    payload_hash = digest({'action_hash': binding['action_hash']})
    key = digest({'receipt': str(receipt_id), 'action': binding['action_hash']})
    _check(db, binding, receipt_id, job_id, owner, epoch, 'dispatched')
    row = db.execute('''INSERT INTO unified_effect VALUES (%s, %s, %s, %s)
        ON CONFLICT(effect_key) DO NOTHING RETURNING *''', (uuid.uuid4(), receipt_id, key, payload_hash)).fetchone()
    if not row:
        row = db.execute('SELECT * FROM unified_effect WHERE effect_key = %s', (key,)).fetchone()
        if row['receipt_id'] != receipt_id or row['payload_hash'] != payload_hash:
            raise Denied('Effect key conflict')
    if before_commit:
        before_commit()
    return row


def effect(dsn, binding, receipt_id, job_id, owner, epoch, *, before_commit=None):
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        return _effect_on_connection(db, binding, receipt_id, job_id, owner, epoch, before_commit=before_commit)


def resume(dsn, thread, binding, receipt_id, job_id, owner, epoch, *, before_effect_commit=None, after_effect=None, after_admission=None, before_completion=None, bind_sink=True):
    key = int.from_bytes(hashlib.sha256(('unified-fixture:' + thread).encode()).digest()[:8], 'big', signed=True)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as lock:
        if not lock.execute('SELECT pg_try_advisory_lock(%s) AS ok', (key,)).fetchone()['ok']:
            raise Denied('Thread locked')
        try:
            admission(dsn, binding, receipt_id, job_id, owner, epoch)
            if after_admission:
                after_admission(lock.info.backend_pid)
            with psycopg.connect(dsn) as db:
                if db.execute('SELECT 1 FROM unified_effect WHERE receipt_id = %s', (receipt_id,)).fetchone():
                    raise Denied('Existing effect requires reconciliation, not replay')
            with PostgresSaver.from_conn_string(dsn) as saver:
                def action():
                    if bind_sink:
                        # A DB sink on this session cannot commit after the lock session is lost.
                        with lock.transaction():
                            _effect_on_connection(lock, binding, receipt_id, job_id, owner, epoch, before_commit=before_effect_commit)
                    else:
                        effect(dsn, binding, receipt_id, job_id, owner, epoch, before_commit=before_effect_commit)
                    if after_effect:
                        after_effect()
                g = lg.graph(saver, action)
                if lg.identity(g.get_state(lg.config(thread)), thread, binding['task']) != binding['checkpoint']:
                    raise Denied('Checkpoint mismatch')
                result = g.invoke(Command(resume='approve'), lg.config(thread))
                snapshot = g.get_state(lg.config(thread))
                if (snapshot.next or snapshot.values.get('task_id') != binding['task'] or
                        snapshot.values.get('result') != 'approve' or
                        snapshot.config['configurable'].get('thread_id') != thread):
                    raise Denied('Completion checkpoint mismatch')
                checkpoint_id = snapshot.config['configurable'].get('checkpoint_id')
                if not isinstance(checkpoint_id, str) or not checkpoint_id:
                    raise Denied('Completion checkpoint missing')
                if before_completion:
                    before_completion()
                with lock.transaction():
                    _check(lock, binding, receipt_id, job_id, owner, epoch, 'dispatched')
                    effect_row = lock.execute('SELECT id FROM unified_effect WHERE receipt_id = %s', (receipt_id,)).fetchone()
                    if not effect_row:
                        raise Denied('Completion effect missing')
                    lock.execute('INSERT INTO unified_completion VALUES (%s, %s, %s, %s)',
                                 (receipt_id, effect_row['id'], thread, checkpoint_id))
                return result
        finally:
            lock.execute('SELECT pg_advisory_unlock(%s)', (key,))


def reconcile(dsn, thread, binding, receipt_id):
    """Read only; no graph invocation or effect retry, including for unknown."""
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        effects = db.execute('''SELECT e.*, c.thread AS completion_thread, c.checkpoint_id AS completion_checkpoint
            FROM unified_effect e JOIN unified_completion c ON c.effect_id = e.id AND c.receipt_id = e.receipt_id
            JOIN unified_receipt r ON r.id = e.receipt_id
            JOIN unified_request q ON q.id = r.request_id WHERE r.id = %s AND r.binding_hash = %s
            AND q.binding_hash = r.binding_hash AND e.effect_key = %s AND e.payload_hash = %s''',
            (receipt_id, digest(binding), digest({'receipt': str(receipt_id), 'action': binding['action_hash']}),
             digest({'action_hash': binding['action_hash']}))).fetchall()
    with PostgresSaver.from_conn_string(dsn) as saver:
        snapshot = lg.graph(saver).get_state(lg.config(thread))
    if (json.loads(binding['checkpoint'])['thread'] == thread and len(effects) == 1 and not snapshot.next and
        effects[0]['completion_thread'] == thread and
        effects[0]['completion_checkpoint'] == snapshot.config['configurable'].get('checkpoint_id') and
        snapshot.values.get('task_id') == binding['task'] and snapshot.values.get('result') == 'approve'):
        return 'observed_complete'
    return 'unknown'
