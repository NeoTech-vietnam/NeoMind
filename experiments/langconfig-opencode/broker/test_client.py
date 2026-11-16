import unittest

from client import FixtureBrokerClient


def request(runner):
    return {"version": 1, "taskId": "task", "idempotencyKey": "attempt", "access": "read", "prompt": "fixture",
            "binding": {"runner": runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}}


class ClientTest(unittest.TestCase):
    def test_stdio_contract_and_conflict(self):
        with FixtureBrokerClient() as client:
            for runner in ("codex", "claude-code", "opencode"):
                value = request(runner)
                value["taskId"] = runner
                first = client.execute(value)
                self.assertEqual(first["result"]["runner"], runner)
                self.assertEqual(client.execute(value), first)
                self.assertEqual(client.execute({**value, "prompt": "different"})["error"], "idempotency_conflict")
            self.assertEqual(client.execute({**request("codex"), "access": "write"})["error"], "invalid_request")

    def test_closed_client_does_not_restart(self):
        client = FixtureBrokerClient()
        client.close()
        with self.assertRaises(RuntimeError):
            client.execute(request("codex"))


if __name__ == "__main__":
    unittest.main()
