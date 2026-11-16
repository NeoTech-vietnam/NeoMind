export const MAX_LANGCONFIG_FILE_BYTES = 1024 * 1024;

type SafePreview = { source: string; nodes: { id: string; kind: string }[]; edges: { from: string; to: string; outcome: string }[]; diagnostics: { location: string; message: string }[] };
const messages: Record<string, string> = {
  invalid_json: 'JSON không hợp lệ hoặc có key trùng.', invalid_input: 'Cấu trúc đầu vào không hợp lệ.', input_limit: 'Dữ liệu vượt giới hạn xử lý.',
  graph_limit: 'Graph vượt giới hạn số bước hoặc kết nối.', unsupported_format: 'Định dạng hoặc phiên bản chưa được hỗ trợ.',
  unsupported_field: 'Có trường chưa được hỗ trợ.', lossy_field: 'Có dữ liệu không được đưa vào bản xem trước.', empty_graph: 'Graph không có bước.',
  invalid_node: 'Bước không hợp lệ.', invalid_node_id: 'ID bước không hợp lệ.', duplicate_node_id: 'ID bước bị trùng.',
  invalid_label: 'Thiếu tên bước.', invalid_node_type: 'Loại bước không hợp lệ.', invalid_node_data: 'Dữ liệu bước không hợp lệ.',
  unsupported_node: 'Loại bước chưa có ánh xạ; loop không tương đương vòng sửa.', approximate_node: 'Loại bước chỉ là gợi ý gần đúng.',
  missing_node_config: 'Thiếu cấu hình bước cấp cao nhất.', ambiguous_type_resolution: 'Cách xác định loại bước chưa rõ ràng.', conflicting_node_type: 'Loại bước không nhất quán.',
  invalid_entry: 'Điểm bắt đầu không hợp lệ.', entry_not_start: 'Điểm vào không phải bước bắt đầu.', entry_not_inferred: 'Chưa xác định điểm vào runtime.',
  invalid_edge: 'Kết nối không hợp lệ.', invalid_edge_reference: 'Kết nối tham chiếu bước không hợp lệ hoặc bị trùng.', duplicate_edge: 'Kết nối bị trùng.',
  unsupported_edge: 'Chưa ánh xạ ngữ nghĩa kết nối.', approximate_edge: 'Kết nối chỉ là gợi ý gần đúng.', ambiguous_edge: 'Kết nối có cấu hình định tuyến chưa rõ.',
  unsupported_terminal: 'Điểm kết thúc ngầm chưa được ánh xạ.', unsupported_routing: 'Định tuyến điều kiện hoặc loop chưa được ánh xạ.', cycle: 'Graph có vòng; không tự chuyển thành vòng sửa.',
};
const obj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const alias = (value: unknown): value is string => typeof value === 'string' && /^node-(?:0|[1-9]\d{0,2})$/.test(value);
const location = (value: unknown): string => typeof value === 'string' && /^\$(?:\.(?:workflow|configuration|nodes|edges|data|config|position|name|description|strategy_type|blueprint|version|metadata|langconfig_version|custom_tools|deepagents|entry_point_id|handler_function|agent_config)|\[\d{1,4}\])*$/.test(value) ? value : '$';

/** Only render fixed labels, generated aliases and allowlisted locations; never raw input or API error text. */
export function safeLangConfigPreview(value: unknown): SafePreview | null {
  if (!obj(value) || value.format !== 'neomind-langconfig-preview-v1' || value.executable !== false || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.diagnostics) || value.nodes.length > 500 || value.edges.length > 2000 || value.diagnostics.length > 12000) return null;
  const nodes: SafePreview['nodes'] = [], edges: SafePreview['edges'] = [], diagnostics: SafePreview['diagnostics'] = [];
  for (const node of value.nodes) {
    if (!obj(node) || !alias(node.id)) return null;
    nodes.push({ id: node.id, kind: node.suggestedType === 'start' ? 'Gợi ý bắt đầu' : node.suggestedType === 'finish' ? 'Gợi ý kết thúc' : 'Chưa ánh xạ' });
  }
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) return null;
  for (const edge of value.edges) {
    if (!obj(edge) || !alias(edge.from) || !alias(edge.to) || !ids.has(edge.from) || !ids.has(edge.to)) return null;
    edges.push({ from: edge.from, to: edge.to, outcome: edge.suggestedOutcome === 'completed' ? ' · gợi ý completed' : '' });
  }
  for (const item of value.diagnostics) {
    if (!obj(item)) return null;
    diagnostics.push({ location: location(item.location), message: typeof item.code === 'string' && Object.hasOwn(messages, item.code) ? messages[item.code]! : 'Có chẩn đoán chưa được nhận diện.' });
  }
  return { source: value.sourceFormat === 'blueprint' ? 'Blueprint' : value.sourceFormat === 'workflow-export-1.0' ? 'Workflow export 1.0' : 'Chưa xác định', nodes, edges, diagnostics };
}

export async function readLangConfigFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (file.size > MAX_LANGCONFIG_FILE_BYTES) throw new Error('size');
  const data = await file.arrayBuffer();
  if (data.byteLength > MAX_LANGCONFIG_FILE_BYTES) throw new Error('size');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('encoding'); }
}
