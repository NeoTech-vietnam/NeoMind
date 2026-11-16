"""Fixture admission wrapper: reservation is durable before any LocalRun host dispatch."""
import json

from durable_admission import FixtureAdmission, FixtureGrant
from localrun_client import LocalRunFixtureClient


class DurableLocalRunFixtureClient:
    def __init__(self, runner, source, database, *, test_counter=None, test_hold=False, test_tmpdir=None):
        self.grant = FixtureGrant("fixture-task", runner)
        self.store = FixtureAdmission(database, self.grant)
        self.source = source
        self.host_options = {"test_counter": test_counter, "test_hold": test_hold, "test_tmpdir": test_tmpdir}
        self.host = None

    def execute(self, request):
        if type(request) is not dict or set(request) != {"version", "taskId", "binding", "prompt"} or type(request.get("prompt")) is not str:
            return {"ok": False, "error": "grant_rejected"}
        admission_request = {**request, "attemptId": "fixture-attempt", "prompt": "fixture:" + request["prompt"]}
        decision = self.store.admit(admission_request)
        if decision["status"] == "denied":
            return {"ok": False, "error": "grant_rejected"}
        if decision["status"] in ("unknown", "conflict"):
            return {"ok": False, "error": decision["status"]}
        if decision["status"] == "completed":
            try:
                response = json.loads(decision["result"][len("fixture:"):])
                if not self._valid_response(response):
                    raise ValueError("invalid stored result")
                return response
            except (ValueError, TypeError):
                return {"ok": False, "error": "unknown"}
        try:
            if self.host is None:
                self.host = LocalRunFixtureClient(self.grant.runner, self.source, **self.host_options)
            response = self.host.execute(request)
            if not self._valid_response(response):
                return {"ok": False, "error": "unknown"}
            encoded = "fixture:" + json.dumps(response, sort_keys=True, separators=(",", ":"))
            if not self.store.complete(admission_request, decision["token"], encoded):
                return {"ok": False, "error": "unknown"}
            return response
        except (OSError, RuntimeError, ValueError):
            return {"ok": False, "error": "unknown"}

    def _valid_response(self, response):
        runner = self.grant.runner
        return response == {"ok": True, "runner": runner, "message": f"fixture:{runner}",
                            "proof": {"intentBeforeDispatch": True, "receipt": "accepted", "fakeStop": True, "dispatches": 1}}

    def close(self):
        try:
            if self.host:
                self.host.close()
        finally:
            self.store.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
