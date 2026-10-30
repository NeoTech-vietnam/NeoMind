import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { canvasToFlow, flowToCanvas, FLOW_CANVAS_FORMAT, type FlowCanvas } from '../src/domain/flow-canvas.js';
import { templates } from '../src/domain/templates.js';
import { compileFlow } from '../src/domain/compiler.js';
import { defaultProject } from '../src/domain/templates.js';
import { flowSchema, type Flow } from '../src/domain/schema.js';
import { FlowLibrary } from '../src/storage/flow-library.js';

/** The Dev template with a studio layout and a Claude writer, as a user would have it. */
function devFlow(): Flow {
  const flow = structuredClone(templates.dev);
  flow.definition.nodes.forEach((node, index) => { flow.layout[node.id] = { x: 80 + (index % 4) * 255, y: 110 + Math.floor(index / 4) * 165 }; });
  flow.definition.bindings.implementer = { ...flow.definition.bindings.implementer!, runner: { mode: 'pinned', value: 'claude-code' }, provider: { mode: 'pinned', value: 'anthropic' }, model: { mode: 'pinned', value: 'claude-sonnet-5-5' } };
  return flowSchema.parse(flow);
}
const card = (canvas: FlowCanvas, id: string) => canvas.nodes.find(node => node.id === id)!;
/** What a canvas editor that keeps only JSON Canvas spec fields would write back. */
function specOnly(canvas: FlowCanvas): unknown {
  const strip = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('x-')));
  return { nodes: canvas.nodes.map(strip), edges: canvas.edges.map(strip) };
}

test('a flow becomes a JSON Canvas board that Nimbalyst and Obsidian can open', () => {
  const roles = { implementer: { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' }, verifier: { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' } };
  const flow = devFlow(), canvas = flowToCanvas(flow, 'rev-1', { ...structuredClone(defaultProject), roleDefaults: roles });
  const steps = canvas.nodes.filter(node => !node.id.startsWith('neomind-'));
  assert.equal(steps.length, flow.definition.nodes.length);
  for (const node of canvas.nodes) {
    assert.equal(node.type, 'text');
    for (const value of [node.x, node.y, node.width, node.height]) assert.ok(Number.isInteger(value) && value % 20 === 0, `${node.id} is on the 20px grid`);
    assert.ok(!(node.text ?? '').includes('**'), 'card text is plain text, not markdown');
  }
  // Each card is a step; its second line says who does it, and agent steps show the runner/model the project resolves.
  assert.equal(card(canvas, 'implement').text, 'Implement\nAgent task · Agent sửa code\nClaude Code · Sonnet 5.5 · suy luận thấp');
  assert.equal(card(canvas, 'plan').text, 'Plan\nAgent task · Agent chỉ đọc\nClaude Code · Sonnet 5.5 · suy luận thấp', 'plan shares the implementer binding');
  assert.equal(card(canvas, 'approval').text?.split('\n')[1], 'Duyệt · Bạn duyệt');
  assert.equal(card(canvas, 'verify').text, 'Independent review\nReview · Agent review độc lập · 1/1 bắt buộc đạt\nrequired-reviewer: Codex · GPT-6 Luna · suy luận vừa');
  assert.deepEqual(['plan', 'approval', 'verify', 'commit'].map(id => card(canvas, id).color), ['2', '3', '6', '4'], 'color by who does the step');
  assert.match(card(canvas, 'neomind-legend').text ?? '', /Cam: agent/);
  // Edges follow the layout: Implement ends row 1, Bounded repair starts row 2.
  const wrap = canvas.edges.find(edge => edge.fromNode === 'implement' && edge.toNode === 'repair') as Record<string, unknown>;
  assert.deepEqual([wrap.fromSide, wrap.toSide], ['bottom', 'top']);
  assert.match(canvas.edges.find(edge => edge.id === 'loop-verify-implement')?.label ?? '', /^↺ chưa đạt: sửa lại \(tối đa 2 vòng\)/);
  const ids = new Set(canvas.nodes.map(node => node.id));
  for (const edge of canvas.edges) assert.ok(ids.has(edge.fromNode) && ids.has(edge.toNode));
  // The illustrative repair loop never becomes a transition, with or without NeoMind keys.
  for (const board of [canvas, specOnly(canvas)]) assert.ok(!canvasToFlow(board, flow).flow.definition.edges.some(edge => edge.from === 'verify' && edge.to === 'implement'));
  assert.equal(canvas.edges.find(edge => edge.fromNode === 'approval')?.label, 'pass');
  assert.equal(canvas.edges.find(edge => edge.fromNode === 'start')?.label, undefined, 'completed edges carry no label');
  assert.equal(canvas['x-neomind']?.format, FLOW_CANVAS_FORMAT);
  assert.equal((canvas as unknown as { 'x-nimbalyst': { meta: { name: string } } })['x-nimbalyst'].meta.name, `Flow · ${flow.name}`);
});

