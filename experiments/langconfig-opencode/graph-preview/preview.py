"""Read-only, deliberately incomplete LangConfig graph preview."""

import json
import math
import re
import sys


ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
NODE_FIELDS = {"node_id", "display_name", "node_type", "handler_function", "metadata", "agent_config"}
EDGE_FIELDS = {"source_id", "target_id", "edge_type", "condition_function", "routing_map"}
ROOT_FIELDS = {"strategy_type", "name", "description", "version", "nodes", "edges", "entry_point_id", "metadata"}
MAX_INPUT_BYTES = 1_048_576
MAX_NODES = 500
MAX_EDGES = 2000
MAX_VALUES = 20_000
MAX_DEPTH = 64


def input_problem(value):
    """Bound pre-parsed inputs too; never inspect or return untrusted strings."""
    stack = [(value, 0, False)]
    active = set()
    size = count = 0
    while stack:
        item, depth, closing = stack.pop()
        if closing:
            active.remove(id(item))
            continue
        count += 1
        if count > MAX_VALUES or depth > MAX_DEPTH:
            return "input_limit"
        if isinstance(item, str):
            if len(item) > MAX_INPUT_BYTES:
                return "input_limit"
            try:
                size += len(item.encode("utf-8")) + 2
            except UnicodeError:
                return "invalid_input"
        elif item is None or isinstance(item, (bool, int, float)):
            if isinstance(item, float) and not math.isfinite(item):
                return "invalid_input"
            if isinstance(item, int) and item.bit_length() > 4096:
                return "input_limit"
            size += 32
        elif isinstance(item, (dict, list)):
            if id(item) in active:
                return "invalid_input"
            active.add(id(item))
            stack.append((item, depth, True))
            size += 2 + len(item)
            if count + len(item) > MAX_VALUES:
                return "input_limit"
            if isinstance(item, dict):
                if any(not isinstance(key, str) for key in item):
                    return "invalid_input"
                stack.extend((key, depth + 1, False) for key in item)
                stack.extend((child, depth + 1, False) for child in item.values())
            else:
                stack.extend((child, depth + 1, False) for child in item)
        else:
            return "invalid_input"
        if size > MAX_INPUT_BYTES:
            return "input_limit"
    return None


def graph_limit(nodes, edges):
    return len(nodes) > MAX_NODES or len(edges) > MAX_EDGES


