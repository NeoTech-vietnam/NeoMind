import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest

from durable_admission import FixtureAdmission, FixtureGrant


def request(prompt="fixture: original", task="task-1", runner="codex"):
    return {"version": 1, "taskId": task, "attemptId": "attempt-1", "prompt": prompt,
            "binding": {"runner": runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}}


def contender(database, barrier, queue, prompt="fixture: original"):
    store = FixtureAdmission(database, FixtureGrant("task-1", "codex"))
    barrier.wait(timeout=15)
    queue.put(store.admit(request(prompt)))
    store.close()


def crash_after_reservation(database, marker, connection):
    store = FixtureAdmission(database, FixtureGrant("task-1", "codex"))
    response = store.admit(request())
    if response["status"] == "admitted":
        with open(marker, "x", encoding="utf-8") as dispatch:
            dispatch.write("fake dispatch\n")
            dispatch.flush()
            os.fsync(dispatch.fileno())
    connection.send(response["status"])
    connection.close()
    os._exit(23)


class DurableAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="neomind-admission-")
        self.database = str(Path(self.temp.name) / "admission.sqlite")
        self.grant = FixtureGrant("task-1", "codex")

    def tearDown(self):
        self.temp.cleanup()

    def test_durable_duplicate_conflict_and_fenced_completion(self):
        store = FixtureAdmission(self.database, self.grant)
        admitted = store.admit(request())
        self.assertEqual(admitted["status"], "admitted")
        self.assertEqual(store.admit(request()), {"status": "unknown"})
        self.assertEqual(store.admit(request("fixture: different")), {"status": "conflict"})
        self.assertFalse(store.complete(request(), "0" * 64, "fixture: result"))
        self.assertFalse(store.complete(request("fixture: different"), admitted["token"], "fixture: result"))
        self.assertTrue(store.complete(request(), admitted["token"], "fixture: result"))
        self.assertFalse(store.complete(request(), admitted["token"], "fixture: again"))
        store.close()
        store = FixtureAdmission(self.database, self.grant)
        self.assertEqual(store.admit(request()), {"status": "completed", "result": "fixture: result"})
        self.assertEqual(store.admit(request("fixture: different")), {"status": "conflict"})
        store.close()

    def test_grant_and_input_are_fail_closed(self):
        store = FixtureAdmission(self.database, self.grant)
        for invalid in (request(task="other"), request(runner="opencode"), {**request(), "access": "write"},
                        {**request(), "version": True}, {**request(), "prompt": "not synthetic"},
                        {**request(), "attemptId": "../escape"}, None):
            self.assertEqual(store.admit(invalid), {"status": "denied"})
        self.assertEqual(store.db.execute("SELECT count(*) FROM fixture_attempts").fetchone()[0], 0)
        store.close()

    def test_cross_process_race_only_one_admission(self):
        store = FixtureAdmission(self.database, self.grant)
        store.close()
        ctx = multiprocessing.get_context("spawn")
        barrier, queue = ctx.Barrier(6), ctx.Queue()
        processes = [ctx.Process(target=contender, args=(self.database, barrier, queue)) for _ in range(6)]
        for process in processes:
            process.start()
        responses = [queue.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(30)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(sorted(item["status"] for item in responses), ["admitted"] + ["unknown"] * 5)
        store = FixtureAdmission(self.database, self.grant)
        token = next(item["token"] for item in responses if item["status"] == "admitted")
        self.assertTrue(store.complete(request(), token, "fixture: result"))
        self.assertEqual(store.admit(request())["status"], "completed")
        store.close()
        queue.close()
        queue.join_thread()

    def test_process_crash_after_reservation_never_readmits(self):
        ctx = multiprocessing.get_context("spawn")
        receiver, sender = ctx.Pipe(duplex=False)
        marker = str(Path(self.temp.name) / "fake-dispatch")
        process = ctx.Process(target=crash_after_reservation, args=(self.database, marker, sender))
        process.start()
        sender.close()
        self.assertTrue(receiver.poll(30))
        self.assertEqual(receiver.recv(), "admitted")
        process.join(30)
        self.assertEqual(process.exitcode, 23)
        receiver.close()
        self.assertEqual(Path(marker).read_text(encoding="utf-8"), "fake dispatch\n")
        for _ in range(2):
            store = FixtureAdmission(self.database, self.grant)
            self.assertEqual(store.admit(request()), {"status": "unknown"})
            self.assertEqual(store.admit(request("fixture: changed")), {"status": "conflict"})
            store.close()

    def test_cross_process_conflicting_payloads_have_one_winner(self):
        store = FixtureAdmission(self.database, self.grant)
        store.close()
        ctx = multiprocessing.get_context("spawn")
        barrier, queue = ctx.Barrier(2), ctx.Queue()
        processes = [ctx.Process(target=contender, args=(self.database, barrier, queue, prompt))
                     for prompt in ("fixture: first", "fixture: second")]
        for process in processes:
            process.start()
        responses = [queue.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(30)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(sorted(item["status"] for item in responses), ["admitted", "conflict"])
        queue.close()
        queue.join_thread()


if __name__ == "__main__":
    unittest.main()