test('exporting and importing a board without edits gives back the same flow', () => {
  const flow = devFlow(), canvas = JSON.parse(JSON.stringify(flowToCanvas(flow))) as FlowCanvas;
  for (const [current, label] of [[flow, 'with the draft'], [undefined, 'from the board alone']] as const) {
    const { flow: imported, report } = canvasToFlow(canvas, current);
    // With a draft, positions are kept exactly; from the board alone they come back within the 20px canvas grid.
    if (current) assert.deepEqual(imported, flow, label);
    else {
      assert.deepEqual({ ...imported, layout: {} }, { ...flow, layout: {} }, label);
      for (const [id, position] of Object.entries(flow.layout)) assert.ok(Math.abs(imported.layout[id]!.x - position.x) <= 15 && Math.abs(imported.layout[id]!.y - position.y) <= 15, id);
    }
    assert.deepEqual([report.added, report.removed, report.renamed, report.retyped], [[], [], [], []]);
    if (current) assert.equal(report.moved, 0);
  }
});

test('edits made on the board are applied: move, rename, retype, delete, add, connect', () => {
  const flow = devFlow(), canvas = JSON.parse(JSON.stringify(flowToCanvas(flow))) as FlowCanvas;
  card(canvas, 'implement').x += 280;
  card(canvas, 'plan').text = 'Khảo sát và lập kế hoạch\nAgent task · Chỉ đọc';
  card(canvas, 'approval').text = 'Approve plan\nReview';
  canvas.nodes = canvas.nodes.filter(node => node.id !== 'repair');
  canvas.nodes.push({ id: '7f3a9c2e1b4d6a80', type: 'text', x: 1400, y: 400, width: 260, height: 140, text: 'Security review\nReview' },
    { id: 'note1', type: 'text', x: 0, y: 900, width: 240, height: 180, text: 'Hỏi lại team: có cần review bảo mật cho mọi run?' });
  canvas.edges = canvas.edges.filter(edge => edge.fromNode !== 'repair' && edge.toNode !== 'repair');
  canvas.edges.push({ id: 'n1', fromNode: 'implement', toNode: 'verify' }, { id: 'n2', fromNode: 'verify', toNode: '7f3a9c2e1b4d6a80', label: 'needs_changes' },
    { id: 'n3', fromNode: '7f3a9c2e1b4d6a80', toNode: 'commit' }, { id: 'n4', fromNode: 'note1', toNode: 'commit' }, { id: 'n5', fromNode: 'commit', toNode: 'finish', label: 'xong' });
  const { flow: next, report } = canvasToFlow(canvas, flow);
  assert.deepEqual(report.added, ['security-review']); assert.deepEqual(report.removed, ['repair']);
  assert.deepEqual(report.renamed, ['plan']); assert.deepEqual(report.retyped, ['approval']); assert.equal(report.notesIgnored, 1);
  assert.match(report.warnings.join(' '), /"xong"/);
  assert.ok(Math.abs(next.layout.implement!.x - (flow.layout.implement!.x + 200)) <= 15);
  assert.equal(next.definition.nodes.find(node => node.id === 'plan')?.label, 'Khảo sát và lập kế hoạch');
  assert.equal(next.definition.nodes.find(node => node.id === 'approval')?.type, 'review_group');
  const added = next.definition.nodes.find(node => node.id === 'security-review');
  assert.equal(added?.type, 'review_group'); assert.equal(added?.label, 'Security review');
  // Configuration of untouched steps is kept; edges get their outcome from the label or the source kind.
  assert.deepEqual(next.definition.nodes.find(node => node.id === 'implement'), flow.definition.nodes.find(node => node.id === 'implement'));
  assert.deepEqual(next.definition.edges.filter(edge => ['n1', 'n2', 'n3'].some(() => true) && (edge.to === 'security-review' || edge.from === 'security-review' || (edge.from === 'implement' && edge.to === 'verify'))),
    [{ from: 'implement', to: 'verify', outcome: 'completed' }, { from: 'verify', to: 'security-review', outcome: 'needs_changes' }, { from: 'security-review', to: 'commit', outcome: 'pass' }]);
  assert.ok(next.definition.edges.some(edge => edge.from === 'commit' && edge.to === 'finish' && edge.outcome === 'completed'));
  assert.ok(!next.definition.edges.some(edge => edge.from === 'repair' || edge.to === 'repair'));
  assert.ok(Array.isArray(compileFlow(next, defaultProject.policy).ok ? [] : (compileFlow(next, defaultProject.policy) as { diagnostics: unknown[] }).diagnostics));
});

