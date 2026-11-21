"""Shared helpers for agent adapters: run a CLI with the prompt on stdin and handle its JSON lines as they arrive;
token usage in one shape; transient-error detection; cancel and process-tree kill."""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from typing import Callable


class AgentError(Exception):
    """The agent call failed. `usage` holds the tokens the failed call still used, when the adapter knows them."""

    def __init__(self, msg: str, usage: dict | None = None, cost_usd: float | None = None):
        super().__init__(msg)
        self.usage, self.cost_usd = usage, cost_usd


class AgentCancelled(Exception):
    """The run was cancelled while the agent ran; its process tree is already killed."""


def clean_env() -> dict:
    env = dict(os.environ)
    # Some CLIs (OpenCode) take the project folder from PWD; a stale PWD from the caller's shell points them elsewhere.
    env.pop("PWD", None)
    env.pop("OLDPWD", None)
    # Marks an agent session run by a workflow step: langflow-guard then skips the design-guide reminder, which is
    # for sessions that may write workflows, not for the steps themselves (every word there is paid per turn).
    env["LANGFLOW_STEP"] = "1"
    return env


def brief(inp) -> str:
    """Short text for a tool input in the live log."""
    if not isinstance(inp, dict):
        return str(inp)[:120]
    for k in ("file_path", "path", "pattern", "command", "url", "query"):
        if inp.get(k):
            return f"{k}={str(inp[k])[:150]}"
    return json.dumps(inp, ensure_ascii=False)[:150]


# ---------------------------------------------------------------- cancel context (set by the engine per thread)

CTX = threading.local()


def cancel_check() -> Callable[[], bool] | None:
    """The cancel check of the ai step running in this thread (engine sets CTX.cancelled), or None."""
    return getattr(CTX, "cancelled", None)


def kill_tree(p: subprocess.Popen):
    """Kill a process and everything it started. Windows: taskkill /T /F. Elsewhere: the process group (start the
    process with start_new_session=True, see popen_flags)."""
    if p is None or p.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        else:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001 - fall back to the process itself
        pass
    try:
        if p.poll() is None:
            p.kill()
    except OSError:
        pass


def popen_flags() -> dict:
    """Popen keyword arguments that let kill_tree reach the children."""
    return {} if sys.platform == "win32" else {"start_new_session": True}


class Watch:
    """Watch a running agent every second: cancel (the engine's check) and the step's time limit. On either it calls
    stop() (kill the process tree). After the call, `cancelled` / `expired` say why it stopped."""

    def __init__(self, stop: Callable[[], None], timeout: float | None, check: Callable[[], bool] | None = None):
        self.stop_fn, self.timeout = stop, timeout
        self.check = check if check is not None else cancel_check()
        self.cancelled = self.expired = False
        self._end = threading.Event()
        self._t0 = time.time()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self._end.wait(1.0):
            try:
                if self.check and self.check():
                    self.cancelled = True
            except Exception:  # noqa: BLE001
                pass
            if self.timeout and time.time() - self._t0 > self.timeout:
                self.expired = True
            if self.cancelled or self.expired:
                try:
                    self.stop_fn()
                finally:
                    self._end.set()
                return

    def done(self):
        self._end.set()


# ---------------------------------------------------------------- transient errors

TRANSIENT = re.compile(
    r"rate[ _-]?limit|too many requests|\b429\b|overloaded|"
    r"(?:api error|http|status|error|code)[\s:=\"']*5\d\d\b|\b5\d\d (?:internal|bad gateway|service unavailable|"
    r"gateway timeout)|internal server error|bad gateway|service unavailable|gateway time-?out|"
    r"\btimed? ?out\b|\btimeout\b|connection (?:reset|refused|aborted|closed|error)|econnreset|etimedout|"
    r"econnrefused|socket hang up|network error|temporarily unavailable|try again later", re.I)


def is_transient(text: str) -> bool:
    """True when an agent error looks temporary (rate limit, 429, overloaded, 5xx, timeout, connection reset,
    "temporarily unavailable"): the engine then waits and sends the same prompt again. The step's own time limit
    is not transient (its message avoids the word timeout)."""
    return bool(TRANSIENT.search(str(text or "")))


# ---------------------------------------------------------------- usage

USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")


def _int(v) -> int:
    try:
        return max(0, int(v or 0))
    except (TypeError, ValueError):
        return 0


def usage(input_tokens=0, output_tokens=0, cache_read_tokens=0, cache_write_tokens=0, reasoning_tokens=0) -> dict:
    """Token usage in langflow's shape. input_tokens = input NOT read from the cache (priced at the input price);
    output_tokens include reasoning; reasoning_tokens is shown for information only."""
    return {"input_tokens": _int(input_tokens), "output_tokens": _int(output_tokens),
            "cache_read_tokens": _int(cache_read_tokens), "cache_write_tokens": _int(cache_write_tokens),
            "reasoning_tokens": _int(reasoning_tokens)}


def add_usage(a: dict | None, b: dict | None) -> dict:
    return {k: _int((a or {}).get(k)) + _int((b or {}).get(k)) for k in USAGE_KEYS}


def stream(args: list[str], prompt: str, cwd, env: dict, timeout: int, handle: Callable[[dict], None]) -> tuple[int, str]:
    """Run a CLI, write the prompt to stdin (no shell quoting issues, no length limit), pass each JSON line of stdout
    to handle() as it arrives. Returns (exit code, stderr). Kills the process tree after `timeout` seconds (raises
    AgentError, not transient) or when the run is cancelled (raises AgentCancelled)."""
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
                         env=env, text=True, encoding="utf-8", errors="replace", **popen_flags())
    err: list[str] = []
    t_err = threading.Thread(target=lambda: err.extend(p.stderr), daemon=True)
    t_err.start()
    watch = Watch(lambda: kill_tree(p), timeout)
    try:
        try:
            p.stdin.write(prompt)
            p.stdin.close()
        except OSError:
            pass                                      # the process ended (or was killed) before reading the prompt
        for line in p.stdout:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            try:
                handle(e)
            except Exception:  # noqa: BLE001 - a logging problem must not lose the answer
                pass
        rc = p.wait()
    finally:
        watch.done()
    t_err.join(timeout=5)
    for f in (p.stdout, p.stderr):
        try:
            f.close()
        except OSError:
            pass
    if watch.cancelled:
        raise AgentCancelled("run cancelled while the agent ran (process tree killed)")
    if watch.expired:
        raise AgentError(f"step time limit of {timeout} s reached; agent process tree killed")
    return rc, "".join(err)
