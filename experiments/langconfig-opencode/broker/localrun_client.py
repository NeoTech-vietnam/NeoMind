"""Test-only owner for a fixed-grant LocalRun host, not a production admission API."""
import json
import os
from pathlib import Path
import subprocess


class LocalRunFixtureClient:
    def __init__(self, runner, source, *, test_counter=None, test_hold=False, test_tmpdir=None):
        if runner not in ("codex", "claude-code", "opencode") or not os.path.isabs(source):
            raise ValueError("invalid fixture host configuration")
        env = {"PATH": "/usr/bin:/bin", "HOME": "/dev/null", "LANG": "C.UTF-8", "TMPDIR": "/dev/shm",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "file"}
        if test_counter is not None:
            if not test_tmpdir or not Path(test_tmpdir).is_absolute() or Path(test_counter).parent != Path(test_tmpdir):
                raise ValueError("fixture counter must be inside the test directory")
            env.update({"TMPDIR": test_tmpdir, "FIXTURE_TEST_COUNTER": test_counter})
            if test_hold:
                env["FIXTURE_TEST_HOLD"] = "1"
        elif test_hold or test_tmpdir:
            raise ValueError("test hook requires a fixture counter")
        self._process = subprocess.Popen(["node", str(Path(__file__).with_name("localrun-host.mjs")), runner, source],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         text=True, encoding="utf-8", env=env)

    def execute(self, request):
        try:
            self._process.stdin.write(json.dumps(request, allow_nan=False) + "\n")
            self._process.stdin.flush()
            line = self._process.stdout.readline()
            if not line:
                raise RuntimeError("fixture host outcome unknown")
            response = json.loads(line)
            if not isinstance(response, dict) or type(response.get("ok")) is not bool:
                raise ValueError("invalid fixture response")
            return response
        except (OSError, ValueError) as exc:
            raise RuntimeError("fixture host outcome unknown") from exc

    def close(self):
        self._process.stdin.close()
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()
        self._process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
