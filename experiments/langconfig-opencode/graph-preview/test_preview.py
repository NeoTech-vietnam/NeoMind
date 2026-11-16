import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

from preview import MAX_DEPTH, MAX_EDGES, MAX_INPUT_BYTES, MAX_NODES, preview


HERE = Path(__file__).parent


def fixture(name):
    return json.loads((HERE / "fixtures" / name).read_text(encoding="utf-8"))


def codes(result):
    return [item["code"] for item in result["diagnostics"]]


class PreviewTests(unittest.TestCase):
    def test_basic_is_only_a_structural_suggestion(self):
        data = fixture("basic.json")
        original = copy.deepcopy(data)
        result = preview(data)
        self.assertEqual(data, original)
        self.assertFalse(result["executable"])
        self.assertEqual([n["suggested_type"] for n in result["nodes"]], ["start", "finish"])
        self.assertEqual(result["edges"][0]["suggested_outcome"], "completed")
        self.assertIn("approximate_edge", codes(result))
        self.assertEqual(codes(result).count("lossy_field"), 4)
        self.assertNotIn("definition", result)

    def test_unsupported_loop_routing_cycle_terminal_and_secret(self):
        result = preview(fixture("unsupported.json"))
        for code in ("unsupported_node", "unsupported_edge", "unsupported_terminal", "cycle", "lossy_field"):
            self.assertIn(code, codes(result))
        self.assertNotIn("suggested_type", result["nodes"][1])
        self.assertNotIn("repair_scope", json.dumps(result["nodes"]))
        self.assertNotIn("DO_NOT_COPY", json.dumps(result))
        self.assertEqual(len(result["edges"]), 2)

    def test_export_structural_preview_never_copies_values(self):
        data = fixture("workflow-export.json")
        original = copy.deepcopy(data)
        result = preview(data)
        self.assertEqual(data, original)
        self.assertEqual(result["source_format"], "langconfig-workflow-export-1.0")
        self.assertFalse(result["executable"])
        self.assertEqual([item.get("suggested_type") for item in result["nodes"]], ["start", None, None, "finish"])
        self.assertEqual(result["edges"][0], {"source": "node-0", "target": "node-1"})
        for code in ("unsupported_node", "unsupported_edge", "unsupported_routing", "lossy_field", "unsupported_field", "cycle", "entry_not_inferred"):
            self.assertIn(code, codes(result))
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("BLUEPRINT_NOT_CANVAS", json.dumps(result))
        self.assertNotIn("repair_scope", json.dumps(result["nodes"]))
        self.assertNotIn("definition", result)

    def test_export_rejects_wrong_version_and_missing_configuration_without_blueprint_fallback(self):
        data = fixture("workflow-export.json")
        data["version"] = "2.0"
        self.assertEqual(codes(preview(data)), ["unsupported_format"])
        data["version"] = "1.0"
        del data["workflow"]["configuration"]
        result = preview(data)
        self.assertIn("invalid_input", codes(result))
        self.assertEqual(result["nodes"], [])

    def test_empty_configuration_is_reported(self):
        data = fixture("workflow-export.json")
        data["workflow"]["configuration"] = {"nodes": [], "edges": []}
        self.assertIn("empty_graph", codes(preview(data)))

    def test_export_duplicate_invalid_fallback_and_terminal(self):
        data = fixture("workflow-export.json")
        config = data["workflow"]["configuration"]
        config["nodes"].append(copy.deepcopy(config["nodes"][1]))
        config["nodes"].append({"id": "fallback", "type": "default", "data": {"agentType": "START_NODE"}})
        config["nodes"].append({"id": "invalid", "data": []})
        config["edges"].extend([{"source": "fallback", "target": "__END__"}, {"source": "fallback", "target": "invalid"}])
        result = preview(data)
        for code in ("duplicate_node_id", "invalid_edge_reference", "ambiguous_type_resolution", "invalid_node_data", "unsupported_terminal"):
            self.assertIn(code, codes(result))
        self.assertNotIn("suggested_type", result["nodes"][-1])

    def test_blueprint_does_not_copy_user_strings_or_unknown_field_names(self):
        data = fixture("basic.json")
        data["name"] = "SECRET_NAME"
        data["nodes"][0]["node_id"] = "SECRET_ID"
        data["nodes"][0]["display_name"] = "SECRET_LABEL"
        data["nodes"][0]["SECRET_KEY"] = "SECRET_VALUE"
        data["entry_point_id"] = "SECRET_ID"
        data["edges"][0]["source_id"] = "SECRET_ID"
        self.assertNotIn("SECRET", json.dumps(preview(data)))

    def test_bad_shapes_and_untrusted_fields(self):
        for data in (None, [], {"nodes": {}, "edges": []}):
            self.assertIn("invalid_input", codes(preview(data)))
        data = fixture("basic.json")
        data["nodes"][0]["surprise"] = {"token": "DO_NOT_COPY"}
        data["edges"].append({"source_id": "start", "target_id": "missing"})
        data["edges"].append({"source_id": "start", "target_id": "end", "routing_map": {"x": "end"}})
        data["edges"].append(data["edges"][0])
        result = preview(data)
        for code in ("unsupported_field", "invalid_edge_reference", "ambiguous_edge", "duplicate_edge"):
            self.assertIn(code, codes(result))
        self.assertNotIn("DO_NOT_COPY", json.dumps(result))

    def test_invalid_and_duplicate_ids_are_not_connected(self):
        data = fixture("basic.json")
        data["nodes"].append(copy.deepcopy(data["nodes"][0]))
        data["nodes"].append({"node_id": "bad id", "display_name": "Bad", "node_type": "start"})
        result = preview(data)
        for code in ("duplicate_node_id", "invalid_node_id", "invalid_entry", "invalid_edge_reference"):
            self.assertIn(code, codes(result))
        self.assertEqual(result["edges"], [])

    def test_cli_invalid_json_and_read_only_output(self):
        command = [sys.executable, "-B", str(HERE / "preview.py")]
        bad = subprocess.run(command, input="{", text=True, capture_output=True, check=False)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stdout)["error"], "invalid_json")
        good = subprocess.run(command, input=json.dumps(fixture("basic.json")), text=True, capture_output=True, check=False)
        self.assertEqual(good.returncode, 0)
        self.assertFalse(json.loads(good.stdout)["executable"])
        exported = subprocess.run(command, input=json.dumps(fixture("workflow-export.json")), text=True, capture_output=True, check=False)
        self.assertEqual(exported.returncode, 0)
        self.assertEqual(json.loads(exported.stdout)["source_format"], "langconfig-workflow-export-1.0")
        self.assertNotIn("SECRET", exported.stdout)

    def test_graph_limits_are_fail_closed_for_both_formats(self):
        for exported in (False, True):
            data = fixture("workflow-export.json" if exported else "basic.json")
            graph = data["workflow"]["configuration"] if exported else data
            graph["nodes"] = [None] * (MAX_NODES + 1)
            result = preview(data)
            self.assertIn("graph_limit", codes(result))
            self.assertEqual((result["nodes"], result["edges"]), ([], []))
            graph["nodes"] = [None] * MAX_NODES
            graph["edges"] = [None] * (MAX_EDGES + 1)
            result = preview(data)
            self.assertIn("graph_limit", codes(result))
            self.assertEqual((result["nodes"], result["edges"]), ([], []))
            graph["edges"] = [None] * MAX_EDGES
            self.assertNotIn("graph_limit", codes(preview(data)))

    def test_references_never_resolve_synthetic_aliases(self):
        for exported in (False, True):
            data = fixture("workflow-export.json" if exported else "basic.json")
            graph = data["workflow"]["configuration"] if exported else data
            if exported:
                graph["edges"] = [{"source": "node-0", "target": "writer"}]
            else:
                graph["edges"] = [{"source_id": "node-0", "target_id": "end"}]
            result = preview(data)
            self.assertIn("invalid_edge_reference", codes(result))
            self.assertEqual(result["edges"], [])

    def test_duplicate_id_even_when_first_node_invalid(self):
        data = fixture("basic.json")
        data["nodes"].insert(0, {"node_id": "start", "display_name": None, "node_type": "start"})
        result = preview(data)
        self.assertIn("duplicate_node_id", codes(result))
        self.assertIn("invalid_entry", codes(result))
        self.assertEqual(result["edges"], [])

    def test_limits_invalid_values_and_cycles_on_direct_api(self):
        data = fixture("basic.json")
        data["SECRET_KEY"] = "x" * (MAX_INPUT_BYTES + 1)
        self.assertEqual(codes(preview(data)), ["input_limit"])
        nested = None
        for _ in range(MAX_DEPTH + 2):
            nested = [nested]
        self.assertEqual(codes(preview(nested)), ["input_limit"])
        cycle = []
        cycle.append(cycle)
        self.assertEqual(codes(preview(cycle)), ["invalid_input"])
        for value in (float("nan"), "\ud800", {1: "secret"}):
            self.assertEqual(codes(preview(value)), ["invalid_input"])

    def test_cli_limits_and_invalid_json_do_not_echo_secret(self):
        command = [sys.executable, "-B", str(HERE / "preview.py")]
        inputs = [b'{"SECRET_KEY":1,"SECRET_KEY":2}', b'{"SECRET":NaN}',
                  b'{"SECRET":"\xff"}',
                  b'{"SECRET":"' + b'x' * MAX_INPUT_BYTES + b'"}']
        for text in inputs:
            result = subprocess.run(command, input=text, capture_output=True, check=False)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn(b"SECRET", result.stdout + result.stderr)
            self.assertEqual(result.stderr, b"")
            self.assertIn(json.loads(result.stdout)["error"], ("invalid_json", "input_limit"))
        deep = subprocess.run(command, input=b'[' * (MAX_DEPTH + 5) + b']' * (MAX_DEPTH + 5), capture_output=True, check=False)
        self.assertEqual(deep.returncode, 0)
        self.assertEqual(codes(json.loads(deep.stdout)), ["input_limit"])

    def test_missing_or_malformed_export_configuration_never_uses_blueprint(self):
        for config in (None, {}, {"nodes": [], "edges": None}, {"nodes": {}, "edges": []}):
            data = fixture("workflow-export.json")
            data["workflow"]["configuration"] = config
            result = preview(data)
            self.assertIn("invalid_input", codes(result))
            self.assertEqual((result["nodes"], result["edges"]), ([], []))
            self.assertNotIn("SECRET", json.dumps(result))

    def test_node_config_missing_null_or_nested_not_substituted(self):
        for config in (None, "SECRET_BAD_CONFIG"):
            data = fixture("workflow-export.json")
            node = data["workflow"]["configuration"]["nodes"][1]
            node["config"] = config
            result = preview(data)
            self.assertIn("missing_node_config", codes(result))
            self.assertNotIn("SECRET", json.dumps(result))
        del node["config"]
        self.assertIn("missing_node_config", codes(preview(data)))


if __name__ == "__main__":
    unittest.main()
