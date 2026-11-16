"""Monitor a synthetic PostgreSQL policy; never an authority for production."""
import json
import os
import time

import psycopg


try:
    with psycopg.connect(os.environ['FIXTURE_DSN'], autocommit=True) as db:
        print(json.dumps({'event': 'ready'}), flush=True)
        while True:
            row = db.execute('SELECT enabled, generation FROM unified_policy WHERE project = %s', ('fixture',)).fetchone()
            if row != (True, 1):
                print(json.dumps({'event': 'revoked'}), flush=True)
                break
            print(json.dumps({'event': 'heartbeat'}), flush=True)
            time.sleep(0.05)
except psycopg.Error:
    print(json.dumps({'event': 'unavailable'}), flush=True)
