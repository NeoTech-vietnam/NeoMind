import unittest
import tempfile
from pathlib import Path
from live_models import live_model
from fake_acceptance import Worker, ROOT, session_model_matches


class ModelSelectionTests(unittest.TestCase):
    def test_explicit_selection_and_unknown_rejection(self):
        self.assertEqual(live_model('glm-5.3-flash-free'), {'providerID': 'opencode', 'id': 'glm-5.3-flash-free', 'variant': 'high'})
        self.assertEqual(live_model('openrouter/openrouter/free'), {'providerID': 'openrouter', 'id': 'openrouter/free'})
        self.assertEqual(live_model('zai/glm-5.3-flash'), {'providerID': 'zai', 'id': 'glm-5.3-flash', 'variant': 'high'})
        for candidate in (None, '', 'glm-5.3-flash', 'glm-5.3-flash-free#high', 'opencode/glm-5.3-flash-free', 'gpt-6.1-sol', 'openrouter/free', 'openrouter/openrouter/free#high'):
            with self.assertRaises(ValueError):
                live_model(candidate)

    def test_router_session_sentinel_is_narrow(self):
        expected = live_model('openrouter/openrouter/free')
        self.assertTrue(session_model_matches(expected, expected))
        self.assertTrue(session_model_matches({**expected, 'variant': 'default'}, expected))
        for bad in ({**expected, 'variant': 'high'}, {**expected, 'providerID': 'other', 'variant': 'default'}, {**expected, 'id': 'paid', 'variant': 'default'}):
            self.assertFalse(session_model_matches(bad, expected))

    def test_private_worker_preflight_requires_exact_free_glm_metadata(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tmp') as directory:
            root = Path(directory)
            (root / 'config/opencode').mkdir(parents=True)
            (root / 'trace.jsonl').write_text('{"event":"ready"}\n')
            worker = Worker.__new__(Worker)
            worker.root, worker.trace, worker.live, worker.model = root, root / 'trace.jsonl', True, live_model('glm-5.3-flash-free')
            model = {'providerID': 'opencode', 'id': worker.model['id'], 'enabled': True, 'variants': [{'id': 'high'}],
                     'cost': [{'input': 0, 'output': 0, 'cache': {'read': 0, 'write': 0}}]}
            plugin = '/fixture/guard'
            def request(method, path):
                return {'/api/info': {'version': '2.2.7', 'pid': 100},
                        '/api/config': [{'type': 'document', 'path': str(root / 'config/opencode/opencode.json')}],
                        '/api/model': {'data': [model]}, '/api/mcp': {'data': []},
                        '/api/plugin': {'data': [{'id': 'fixture-live-guard', 'source': {'type': 'local', 'path': plugin}, 'state': {'status': 'active'}}]}}[path]
            worker.request = request
            worker.preflight(plugin)
            model['cost'][0]['output'] = 1
            with self.assertRaises(AssertionError): worker.preflight(plugin)
            model['cost'][0]['output'] = 0
            model['variants'] = [{'id': 'low'}]
            with self.assertRaises(AssertionError): worker.preflight(plugin)
            model['variants'] = [{'id': 'high'}]
            model['id'] = 'glm-5.3-flash'
            with self.assertRaises(AssertionError): worker.preflight(plugin)
            worker.model = live_model('zai/glm-5.3-flash')
            model.update(providerID='zai', id='glm-5.3-flash', limit={'output': 8192}, cost=[{'input': 0.15, 'output': 0.5, 'cache': {'read': 0.03, 'write': 0}}])
            worker.preflight(plugin)
            model['cost'][0]['output'] = 0.51
            with self.assertRaises(AssertionError): worker.preflight(plugin)


if __name__ == '__main__':
    unittest.main(verbosity=2)