test('a canvas editor that drops NeoMind keys loses no step configuration', () => {
  const flow = devFlow(), stripped = specOnly(flowToCanvas(flow));
  const { flow: imported } = canvasToFlow(stripped, flow);
  assert.deepEqual(imported, flow);
  assert.throws(() => canvasToFlow(stripped), /không có dữ liệu flow NeoMind/);
});

test('a stale board warns, and a board cannot be applied to another flow', async () => {
  const flow = devFlow(), canvas = flowToCanvas(flow, 'old-revision');
  assert.match(canvasToFlow(canvas, flow, 'new-revision').report.warnings.join(' '), /Draft đã đổi sau khi xuất canvas/);
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-flow-canvas-')), library = new FlowLibrary(root);
  await library.create('dev', 'Dev'); await library.saveDraft('dev', flow);
  const { file } = await library.exportCanvas('dev');
  assert.equal(file, library.canvasFile('dev'));
  const board = JSON.parse(await readFile(file, 'utf8')) as FlowCanvas;
  card(board, 'plan').text = 'Plan v2\nAgent task';
  await writeFile(file, JSON.stringify(board));
  const before = await library.draftRevision('dev'), result = await library.importCanvas('dev');
  assert.notEqual(result.revision, before);
  assert.equal((await library.readDraft('dev') as Flow).definition.nodes.find(node => node.id === 'plan')?.label, 'Plan v2');
  await library.create('other', 'Other'); await library.saveDraft('other', { ...flow, flowId: 'other' });
  await assert.rejects(library.importCanvas('other', file), /Canvas thuộc flow khác \(dev\)/);
});

test('cards never overlap on the board, even when a studio step sits close to another row', () => {
  const flow = devFlow();
  flow.definition.nodes.push({ id: 'agent_task-1', label: 'Agent task', type: 'agent_task', goal: 'Mô tả công việc', profileId: 'implementer', profileVersion: 1,
    sessionGroup: 'implementation-session', bindingId: 'implementer', permissions: { read: true, write: false, checks: true, gitCommit: false }, writeScopes: [], outputContract: 'result' });
  flow.layout['agent_task-1'] = { x: flow.layout.repair!.x + 180, y: flow.layout.repair!.y + 75 };
  const cards = flowToCanvas(flow).nodes;
  for (const a of cards) for (const b of cards) {
    if (a === b) continue;
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
  // Long lines wrap: the review card is tall enough for its reviewer line.
  const review = cards.find(card => card.id === 'verify')!;
  assert.ok(review.height >= 160, `review card height ${review.height}`);
});
