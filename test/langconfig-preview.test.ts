import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flowSchema } from '../src/domain/schema.js';
import { LANGCONFIG_PREVIEW_LIMITS as limits, previewLangConfigJson as preview } from '../src/domain/langconfig-preview.js';

const fixture = (name: string): any => JSON.parse(readFileSync(`experiments/langconfig-opencode/graph-preview/fixtures/${name}.json`, 'utf8'));
const run = (value: unknown) => preview(JSON.stringify(value));
const codes = (value: ReturnType<typeof preview>) => value.diagnostics.map(item => item.code);

test('blueprint produces only aliased boundary and direct-edge suggestions', () => {
  const graph = fixture('basic');
  graph.name = 'SECRET_NAME'; graph.nodes[0].display_name = 'SECRET_LABEL'; graph.nodes[0].SECRET_KEY = 'SECRET_VALUE';
  const result = run(graph);
  assert.equal(result.sourceFormat, 'blueprint');
  assert.equal(result.executable, false);
  assert.deepEqual(result.nodes, [{ id: 'node-0', suggestedType: 'start' }, { id: 'node-1', suggestedType: 'finish' }]);
  assert.deepEqual(result.edges, [{ from: 'node-0', to: 'node-1', suggestedOutcome: 'completed' }]);
  assert.equal(result.entry, 'node-0');
  assert.ok(codes(result).includes('unsupported_field'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(flowSchema.safeParse(result).success, false);
});

test('workflow export shows topology, flags loops and never substitutes blueprint or copies secrets', () => {
  const data = fixture('workflow-export');
  const result = run(data);
  assert.equal(result.sourceFormat, 'workflow-export-1.0');
  assert.deepEqual(result.nodes.map(node => node.suggestedType), ['start', undefined, undefined, 'finish']);
  assert.deepEqual(result.edges[0], { from: 'node-0', to: 'node-1' });
  for (const code of ['unsupported_node', 'unsupported_edge', 'unsupported_routing', 'lossy_field', 'unsupported_field', 'cycle', 'entry_not_inferred']) assert.ok(codes(result).includes(code), code);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|BLUEPRINT_NOT_CANVAS|repair_scope/);
  delete data.workflow.configuration;
  const missing = run(data);
  assert.ok(codes(missing).includes('invalid_input'));
  assert.deepEqual(missing.nodes, []);
  data.version = '9'; assert.ok(codes(run(data)).includes('unsupported_format'));
});

test('duplicate IDs, invalid nodes, aliases and reserved terminal cannot resolve references', () => {
  for (const isExport of [false, true]) {
    const data = fixture(isExport ? 'workflow-export' : 'basic');
    const graph = isExport ? data.workflow.configuration : data;
    const key = isExport ? 'id' : 'node_id';
    const duplicate = structuredClone(graph.nodes[0]);
    if (isExport) duplicate.data = []; else duplicate.display_name = null;
    graph.nodes.unshift(duplicate);
    graph.edges = isExport ? [{ source: graph.nodes[0][key], target: 'writer' }, { source: 'node-0', target: 'writer' }, { source: 'writer', target: '__END__' }] :
      [{ source_id: graph.nodes[0][key], target_id: 'end' }, { source_id: 'node-0', target_id: 'end' }, { source_id: 'end', target_id: '__END__' }];
    const result = run(data);
    assert.ok(codes(result).includes('duplicate_node_id'));
    assert.ok(codes(result).includes('invalid_edge_reference'));
    assert.ok(codes(result).includes('unsupported_terminal'));
    assert.deepEqual(result.edges, []);
  }
});

test('conditional routing and ambiguous direct edges are not translated', () => {
  const result = run(fixture('unsupported'));
  assert.ok(codes(result).includes('unsupported_edge'));
  assert.ok(codes(result).includes('cycle'));
  const graph = fixture('basic');
  graph.edges[0].routing_map = { SECRET: 'end' };
  assert.ok(codes(run(graph)).includes('ambiguous_edge'));
  assert.deepEqual(run(graph).edges, []);
});

test('malformed JSON, duplicate escaped keys, invalid Unicode, limits and non-text fail closed without echo', () => {
  for (const text of ['{"SECRET":1,"\\u0053ECRET":2}', '{"SECRET":NaN}', '{"SECRET":"\\ud800"}', '{"SECRET":1} garbage', '{"x":1e999}', '{"SECRET":"bad\n"}', '{"a":1,}']) {
    const result = preview(text);
    assert.ok(codes(result).includes('invalid_json'));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.deepEqual(result.nodes, []);
  }
  assert.ok(codes(preview({ nodes: [] })).includes('invalid_input'));
  assert.ok(codes(preview('x'.repeat(limits.bytes + 1))).includes('input_limit'));
  assert.ok(codes(preview('['.repeat(limits.depth + 2) + '0' + ']'.repeat(limits.depth + 2))).includes('input_limit'));
  assert.ok(codes(preview('[' + Array(limits.values + 1).fill('0').join(',') + ']')).includes('input_limit'));
});

test('graph count limits fail closed and top-level config cannot be replaced with nested config', () => {
  for (const isExport of [false, true]) {
    const data = fixture(isExport ? 'workflow-export' : 'basic');
    const graph = isExport ? data.workflow.configuration : data;
    graph.nodes = Array(limits.nodes + 1).fill(null);
    let result = run(data);
    assert.ok(codes(result).includes('graph_limit'));
    assert.deepEqual([result.nodes, result.edges], [[], []]);
    graph.nodes = []; graph.edges = Array(limits.edges + 1).fill(null);
    result = run(data); assert.ok(codes(result).includes('graph_limit'));
  }
  const data = fixture('workflow-export');
  delete data.workflow.configuration.nodes[1].config;
  assert.ok(codes(run(data)).includes('missing_node_config'));
});
