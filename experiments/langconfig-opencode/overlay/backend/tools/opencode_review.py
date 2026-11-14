"""Experiment-only read-only OpenCode review adapter. Live model dispatch stays disabled."""
import json
import hashlib
import re
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import quote
from pathlib import Path
from typing import Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, Field

MODEL = {"providerID": "opencode", "id": "deepseek-v4.1-flash-free", "variant": "high"}
PERMISSIONS = [{"action": "*", "resource": "*", "effect": "deny"}]


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    description: str = Field(min_length=1, max_length=2000)
    path: str = Field(min_length=1, max_length=500)


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    verdict: Literal["pass", "needs_changes"]
    findings: list[Finding]
    summary: str = Field(min_length=1, max_length=4000)


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attempt_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    instruction: str = Field(min_length=1, max_length=12000)


class ReviewError(RuntimeError):
    pass


class Adapter:
    def __init__(self, transport, workspace: Path, database: Path, *, fixture_root: Path | None = None, model=None):
        self.transport = transport
        self.workspace = workspace.resolve(strict=True)
        root = (fixture_root or workspace).resolve(strict=True)
        if not self.workspace.is_relative_to(root):
            raise ReviewError("workspace outside fixture root")
        self.model = model or MODEL
        if self.model != MODEL and self.model != {"providerID": "fixture", "id": "fake-review", "variant": "high"}:
            raise ReviewError("model not permitted")
        if getattr(transport, "fixture_only", False) and self.model != {"providerID": "fixture", "id": "fake-review", "variant": "high"}:
            raise ReviewError("HTTP transport only permits the local fake model until live guard is verified")
        self.database = database
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, instruction TEXT NOT NULL, stage TEXT NOT NULL, session TEXT, receipt TEXT)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(attempts)")}
            for column in ("prompt_id", "terminal"):
                if column not in columns:
                    db.execute(f"ALTER TABLE attempts ADD COLUMN {column} TEXT")

    def _set(self, attempt, stage, **values):
        fields = {"stage": stage, **values}
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE attempts SET " + ", ".join(f"{key}=?" for key in fields) + " WHERE id=?", [*fields.values(), attempt])

    def _row(self, attempt):
        with sqlite3.connect(self.database) as db:
            db.row_factory = sqlite3.Row
            return db.execute("SELECT * FROM attempts WHERE id=?", (attempt,)).fetchone()

    def _verify(self, response, sid=None, attempt=None):
        data = response["data"]
        if (not re.fullmatch(r"ses_[A-Za-z0-9]+", data["id"]) or (sid is not None and data["id"] != sid)
                or data.get("parentID") or data.get("agent") != "build" or data.get("model") != self.model
                or Path(data["location"]["directory"]).resolve() != self.workspace
                or data.get("permissions") != PERMISSIONS or data.get("title") != "Fixture review"
                or (attempt is not None and data.get("metadata", {}).get("fixtureAttempt") != attempt)):
            raise ReviewError("session identity, model, workspace, title or permissions mismatch")
        return data

    async def start(self, attempt_id: str, instruction: str):
        ReviewInput(attempt_id=attempt_id, instruction=instruction)
        try:
            with sqlite3.connect(self.database) as db:
                db.execute("INSERT INTO attempts (id,workspace,instruction,stage) VALUES (?,?,?,?)", (attempt_id, str(self.workspace), instruction, "create_intent"))
        except sqlite3.IntegrityError as exc:
            raise ReviewError("attempt already exists; reconcile without resubmitting") from exc
        try:
            created = await self.transport.request("POST", "/api/session", {"title": "Fixture review", "agent": "build", "model": self.model, "location": {"directory": str(self.workspace)}, "permissions": PERMISSIONS, "metadata": {"fixtureAttempt": attempt_id}})
            sid = self._verify(created, attempt=attempt_id)["id"]
            self._set(attempt_id, "session_created", session=sid)
            self._verify(await self.transport.request("GET", f"/api/session/{sid}"), sid, attempt_id)
            prompt_id = "msg_" + hashlib.sha256((str(self.workspace) + "\0" + attempt_id).encode()).hexdigest()[:24]
            self._set(attempt_id, "prompt_intent", prompt_id=prompt_id)
            prompt = instruction + '\nReturn exactly JSON: {"verdict":"pass|needs_changes","findings":[{"description":"...","path":"..."}],"summary":"..."}. Read only.'
            receipt = (await self.transport.request("POST", f"/api/session/{sid}/prompt", {"id": prompt_id, "text": prompt}))["data"]
            if receipt.get("sessionID") != sid or receipt.get("type") != "user" or receipt.get("id") != prompt_id:
                raise ReviewError("invalid prompt receipt")
            self._set(attempt_id, "admitted", receipt=receipt["id"])
        except BaseException:
            # The last committed intent remains authoritative when the outcome is unknown.
            raise
        return await self.reconcile(attempt_id)

    async def reconcile(self, attempt_id: str):
        row = self._row(attempt_id)
        if row and row["workspace"] != str(self.workspace):
            raise ReviewError("attempt belongs to another workspace")
        if row and row["stage"] == "completed" and row["terminal"]:
            return json.loads(row["terminal"])
        if not row or row["workspace"] != str(self.workspace) or not row["session"] or not (row["receipt"] or row["prompt_id"]):
            raise ReviewError("unknown dispatch outcome; no automatic retry")
        sid = row["session"]
        await self.transport.request("POST", f"/api/experimental/session/{sid}/wait", {})
        data = self._verify(await self.transport.request("GET", f"/api/session/{sid}"), sid, attempt_id)
        if data.get("outcome") != "succeeded":
            raise ReviewError("session not confirmed successful")
        msgs, cursors = [], set()
        query = "?order=asc"
        for _ in range(100):
            page = await self.transport.request("GET", f"/api/session/{sid}/message{query}")
            msgs.extend(page["data"])
            cursor = page.get("cursor", {}).get("next")
            if not cursor:
                break
            if cursor in cursors or len(msgs) > 10000:
                raise ReviewError("ambiguous or oversized timeline")
            cursors.add(cursor)
            query = "?cursor=" + quote(cursor, safe="")
        else:
            raise ReviewError("timeline page limit exceeded")
        matches = [i for i, m in enumerate(msgs) if m.get("id") == (row["receipt"] or row["prompt_id"]) and m.get("type") == "user"]
        if len(matches) != 1:
            raise ReviewError("receipt missing or ambiguous")
        later = msgs[matches[0]+1:]
        if any(m.get("type") == "user" for m in later):
            raise ReviewError("unexpected later prompt")
        replies = [m for m in later if m.get("type") == "assistant"]
        if not replies:
            raise ReviewError("assistant result missing")
        reply = replies[-1]
        if reply.get("error") or reply.get("finish") != "stop" or reply.get("agent") != "build" or reply.get("model") != self.model:
            raise ReviewError("assistant identity or finish mismatch")
        texts = [p.get("text") for p in reply.get("content", []) if p.get("type") == "text"]
        if len(texts) != 1:
            raise ReviewError("ambiguous review output")
        try:
            review = Review.model_validate_json(texts[0])
        except Exception as exc:
            raise ReviewError("invalid review JSON or schema") from exc
        if (review.verdict == "pass") != (not review.findings):
            raise ReviewError("verdict and findings are inconsistent")
        result = {"status": "completed", "session_id": sid, **review.model_dump()}
        self._set(attempt_id, "completed", terminal=json.dumps(result))
        return result

    async def interrupt(self, attempt_id: str):
        row = self._row(attempt_id)
        if not row or not row["session"]:
            raise ReviewError("no known session to interrupt")
        response = await self.transport.request("POST", f"/api/session/{row['session']}/interrupt?resume=false", {})
        self._set(attempt_id, "interrupt_requested")
        return {"interrupt_response": response, "stopped_verified": False}


_adapter = ContextVar("fixture_opencode_adapter", default=None)


@contextmanager
def review_runtime(adapter):
    """Bind one trusted fixture adapter to the current async execution context."""
    token = _adapter.set(adapter)
    try:
        yield
    finally:
        _adapter.reset(token)


def install_test_adapter(adapter):
    """Install a fake transport in an isolated test process, never from workflow input."""
    _adapter.set(adapter)


async def _review(attempt_id: str, instruction: str) -> str:
    adapter = _adapter.get()
    if adapter is None:
        raise ReviewError("OpenCode review unavailable: real transport and quota guard not enabled")
    return json.dumps(await adapter.start(attempt_id, instruction))


opencode_review = StructuredTool.from_function(coroutine=_review, name="opencode_review", description="Read-only fixture review through a verified OpenCode session.", args_schema=ReviewInput)
