"""Fail-closed identity experiment; deliberately not a production resume service."""

import json
import hashlib
from typing import TypedDict

import psycopg
from psycopg.rows import dict_row
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

import postgres_prototype as app


class State(TypedDict, total=False):
    task_id: str
    result: str


class Mismatch(Exception):
    pass


def graph(saver, on_action=None):
    def gate(state):
        decision = interrupt({'task_id': state['task_id'], 'kind': 'fixture_gate'})
        if decision not in ('approve', 'reject'):
            raise ValueError('Invalid fixture decision')
        if on_action:
            on_action()
        return {'result': decision}
    builder = StateGraph(State)
    builder.add_node('gate', gate)
    builder.add_edge(START, 'gate')
    builder.add_edge('gate', END)
    return builder.compile(checkpointer=saver)


def config(thread):
    return {'configurable': {'thread_id': thread}}


def identity(snapshot, thread, task_id):
    interrupts = [item for task in snapshot.tasks for item in task.interrupts]
    if (not snapshot.next or len(interrupts) != 1 or
        snapshot.values.get('task_id') != task_id or
        interrupts[0].value != {'task_id': task_id, 'kind': 'fixture_gate'}):
        raise Mismatch('Not the expected pending interrupt')
    cfg = snapshot.config['configurable']
    if cfg['thread_id'] != thread or cfg.get('checkpoint_ns', '') != '':
        raise Mismatch('Unexpected checkpoint namespace or thread')
    return json.dumps({'thread': thread, 'checkpoint_id': cfg['checkpoint_id'],
                       'interrupt_id': interrupts[0].id}, sort_keys=True, separators=(',', ':'))


def pause(dsn, thread, task_id):
    with PostgresSaver.from_conn_string(dsn) as saver:
        saver.setup()
        g = graph(saver)
        g.invoke({'task_id': task_id}, config(thread))
        return identity(g.get_state(config(thread)), thread, task_id)


def register(dsn, approval_id, task_id, checkpoint_identity):
    app.create_approval(dsn, approval_id, task_id, checkpoint_identity)


def resume(dsn, thread, task_id, approval_id, job_id, owner, epoch, *,
           after_admission=None, on_action=None):
    """Cooperative session lock around admission, checkpoint check and resume.

    Session loss releases the lock; it cannot fence a still-running graph or effects.
    """
    key = int.from_bytes(hashlib.sha256(('approval-fixture:' + thread).encode()).digest()[:8],
                         'big', signed=True)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as db:
        if not db.execute('SELECT pg_try_advisory_lock(%s) AS acquired', (key,)).fetchone()['acquired']:
            raise Mismatch('Thread is locked')
        try:
            return _resume_locked(db, dsn, thread, task_id, approval_id, job_id, owner, epoch,
                                  after_admission, on_action)
        finally:
            db.execute('SELECT pg_advisory_unlock(%s)', (key,))


def _resume_locked(db, dsn, thread, task_id, approval_id, job_id, owner, epoch,
                   after_admission, on_action):
    row = db.execute('''SELECT r.* FROM receipts r JOIN jobs j ON j.receipt_id = r.id
        JOIN approvals a ON a.id = r.approval_id
        WHERE j.id = %s AND j.status = 'running' AND a.status = 'decided'
          AND j.owner = %s AND j.epoch = %s AND j.lease_until > clock_timestamp()
          AND a.task_id = r.task_id AND a.checkpoint = r.checkpoint AND a.version = r.version''',
        (job_id, owner, epoch)).fetchone()
    if not row or row['approval_id'] != approval_id or row['task_id'] != task_id:
        raise Mismatch('Receipt/job/task/lease mismatch')
    with PostgresSaver.from_conn_string(dsn) as saver:
        g = graph(saver, on_action)
        snapshot = g.get_state(config(thread))
        if identity(snapshot, thread, task_id) != row['checkpoint']:
            raise Mismatch('Receipt does not match current checkpoint')
        if after_admission:
            after_admission()
        return g.invoke(Command(resume=row['decision']), config(thread))
