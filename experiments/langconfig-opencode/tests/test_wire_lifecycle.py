"""Exercise fixture cleanup without starting OpenCode or any model process."""
import importlib.util
import signal
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest


SPEC = importlib.util.spec_from_file_location(
    "fixture_wire_run", Path(__file__).resolve().parents[1] / "wire" / "run.py"
)
wire = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wire)


def test_stop_also_signals_group_after_leader_has_exited(monkeypatch):
    process = Mock(pid=12345)
    process.poll.return_value = 0
    signals = []
    monkeypatch.setattr(wire.os, "killpg", lambda pid, sig: signals.append((pid, sig)))
    wire.stop(process)
    assert signals == [(12345, signal.SIGTERM), (12345, signal.SIGKILL)]


def test_stop_escalates_after_wait_timeout(monkeypatch):
    process = Mock(pid=12345)
    process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 10), 0]
    signals = []
    monkeypatch.setattr(wire.os, "killpg", lambda pid, sig: signals.append(sig))
    wire.stop(process)
    assert signals == [signal.SIGTERM, signal.SIGKILL]


def test_cleanup_attempts_both_processes_on_failure(monkeypatch):
    stopped = []

    def stop(process):
        stopped.append(process)
        if process == "server":
            raise PermissionError("fixture failure")

    monkeypatch.setattr(wire, "stop", stop)
    with pytest.raises(RuntimeError, match="owned fixture process"):
        wire.cleanup("server", "upstream")
    assert stopped == ["server", "upstream"]


def test_sigterm_enters_python_cleanup_path():
    with pytest.raises(SystemExit) as result:
        wire.terminate(signal.SIGTERM, None)
    assert result.value.code == 128 + signal.SIGTERM