def _preview_export(value):
    diagnostics, nodes, edges = [], [], []
    result = {"format": "neomind-graph-preview-v1", "source_format": "langconfig-workflow-export-1.0",
              "executable": False, "nodes": nodes, "edges": edges, "diagnostics": diagnostics}

    def issue(code, location, message):
        diagnostics.append({"code": code, "location": location, "message": message})

    def extra(obj, known, location):
        if set(obj) - known:
            issue("unsupported_field", location, "Unrecognized fields are not interpreted or copied.")

    if value.get("export_type") != "workflow" or value.get("version") != "1.0":
        issue("unsupported_format", "$", "Expected a workflow export with format version 1.0.")
        return result
    extra(value, {"version", "langconfig_version", "export_type", "metadata", "workflow", "custom_tools", "deepagents"}, "$")
    for field in ("langconfig_version", "metadata", "custom_tools", "deepagents"):
        if field in value and value[field] not in (None, {}, []):
            issue("lossy_field", "$." + field, "Export data is not interpreted or copied.")
    workflow = value.get("workflow")
    if not isinstance(workflow, dict):
        issue("invalid_input", "$.workflow", "Expected a workflow object.")
        return result
    extra(workflow, {"name", "description", "strategy_type", "configuration", "blueprint"}, "$.workflow")
    for field in ("name", "description", "strategy_type", "blueprint"):
        if field in workflow and workflow[field] not in (None, {}, ""):
            issue("lossy_field", "$.workflow." + field, "Field is not interpreted or copied; blueprint is not canvas configuration.")
    config = workflow.get("configuration")
    if not isinstance(config, dict) or not isinstance(config.get("nodes"), list) or not isinstance(config.get("edges"), list):
        issue("invalid_input", "$.workflow.configuration", "Expected configuration with nodes and edges arrays; blueprint is not substituted.")
        return result
    if graph_limit(config["nodes"], config["edges"]):
        issue("graph_limit", "$.workflow.configuration", "Graph exceeds node or edge limits; no partial preview is produced.")
        return result
    extra(config, {"nodes", "edges"}, "$.workflow.configuration")
    if not config["nodes"]:
        issue("empty_graph", "$.workflow.configuration.nodes", "No configured nodes; executor cannot build this graph.")

    counts = {}
    for node in config["nodes"]:
        if isinstance(node, dict) and isinstance(node.get("id"), str) and node["id"]:
            counts[node["id"]] = counts.get(node["id"], 0) + 1
    by_id = {}
    for index, node in enumerate(config["nodes"]):
        loc = f"$.workflow.configuration.nodes[{index}]"
        if not isinstance(node, dict):
            issue("invalid_node", loc, "Expected an object.")
            continue
        extra(node, {"id", "type", "data", "config", "position"}, loc)
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id or node_id == "__END__":
            issue("invalid_node_id", loc, "Expected a non-empty string ID.")
            continue
        if counts[node_id] != 1:
            issue("duplicate_node_id", loc, "Duplicate IDs make references ambiguous.")
            continue
        data = node.get("data", {})
        if not isinstance(data, dict):
            issue("invalid_node_data", loc + ".data", "Expected an object.")
            continue
        extra(data, {"agentType"}, loc + ".data")
        for field in ("config", "position"):
            if field in node and node[field] is not None:
                issue("lossy_field", loc + "." + field, "Field is not interpreted or copied.")
        raw_type = node.get("type", "default")
        data_type = data.get("agentType", "")
        if not isinstance(raw_type, str) or not isinstance(data_type, str):
            issue("invalid_node_type", loc, "Node type must be a string.")
            continue
        # Executor's node construction and edge routing resolve fallback types differently.
        resolved = raw_type if raw_type != "default" else (data_type or "default")
        if resolved not in ("START_NODE", "END_NODE") and not isinstance(node.get("config"), dict):
            issue("missing_node_config", loc + ".config", "Executable node has missing or invalid top-level config; nested data is not substituted.")
        item = {"id": f"node-{index}"}
        if raw_type in ("START_NODE", "END_NODE") and (not data_type or raw_type == data_type):
            item["suggested_type"] = "start" if raw_type == "START_NODE" else "finish"
            issue("approximate_node", loc, "Boundary is a visual suggestion; executor treats it specially.")
        else:
            issue("unsupported_node", loc, "Node has no established NeoMind mapping, including fallback, loop and approval types.")
        if raw_type == "default" and data_type:
            issue("ambiguous_type_resolution", loc, "Node and edge routing resolve fallback types differently; no type is mapped.")
        elif data_type and raw_type != data_type:
            issue("conflicting_node_type", loc, "Top-level and data types differ; no type equivalence is assumed.")
        by_id[node_id] = (item["id"], resolved)
        nodes.append(item)

    adjacency = {item["id"]: [] for item in nodes}
    for index, edge in enumerate(config["edges"]):
        loc = f"$.workflow.configuration.edges[{index}]"
        if not isinstance(edge, dict):
            issue("invalid_edge", loc, "Expected an object.")
            continue
        extra(edge, {"source", "target", "data"}, loc)
        if "data" in edge and edge["data"] not in (None, {}):
            issue("lossy_field", loc + ".data", "Edge data and routing labels are not interpreted or copied.")
        source, target = edge.get("source"), edge.get("target")
        if target == "__END__":
            issue("unsupported_terminal", loc, "Implicit terminal is not represented as a synthetic finish.")
            continue
        if not isinstance(source, str) or not isinstance(target, str) or source not in by_id or target not in by_id:
            issue("invalid_edge_reference", loc, "Source and target must identify unambiguous valid nodes.")
            continue
        source_id, source_type = by_id[source]
        target_id = by_id[target][0]
        edges.append({"source": source_id, "target": target_id})
        adjacency[source_id].append(target_id)
        issue("unsupported_edge", loc, "Only topology is shown; no outcome or routing semantics is inferred.")
        if source_type in ("CONDITIONAL_NODE", "LOOP_NODE"):
            issue("unsupported_routing", loc, "Conditional or loop routing is not mapped to NeoMind outcomes or repair.")

    indegree = {key: 0 for key in adjacency}
    for targets in adjacency.values():
        for target in targets:
            indegree[target] += 1
    ready = [key for key, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for target in adjacency[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if visited != len(adjacency):
        issue("cycle", "$.workflow.configuration.edges", "NeoMind execution edges require a DAG; no repair conversion is inferred.")
    issue("entry_not_inferred", "$.workflow.configuration", "Runtime entry selection is not reproduced or validated.")
    return result


def preview(value):
    diagnostics = []
    nodes = []
    edges = []

    def issue(code, location, message):
        diagnostics.append({"code": code, "location": location, "message": message})

    def ignored(obj, allowed, location):
        if set(obj) - allowed:
            issue("unsupported_field", location, "Unrecognized fields are not interpreted or copied.")

    result = {"format": "neomind-graph-preview-v1", "executable": False,
              "nodes": nodes, "edges": edges, "diagnostics": diagnostics}
    problem = input_problem(value)
    if problem:
        issue(problem, "$", "Input is invalid or exceeds resource limits; no partial preview is produced.")
        return result
    if not isinstance(value, dict):
        issue("invalid_input", "$", "Expected a blueprint object.")
        return result
    if "workflow" in value or value.get("export_type") == "workflow":
        return _preview_export(value)
    if not isinstance(value.get("nodes"), list) or not isinstance(value.get("edges"), list):
        issue("invalid_input", "$", "Blueprint nodes and edges must be arrays.")
        return result
    if graph_limit(value["nodes"], value["edges"]):
        issue("graph_limit", "$", "Graph exceeds node or edge limits; no partial preview is produced.")
        return result
    ignored(value, ROOT_FIELDS, "$")
    for field in ("strategy_type", "description", "version", "metadata"):
        if value.get(field) not in (None, {}, ""):
            issue("lossy_field", "$." + field, "Blueprint field is not carried into the preview.")
    if value.get("name"):
        issue("lossy_field", "$.name", "Name is not copied.")

    by_id = {}
    counts = {}
    for node in value["nodes"]:
        if isinstance(node, dict) and isinstance(node.get("node_id"), str):
            node_id = node["node_id"]
            counts[node_id] = counts.get(node_id, 0) + 1
    duplicate_ids = {node_id for node_id, count in counts.items() if count > 1}
    for index, node in enumerate(value["nodes"]):
        loc = f"$.nodes[{index}]"
        if not isinstance(node, dict):
            issue("invalid_node", loc, "Expected an object.")
            continue
        ignored(node, NODE_FIELDS, loc)
        node_id, label, kind = node.get("node_id"), node.get("display_name"), node.get("node_type")
        if not isinstance(node_id, str) or not ID.fullmatch(node_id) or node_id == "__END__":
            issue("invalid_node_id", loc, "Node ID must satisfy NeoMind's identifier syntax.")
            continue
        if node_id in duplicate_ids:
            issue("duplicate_node_id", loc, "Duplicate node ID; references are ambiguous.")
            continue
        if not isinstance(label, str) or not label:
            issue("invalid_label", loc, "Expected a non-empty display_name.")
            continue
        if not isinstance(kind, str) or not kind:
            issue("invalid_node_type", loc, "Expected a non-empty node_type.")
            continue
        item = {"source_id": node_id, "source_type": kind, "label": label}
        if kind in ("start", "end"):
            item["suggested_type"] = "start" if kind == "start" else "finish"
            issue("approximate_node", loc, "Boundary type is a visual suggestion, not proof of equivalent execution.")
        else:
            issue("unsupported_node", loc, "Node type has no established NeoMind mapping; loop is not repair_scope.")
        for field in ("handler_function", "agent_config", "metadata"):
            if node.get(field) not in (None, {}, ""):
                issue("lossy_field", loc + "." + field, "Field is not interpreted or copied; review manually.")
        by_id[node_id] = item
        nodes.append(item)

    entry = value.get("entry_point_id")
    if not isinstance(entry, str) or entry not in by_id or entry in duplicate_ids:
        issue("invalid_entry", "$.entry_point_id", "Entry must identify one unambiguous valid node.")
    else:
        result["source_entry_id"] = entry
        if by_id[entry]["source_type"] != "start":
            issue("entry_not_start", "$.entry_point_id", "Entry is not a start node; no start node is synthesized.")

    adjacency = {key: [] for key in by_id}
    seen_edges = set()
    for index, edge in enumerate(value["edges"]):
        loc = f"$.edges[{index}]"
        if not isinstance(edge, dict):
            issue("invalid_edge", loc, "Expected an object.")
            continue
        ignored(edge, EDGE_FIELDS, loc)
        source, target, kind = edge.get("source_id"), edge.get("target_id"), edge.get("edge_type", "direct")
        if kind != "direct":
            issue("unsupported_edge", loc, "Conditional or unknown routing cannot be mapped to NeoMind outcomes.")
            continue
        if edge.get("condition_function") is not None or edge.get("routing_map") is not None:
            issue("ambiguous_edge", loc, "Direct edge also has routing configuration; no mapping proposed.")
            continue
        if target == "__END__":
            issue("unsupported_terminal", loc, "Implicit __END__ has no mapped node; no finish node is synthesized.")
            continue
        if not isinstance(source, str) or not isinstance(target, str) or source not in by_id or target not in by_id or source in duplicate_ids or target in duplicate_ids:
            issue("invalid_edge_reference", loc, "Source and target must identify unambiguous valid nodes.")
            continue
        pair = (source, target)
        if pair in seen_edges:
            issue("duplicate_edge", loc, "Duplicate edge is not represented twice.")
            continue
        seen_edges.add(pair)
        adjacency[source].append(target)
        edges.append({"source_id": source, "target_id": target, "suggested_outcome": "completed"})
        issue("approximate_edge", loc, "Direct edge is only a structural completed-outcome suggestion; execution equivalence is unverified.")

    indegree = {key: 0 for key in by_id}
    for targets in adjacency.values():
        for target in targets:
            indegree[target] += 1
    ready = [key for key, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for target in adjacency[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if visited != len(by_id):
        issue("cycle", "$.edges", "NeoMind execution edges require a DAG; no repair conversion is inferred.")
    aliases = {item["source_id"]: f"node-{index}" for index, item in enumerate(nodes)}
    for item in nodes:
        item["source_id"] = aliases[item["source_id"]]
        item.pop("label")
        if item["source_type"] not in ("start", "end"):
            item["source_type"] = "unsupported"
    for item in edges:
        item["source_id"] = aliases[item["source_id"]]
        item["target_id"] = aliases[item["target_id"]]
    if "source_entry_id" in result:
        result["source_entry_id"] = aliases[result["source_entry_id"]]
    return result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("non-finite number")


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            print(json.dumps({"error": "input_limit"}))
            return 2
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        print(json.dumps({"error": "invalid_json"}))
        return 2
    print(json.dumps(preview(value), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
