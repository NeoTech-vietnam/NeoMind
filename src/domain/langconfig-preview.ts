/** Read-only structural preview; never a Flow or an authorization to execute.
 * LangConfig eb786cf8: backend/schemas/workflow_blueprint.py,
 * backend/services/workflow_config_service.py and core/workflows/executor.py.
 */
export const LANGCONFIG_PREVIEW_LIMITS = { bytes: 1_048_576, nodes: 500, edges: 2000, values: 20_000, depth: 64 } as const;

export interface LangConfigDiagnostic { code: string; location: string; message: string }
export interface LangConfigPreviewNode { id: string; suggestedType?: 'start' | 'finish' }
export interface LangConfigPreviewEdge { from: string; to: string; suggestedOutcome?: 'completed' }
export interface LangConfigPreview {
  format: 'neomind-langconfig-preview-v1'; executable: false;
  sourceFormat?: 'blueprint' | 'workflow-export-1.0';
  entry?: string; nodes: LangConfigPreviewNode[]; edges: LangConfigPreviewEdge[]; diagnostics: LangConfigDiagnostic[];
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const nonempty = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(object(v) && Object.keys(v).length === 0);

// JSON.parse alone silently accepts duplicate keys. This bounded parser rejects them
// before any graph interpretation and never returns a parser error containing input.
class JsonReader {
  private pos = 0;
  private values = 0;
  private readonly primitive = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  constructor(private readonly text: string) {}
  private fail(code = 'invalid_json'): never { throw new Error(code); }
  private space() { while (/[\x20\t\r\n]/.test(this.text[this.pos] ?? '\0')) this.pos++; }
  private string(): string {
    const start = this.pos++;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++]!;
      if (ch === '"') {
        let value: unknown;
        try { value = JSON.parse(this.text.slice(start, this.pos)); } catch { return this.fail(); }
        if (typeof value !== 'string' || invalidUnicode.test(value)) return this.fail();
        return value;
      }
      if (ch === '\\') this.pos++;
    }
    return this.fail();
  }
  private value(depth: number): unknown {
    if (++this.values > LANGCONFIG_PREVIEW_LIMITS.values || depth > LANGCONFIG_PREVIEW_LIMITS.depth) return this.fail('input_limit');
    this.space();
    const ch = this.text[this.pos];
    if (ch === '"') return this.string();
    if (ch === '{') {
      this.pos++; this.space();
      const result: Obj = Object.create(null), keys = new Set<string>();
      if (this.text[this.pos] === '}') { this.pos++; return result; }
      while (true) {
        this.space();
        if (this.text[this.pos] !== '"') return this.fail();
        if (++this.values > LANGCONFIG_PREVIEW_LIMITS.values) return this.fail('input_limit');
        const key = this.string();
        if (keys.has(key)) return this.fail();
        keys.add(key); this.space();
        if (this.text[this.pos++] !== ':') return this.fail();
        result[key] = this.value(depth + 1); this.space();
        const sep = this.text[this.pos++];
        if (sep === '}') return result;
        if (sep !== ',') return this.fail();
      }
    }
    if (ch === '[') {
      this.pos++; this.space(); const result: unknown[] = [];
      if (this.text[this.pos] === ']') { this.pos++; return result; }
      while (true) {
        result.push(this.value(depth + 1)); this.space();
        const sep = this.text[this.pos++];
        if (sep === ']') return result;
        if (sep !== ',') return this.fail();
      }
    }
    this.primitive.lastIndex = this.pos;
    const match = this.primitive.exec(this.text);
    if (!match) return this.fail();
    this.pos += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) return this.fail();
    return result;
  }
  read(): unknown {
    const value = this.value(0); this.space();
    if (this.pos !== this.text.length) return this.fail();
    return value;
  }
}

