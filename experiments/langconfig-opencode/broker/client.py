"""Owned-stdio client for the fake-only broker; not an authorization boundary."""
import json
import subprocess
import threading
from pathlib import Path


class FixtureBrokerClient:
    def __init__(self, node="node"):
        server = Path(__file__).with_name("server.mjs")
        self._process = subprocess.Popen(
            [node, str(server)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
        )
        self._lock = threading.Lock()

    def execute(self, request):
        with self._lock:
            if self._process.poll() is not None:
                raise RuntimeError("fixture broker unavailable; outcome unknown")
            try:
                self._process.stdin.write(json.dumps(request, allow_nan=False) + "\n")
                self._process.stdin.flush()
                line = self._process.stdout.readline()
                if not line:
                    raise RuntimeError("fixture broker unavailable; outcome unknown")
                response = json.loads(line)
                if not isinstance(response, dict) or type(response.get("ok")) is not bool:
                    raise ValueError("invalid response")
                return response
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise RuntimeError("fixture broker unavailable; outcome unknown") from exc

    def close(self):
        with self._lock:
            if self._process.stdin and not self._process.stdin.closed:
                self._process.stdin.close()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()
            if self._process.stdout:
                self._process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
