"""Isolated authorization/receipt experiment, not an authentication boundary."""

from dataclasses import dataclass
import uuid

import psycopg
from psycopg.rows import dict_row


class Denied(Exception):
    pass


@dataclass(frozen=True)
class TrustedPrincipal:
    # Only a trusted test host may construct this; Python cannot enforce that trust.
    actor: str


FIELDS = ('project', 'task', 'graph_version', 'graph_hash', 'checkpoint', 'interrupt', 'action_hash', 'scope', 'policy_version')


def initialize(dsn):
    with psycopg.connect(dsn) as db:
        db.execute('''CREATE TABLE auth_grants (project TEXT NOT NULL, actor TEXT NOT NULL,
            scope TEXT NOT NULL, policy_version TEXT NOT NULL,
            PRIMARY KEY (project, actor, scope, policy_version))''')
        db.execute('''CREATE TABLE auth_requests (id TEXT PRIMARY KEY, project TEXT NOT NULL,
            task TEXT NOT NULL, graph_version TEXT NOT NULL, graph_hash TEXT NOT NULL, checkpoint TEXT NOT NULL,
            interrupt TEXT NOT NULL, action_hash TEXT NOT NULL, scope TEXT NOT NULL,
            policy_version TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL CHECK (status IN ('pending', 'decided', 'invalidated')))''')
        db.execute('''CREATE TABLE auth_receipts (id UUID PRIMARY KEY, request_id TEXT NOT NULL UNIQUE
            REFERENCES auth_requests(id), request_key TEXT NOT NULL UNIQUE, actor TEXT NOT NULL,
            decision TEXT NOT NULL, generation INTEGER NOT NULL, project TEXT NOT NULL,
            task TEXT NOT NULL, graph_version TEXT NOT NULL, graph_hash TEXT NOT NULL, checkpoint TEXT NOT NULL,
            interrupt TEXT NOT NULL, action_hash TEXT NOT NULL, scope TEXT NOT NULL,
            policy_version TEXT NOT NULL)''')


def grant(dsn, project, actor, scope, policy_version):
    with psycopg.connect(dsn) as db:
        db.execute('INSERT INTO auth_grants VALUES (%s, %s, %s, %s)', (project, actor, scope, policy_version))


def create_request(dsn, request_id, binding):
    if set(binding) != set(FIELDS) or not all(isinstance(binding[k], str) and binding[k] for k in FIELDS):
        raise ValueError('Incomplete fixture binding')
    with psycopg.connect(dsn) as db:
        db.execute('''INSERT INTO auth_requests (id, project, task, graph_version, graph_hash, checkpoint,
            interrupt, action_hash, scope, policy_version, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')''',
            (request_id, *(binding[k] for k in FIELDS)))


def authorized(db, principal, binding):
    if not isinstance(principal, TrustedPrincipal) or not principal.actor:
        return False
    return db.execute('''SELECT 1 FROM auth_grants WHERE project = %s AND actor = %s
        AND scope = %s AND policy_version = %s''',
        (binding['project'], principal.actor, binding['scope'], binding['policy_version'])).fetchone() is not None


def matches(row, binding):
    return set(binding) == set(FIELDS) and all(row[k] == binding[k] for k in FIELDS)


def decide(dsn, principal, request_id, binding, decision, key):
    if decision not in ('approve', 'reject') or not isinstance(key, str) or not key:
        raise ValueError('Invalid fixture decision or key')
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        request = db.execute('SELECT * FROM auth_requests WHERE id = %s FOR UPDATE', (request_id,)).fetchone()
        if not request or not matches(request, binding) or request['status'] == 'invalidated':
            raise Denied('Missing or stale request')
        if not authorized(db, principal, request):
            raise Denied('Actor is not authorized')
        receipt = db.execute('SELECT * FROM auth_receipts WHERE request_key = %s', (key,)).fetchone()
        if receipt:
            if (receipt['request_id'] != request_id or receipt['actor'] != principal.actor or
                receipt['decision'] != decision or receipt['generation'] != request['generation'] or
                not matches(receipt, binding)):
                raise Denied('Conflicting idempotency key')
            return receipt
        if request['status'] != 'pending':
            raise Denied('Already decided')
        db.execute("UPDATE auth_requests SET status = 'decided' WHERE id = %s", (request_id,))
        try:
            return db.execute('''INSERT INTO auth_receipts (id, request_id, request_key, actor, decision,
                generation, project, task, graph_version, graph_hash, checkpoint, interrupt, action_hash, scope, policy_version)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *''',
                (uuid.uuid4(), request_id, key, principal.actor, decision, request['generation'],
                 *(binding[k] for k in FIELDS))).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise Denied('Conflicting idempotency key') from exc


def validate(dsn, receipt_id, request_id, binding):
    """Validate committed approval and current grant; callers must handle TOCTOU."""
    with psycopg.connect(dsn, row_factory=dict_row) as db:
        row = db.execute('''SELECT r.*, a.status, a.generation AS current_generation
            FROM auth_receipts r JOIN auth_requests a ON a.id = r.request_id
            WHERE r.id = %s AND a.id = %s AND a.project = r.project AND a.task = r.task
            AND a.graph_version = r.graph_version AND a.graph_hash = r.graph_hash AND a.checkpoint = r.checkpoint
            AND a.interrupt = r.interrupt AND a.action_hash = r.action_hash
            AND a.scope = r.scope AND a.policy_version = r.policy_version''', (receipt_id, request_id)).fetchone()
        if (not row or row['status'] != 'decided' or row['decision'] != 'approve' or
            row['generation'] != row['current_generation'] or not matches(row, binding) or
            not authorized(db, TrustedPrincipal(row['actor']), row)):
            raise Denied('Receipt invalid, stale, rejected or revoked')
        return row


def invalidate(dsn, request_id):
    with psycopg.connect(dsn) as db:
        db.execute("UPDATE auth_requests SET status = 'invalidated', generation = generation + 1 WHERE id = %s", (request_id,))