/** Takes JSON text only: no getters, external I/O, caller objects, or implicit execution. */
export function previewLangConfigJson(input: unknown): LangConfigPreview {
  const result: LangConfigPreview = { format: 'neomind-langconfig-preview-v1', executable: false, nodes: [], edges: [], diagnostics: [] };
  const issue = (code: string, location: string, message: string) => result.diagnostics.push({ code, location, message });
  const extra = (value: Obj, known: string[], location: string) => {
    if (Object.keys(value).some(key => !known.includes(key))) issue('unsupported_field', location, 'Unrecognized fields are not interpreted or copied.');
  };
  if (typeof input !== 'string') { issue('invalid_input', '$', 'Expected JSON text.'); return result; }
  if (input.length > LANGCONFIG_PREVIEW_LIMITS.bytes || Buffer.byteLength(input, 'utf8') > LANGCONFIG_PREVIEW_LIMITS.bytes) {
    issue('input_limit', '$', 'Input exceeds the byte limit.'); return result;
  }
  let root: unknown;
  try { root = new JsonReader(input).read(); } catch (error) {
    issue(error instanceof Error && error.message === 'input_limit' ? 'input_limit' : 'invalid_json', '$', 'JSON is invalid or exceeds parsing limits.'); return result;
  }
  if (!object(root)) { issue('invalid_input', '$', 'Expected an object.'); return result; }
  const exported = 'workflow' in root || root.export_type === 'workflow';
  let graph: Obj;
  let base: string;
  if (exported) {
    if (root.export_type !== 'workflow' || root.version !== '1.0') { issue('unsupported_format', '$', 'Expected workflow export version 1.0.'); return result; }
    result.sourceFormat = 'workflow-export-1.0';
    extra(root, ['version', 'langconfig_version', 'export_type', 'metadata', 'workflow', 'custom_tools', 'deepagents'], '$');
    for (const key of ['langconfig_version', 'metadata', 'custom_tools', 'deepagents']) if (nonempty(root[key])) issue('lossy_field', `$.${key}`, 'Field is not copied.');
    if (!object(root.workflow)) { issue('invalid_input', '$.workflow', 'Expected a workflow object.'); return result; }
    const workflow = root.workflow;
    extra(workflow, ['name', 'description', 'strategy_type', 'configuration', 'blueprint'], '$.workflow');
    for (const key of ['name', 'description', 'strategy_type', 'blueprint']) if (nonempty(workflow[key])) issue('lossy_field', `$.workflow.${key}`, 'Field is not copied or interpreted.');
    if (!object(workflow.configuration)) { issue('invalid_input', '$.workflow.configuration', 'Configuration is required; blueprint is not substituted.'); return result; }
    graph = workflow.configuration; base = '$.workflow.configuration';
  } else {
    result.sourceFormat = 'blueprint'; graph = root; base = '$';
    extra(graph, ['strategy_type', 'name', 'description', 'version', 'nodes', 'edges', 'entry_point_id', 'metadata'], base);
    for (const key of ['strategy_type', 'name', 'description', 'version', 'metadata']) if (nonempty(graph[key])) issue('lossy_field', `$.${key}`, 'Field is not copied.');
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) { issue('invalid_input', base, 'Expected node and edge arrays.'); return result; }
  if (graph.nodes.length > LANGCONFIG_PREVIEW_LIMITS.nodes || graph.edges.length > LANGCONFIG_PREVIEW_LIMITS.edges) {
    issue('graph_limit', base, 'Graph exceeds limits; no partial graph is produced.'); return result;
  }
  if (exported) extra(graph, ['nodes', 'edges'], base);
  if (!graph.nodes.length) issue('empty_graph', `${base}.nodes`, 'Graph has no nodes.');
  const idKey = exported ? 'id' : 'node_id';
  const counts = new Map<string, number>();
  for (const node of graph.nodes) if (object(node) && typeof node[idKey] === 'string') counts.set(node[idKey], (counts.get(node[idKey]) ?? 0) + 1);
  const ids = new Map<string, { alias: string; type: string }>();
  graph.nodes.forEach((raw: unknown, index: number) => {
    const loc = `${base}.nodes[${index}]`;
    if (!object(raw)) { issue('invalid_node', loc, 'Expected an object.'); return; }
    extra(raw, exported ? ['id', 'type', 'data', 'config', 'position'] : ['node_id', 'display_name', 'node_type', 'handler_function', 'metadata', 'agent_config'], loc);
    const id = raw[idKey];
    if (typeof id !== 'string' || !id || id === '__END__' || (!exported && !idPattern.test(id))) { issue('invalid_node_id', loc, 'Invalid node ID.'); return; }
    if (counts.get(id) !== 1) { issue('duplicate_node_id', loc, 'Duplicate ID is ambiguous.'); return; }
    let kind: string;
    let suggestion: 'start' | 'finish' | undefined;
    if (exported) {
      const data = raw.data === undefined ? {} : raw.data;
      if (!object(data)) { issue('invalid_node_data', `${loc}.data`, 'Expected an object.'); return; }
      extra(data, ['agentType'], `${loc}.data`);
      for (const key of ['config', 'position']) if (nonempty(raw[key])) issue('lossy_field', `${loc}.${key}`, 'Field is not copied.');
      const top = raw.type === undefined ? 'default' : raw.type, nested = data.agentType === undefined ? '' : data.agentType;
      if (typeof top !== 'string' || typeof nested !== 'string') { issue('invalid_node_type', loc, 'Expected string types.'); return; }
      kind = top === 'default' ? nested || 'default' : top;
      if (kind !== 'START_NODE' && kind !== 'END_NODE' && !object(raw.config)) issue('missing_node_config', `${loc}.config`, 'Top-level config is missing or invalid; nested config is not substituted.');
      if ((top === 'START_NODE' || top === 'END_NODE') && (!nested || top === nested)) suggestion = top === 'START_NODE' ? 'start' : 'finish';
      if (top === 'default' && nested) issue('ambiguous_type_resolution', loc, 'Fallback node and routing types may differ.');
      else if (nested && top !== nested) issue('conflicting_node_type', loc, 'Node types conflict.');
    } else {
      if (typeof raw.display_name !== 'string' || !raw.display_name) { issue('invalid_label', loc, 'Expected a non-empty display name.'); return; }
      if (typeof raw.node_type !== 'string' || !raw.node_type) { issue('invalid_node_type', loc, 'Expected a non-empty node type.'); return; }
      kind = raw.node_type;
      if (kind === 'start' || kind === 'end') suggestion = kind === 'start' ? 'start' : 'finish';
      for (const key of ['handler_function', 'agent_config', 'metadata']) if (nonempty(raw[key])) issue('lossy_field', `${loc}.${key}`, 'Field is not copied.');
    }
    const alias = `node-${index}`;
    ids.set(id, { alias, type: kind });
    result.nodes.push({ id: alias, ...(suggestion ? { suggestedType: suggestion } : {}) });
    issue(suggestion ? 'approximate_node' : 'unsupported_node', loc, suggestion ? 'Boundary is a visual suggestion only.' : 'Node type has no established mapping; loops are not repair.');
  });
  if (!exported) {
    const entry = typeof graph.entry_point_id === 'string' ? ids.get(graph.entry_point_id) : undefined;
    if (!entry) issue('invalid_entry', '$.entry_point_id', 'Entry must identify a valid unambiguous node.');
    else { result.entry = entry.alias; if (entry.type !== 'start') issue('entry_not_start', '$.entry_point_id', 'Entry is not a start node.'); }
  } else issue('entry_not_inferred', base, 'Runtime entry selection is not reproduced.');
  const adjacency = new Map(result.nodes.map(node => [node.id, [] as string[]]));
  const pairs = new Set<string>();
  graph.edges.forEach((raw: unknown, index: number) => {
    const loc = `${base}.edges[${index}]`;
    if (!object(raw)) { issue('invalid_edge', loc, 'Expected an object.'); return; }
    extra(raw, exported ? ['source', 'target', 'data'] : ['source_id', 'target_id', 'edge_type', 'condition_function', 'routing_map'], loc);
    if (exported && nonempty(raw.data)) issue('lossy_field', `${loc}.data`, 'Routing data is not copied.');
    if (!exported && raw.edge_type !== undefined && raw.edge_type !== 'direct') { issue('unsupported_edge', loc, 'Conditional routing is not mapped.'); return; }
    if (!exported && (raw.condition_function != null || raw.routing_map != null)) { issue('ambiguous_edge', loc, 'Direct edge has routing configuration.'); return; }
    const source = raw[exported ? 'source' : 'source_id'], target = raw[exported ? 'target' : 'target_id'];
    if (target === '__END__') { issue('unsupported_terminal', loc, 'Implicit terminal is not synthesized.'); return; }
    const from = typeof source === 'string' ? ids.get(source) : undefined, to = typeof target === 'string' ? ids.get(target) : undefined;
    if (!from || !to) { issue('invalid_edge_reference', loc, 'Edge must reference valid unambiguous source IDs.'); return; }
    const key = `${from.alias}:${to.alias}`;
    if (!exported && pairs.has(key)) { issue('duplicate_edge', loc, 'Duplicate edge is not represented twice.'); return; }
    pairs.add(key); adjacency.get(from.alias)!.push(to.alias);
    result.edges.push({ from: from.alias, to: to.alias, ...(!exported ? { suggestedOutcome: 'completed' as const } : {}) });
    issue(exported ? 'unsupported_edge' : 'approximate_edge', loc, 'Only structural connectivity is shown; runtime equivalence is not established.');
    if (exported && (from.type === 'CONDITIONAL_NODE' || from.type === 'LOOP_NODE')) issue('unsupported_routing', loc, 'Conditional or loop routing is not mapped.');
  });
  const degrees = new Map(result.nodes.map(node => [node.id, 0]));
  for (const targets of adjacency.values()) for (const target of targets) degrees.set(target, degrees.get(target)! + 1);
  const ready = [...degrees].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) { const id = ready.pop()!; visited++; for (const target of adjacency.get(id)!) { const count = degrees.get(target)! - 1; degrees.set(target, count); if (!count) ready.push(target); } }
  if (visited !== degrees.size) issue('cycle', `${base}.edges`, 'Cycles are not converted to repair.');
  return result;
}
