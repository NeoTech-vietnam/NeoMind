"""Fixture-only PostgreSQL lock monitor, reporting loss to its owned parent."""
import json
import os
import time

import psycopg


try:
    with psycopg.connect(os.environ['FIXTURE_DSN'], autocommit=True) as db:
        db.execute('SELECT pg_advisory_lock(137702)')
        print(json.dumps({'event': 'ready', 'pid': db.info.backend_pid}), flush=True)
        while True:
            time.sleep(0.05)
            db.execute('SELECT 1')
            print(json.dumps({'event': 'heartbeat'}), flush=True)
except psycopg.Error:
    print(json.dumps({'event': 'lost'}), flush=True)
