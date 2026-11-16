"""Fixture-only durable admission, not a production authorization or execution service."""
from dataclasses import dataclass
import hashlib
import json
import re
import secrets
import sqlite3


_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
_RUNNERS = frozenset(("codex", "claude-code", "opencode"))


@dataclass(frozen=True)
class FixtureGrant:
    """Constructed by trusted fixture code, never decoded from a node request."""
    task_id: str
    runner: str

    def __post_init__(self):
        if not isinstance(self.task_id, str) or not _ID.fullmatch(self.task_id) or self.runner not in _RUNNERS:
            raise ValueError("invalid fixture grant")


def _payload(grant, request):
    if type(grant) is not FixtureGrant or type(request) is not dict or set(request) != {"version", "taskId", "attemptId", "binding", "prompt"}:
        raise ValueError("invalid_request")
    binding = request["binding"]
    if (type(request["version"]) is not int or request["version"] != 1 or request["taskId"] != grant.task_id
            or not isinstance(request["attemptId"], str) or not _ID.fullmatch(request["attemptId"])
            or type(binding) is not dict or binding != {"runner": grant.runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}
            or type(request["prompt"]) is not str or not request["prompt"].startswith("fixture:") or len(request["prompt"]) > 1024):
        raise ValueError("invalid_request")
    encoded = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


class FixtureAdmission:
    def __init__(self, database_path, grant):
        if type(grant) is not FixtureGrant:
            raise ValueError("trusted fixture grant required")
        self.grant = grant
        self.db = sqlite3.connect(database_path, timeout=10, isolation_level=None)
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS fixture_attempts (
            task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('reserved', 'completed')),
            owner_token TEXT NOT NULL, result TEXT,
            PRIMARY KEY(task_id, attempt_id),
            CHECK((state = 'reserved' AND result IS NULL) OR (state = 'completed' AND result IS NOT NULL))
        )""")

    def admit(self, request):
        try:
            digest = _payload(self.grant, request)
        except (ValueError, TypeError):
            return {"status": "denied"}
        task, attempt = request["taskId"], request["attemptId"]
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT payload_hash, state, result FROM fixture_attempts WHERE task_id=? AND attempt_id=?", (task, attempt)).fetchone()
            if row is None:
                token = secrets.token_hex(32)
                self.db.execute("INSERT INTO fixture_attempts VALUES (?, ?, ?, 'reserved', ?, NULL)", (task, attempt, digest, token))
                response = {"status": "admitted", "token": token, "payloadHash": digest}
            elif row[0] != digest:
                response = {"status": "conflict"}
            elif row[1] == "completed":
                response = {"status": "completed", "result": json.loads(row[2])}
            else:
                response = {"status": "unknown"}
            self.db.execute("COMMIT")
            return response
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def complete(self, request, token, result):
        try:
            digest = _payload(self.grant, request)
            if type(token) is not str or not re.fullmatch(r"[0-9a-f]{64}", token):
                return False
            # Results are intentionally restricted to inert, bounded fixture text.
            if type(result) is not str or not result.startswith("fixture:") or len(result) > 1024:
                return False
            value = json.dumps(result, ensure_ascii=True)
        except (ValueError, TypeError):
            return False
        self.db.execute("BEGIN IMMEDIATE")
        try:
            cursor = self.db.execute("""UPDATE fixture_attempts SET state='completed', result=?
                WHERE task_id=? AND attempt_id=? AND payload_hash=? AND owner_token=? AND state='reserved'""",
                (value, request["taskId"], request["attemptId"], digest, token))
            self.db.execute("COMMIT")
            return cursor.rowcount == 1
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def close(self):
        self.db.close()
