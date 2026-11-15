"""Durable no-resubmit turn journal for the experimental worker."""
import hashlib
import json
import sqlite3
import time
from pathlib import Path

from fake_acceptance import PERMISSIONS, session_model_matches


def execute(worker, directory, workflow, logical_id, sid, model, turn_id, prompt):
    message = 'msg_' + hashlib.sha256((workflow + '\0' + turn_id).encode()).hexdigest()[:24]
    digest = hashlib.sha256(prompt.encode()).hexdigest()
    db = sqlite3.connect(Path(directory) / 'intent.sqlite', timeout=5, isolation_level=None)
    try:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, session TEXT, message TEXT, prompt_hash TEXT, stage TEXT, terminal TEXT)')
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT session,message,prompt_hash,stage,terminal FROM intents WHERE id=?', (turn_id,)).fetchone()
        if existing and existing[:3] != (sid, message, digest):
            raise ValueError('turn identity changed')
        fresh = existing is None
        if fresh:
            db.execute('INSERT INTO intents VALUES(?,?,?,?,?,NULL)', (turn_id, sid, message, digest, 'prompt_intent'))
        db.execute('COMMIT')
        if existing and existing[3] == 'completed':
            return json.loads(existing[4])
        if fresh:
            try:
                receipt = worker.request('POST', f'/api/session/{sid}/prompt', {'id': message, 'text': prompt}, 150)['data']
                if receipt.get('id') != message or receipt.get('sessionID') != sid or receipt.get('type') != 'user':
                    raise ValueError('invalid receipt')
                db.execute('UPDATE intents SET stage=? WHERE id=?', ('admitted', turn_id))
            except Exception:
                # Admission may have succeeded; inspect the timeline and never resubmit.
                pass
        found = []
        for _ in range(20):
            found = [m for m in worker.timeline(sid) if m.get('type') == 'user' and m.get('id') == message]
            if found:
                break
            time.sleep(0.05)
        if len(found) != 1:
            raise ValueError('unknown or ambiguous prompt admission; no retry')
        worker.request('POST', f'/api/experimental/session/{sid}/wait', {}, 150)
        final = worker.request('GET', f'/api/session/{sid}')['data']
        if final.get('outcome') != 'succeeded':
            messages = worker.timeline(sid)
            errors = json.dumps([m.get('error') for m in messages if m.get('type') == 'assistant' and m.get('error')]).lower()
            category = next((name for name, markers in (('auth', ('401', 'unauthorized', 'authentication')), ('quota', ('429', 'quota', 'rate limit', 'free usage limit')), ('payment', ('402', 'payment required', 'insufficient credits')), ('provider', ('no endpoints', 'no endpoint', 'provider'))) if any(marker in errors for marker in markers)), 'unknown')
            (Path(directory) / 'turn-status.json').write_text(json.dumps({'outcome': final.get('outcome'), 'errorCategory': category}))
            raise ValueError('session did not succeed')
        if (not session_model_matches(final.get('model'), model) or final.get('permissions') != PERMISSIONS
                or Path(final['location']['directory']).resolve() != worker.workspace or final.get('agent') != 'build'
                or final.get('metadata', {}).get('neomindSession') != logical_id):
            raise ValueError('session did not succeed')
        messages = worker.timeline(sid)
        positions = [i for i, m in enumerate(messages) if m.get('type') == 'user' and m.get('id') == message]
        if len(positions) != 1 or any(m.get('type') == 'user' for m in messages[positions[0] + 1:]):
            raise ValueError('ambiguous prompt')
        reply = [m for m in messages[positions[0] + 1:] if m.get('type') == 'assistant'][-1]
        if reply.get('model') != model or reply.get('agent') != 'build' or reply.get('finish') != 'stop' or reply.get('error'):
            raise ValueError('unverified assistant reply')
        tokens = reply.get('tokens')
        cost = reply.get('cost')
        (Path(directory) / 'turn-status.json').write_text(json.dumps({'outcome': 'succeeded', 'requestedModel': model, 'assistantModel': reply['model'],
            'routedModel': None, 'tokens': tokens if isinstance(tokens, dict) else None, 'cost': cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None}))
        texts = [p['text'] for p in reply.get('content', []) if p.get('type') == 'text' and p.get('text')]
        if len(texts) != 1:
            raise ValueError('ambiguous output')
        db.execute('UPDATE intents SET stage=?,terminal=? WHERE id=?', ('completed', json.dumps(texts), turn_id))
        return texts
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()
