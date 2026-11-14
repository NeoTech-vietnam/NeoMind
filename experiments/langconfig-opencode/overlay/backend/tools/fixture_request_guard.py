"""A fake-dispatch quota primitive, not connected to OpenCode's provider transport."""
import sqlite3
from pathlib import Path


class FixtureRequestGuard:
    def __init__(self, path: Path, limit: int = 40):
        if not 1 <= limit <= 40:
            raise ValueError("invalid limit")
        self.path = path
        self.limit = limit
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS dispatches (id INTEGER PRIMARY KEY, kind TEXT NOT NULL)")

    def admit(self, provider: str, model: str, variant: str, kind: str, transport: str):
        if (provider, model, variant, transport) != ("opencode", "deepseek-v4.1-flash-free", "high", "http"):
            raise ValueError("dispatch rejected")
        if kind not in ("primary", "retry", "title", "compaction", "generate"):
            raise ValueError("unknown dispatch kind")
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT count(*) FROM dispatches").fetchone()[0]
            if count >= self.limit:
                raise ValueError("request budget exhausted")
            db.execute("INSERT INTO dispatches(kind) VALUES (?)", (kind,))
            return count + 1
