"""Cross-process crash during a fake LocalRun dispatch; no replay after restart."""
import multiprocessing
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest

from durable_localrun_client import DurableLocalRunFixtureClient
from localrun_client import LocalRunFixtureClient


def request(runner):
    return {"version": 1, "taskId": "fixture-task", "prompt": "synthetic fixture only",
            "binding": {"runner": runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}}


def dispatch_and_hang(runner, source, database, directory, sender):
    counter = str(Path(directory) / "counter")
    options = {"test_counter": counter, "test_tmpdir": directory, "test_hold": True}
    client = DurableLocalRunFixtureClient(runner, source, database, **options)
    # Starting the owned host is not dispatch; reservation happens inside execute.
    client.host = LocalRunFixtureClient(runner, source, **options)
    sender.send(client.host._process.pid)
    sender.close()
    client.execute(request(runner))
    os._exit(24)


class DurableLocalRunTest(unittest.TestCase):
    def test_crash_after_dispatch_never_replays_for_three_runners(self):
        source = os.environ.get("SYNTHETIC_BASE_REPO", "")
        if not os.path.isabs(source):
            self.fail("SYNTHETIC_BASE_REPO must name the existing synthetic fixture")
        ctx = multiprocessing.get_context("spawn")
        for runner in ("codex", "claude-code", "opencode"):
            with self.subTest(runner=runner), tempfile.TemporaryDirectory(prefix="broker-crash-") as directory:
                database = str(Path(directory) / "admission.sqlite")
                counter = Path(directory) / "counter"
                receiver, sender = ctx.Pipe(duplex=False)
                worker = ctx.Process(target=dispatch_and_hang, args=(runner, source, database, directory, sender))
                host_pid = None
                try:
                    worker.start()
                    sender.close()
                    self.assertTrue(receiver.poll(20))
                    host_pid = receiver.recv()
                    deadline = time.monotonic() + 30
                    while not counter.exists() and time.monotonic() < deadline and worker.is_alive():
                        time.sleep(0.05)
                    self.assertTrue(counter.exists(), "fake dispatch did not start")
                    self.assertEqual(counter.read_text(), "dispatch\n")
                    with DurableLocalRunFixtureClient(runner, source, database) as concurrent:
                        self.assertEqual(concurrent.execute(request(runner)), {"ok": False, "error": "unknown"})
                        self.assertIsNone(concurrent.host)
                    # Crash both owner and its held host before any result can be persisted.
                    worker.kill()
                    worker.join(10)
                    os.kill(host_pid, signal.SIGKILL)
                    host_pid = None
                    self.assertIsNotNone(worker.exitcode)
                    for _ in range(2):
                        with DurableLocalRunFixtureClient(runner, source, database) as restarted:
                            self.assertEqual(restarted.execute(request(runner)), {"ok": False, "error": "unknown"})
                            self.assertEqual(restarted.execute({**request(runner), "prompt": "other synthetic fixture"}), {"ok": False, "error": "conflict"})
                            self.assertIsNone(restarted.host)
                    self.assertEqual(counter.read_text(), "dispatch\n")
                finally:
                    receiver.close()
                    if worker.is_alive():
                        worker.kill()
                        worker.join(10)
                    if host_pid is not None:
                        try:
                            os.kill(host_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == "__main__":
    unittest.main()
