import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateNodes } from '../src/domain/duplicate-nodes.js';
import { templates } from '../src/domain/templates.js';

test('duplicating a subgraph remaps internal references and edges without changing the source', () => {
  const source = structuredClone(templates.dev); source.layout.implement = { x: 100, y: 200 };
  const before = structuredClone(source);
  const result = duplicateNodes(source, source, ['implement', 'verify', 'repair', 'start']);
  assert.deepEqual(source, before);
  assert.equal(result.ids.length, 3);
  const writer = result.ids.find(id => id.startsWith('agent_task-'))!, review = result.ids.find(id => id.startsWith('review_group-'))!, repair = result.ids.find(id => id.startsWith('repair_scope-'))!;
  const reviewNode = result.flow.definition.nodes.find(node => node.id === review);
  const repairNode = result.flow.definition.nodes.find(node => node.id === repair);
  assert.ok(reviewNode?.type === 'review_group'); assert.equal(reviewNode.targetNodeId, writer);
  assert.ok(repairNode?.type === 'repair_scope'); assert.equal(repairNode.targetReviewId, review); assert.ok(repairNode.ownerNodeIds.includes(writer!));
  assert.ok(result.flow.definition.edges.some(edge => edge.from === writer && edge.to === repair));
  assert.ok(result.flow.definition.edges.some(edge => edge.from === repair && edge.to === review));
  assert.ok(!result.flow.definition.edges.some(edge => edge.from === review && edge.to === 'repair'));
  assert.notDeepEqual(result.flow.layout[review!], result.flow.layout[repair!], 'unsaved layout preserves the canvas grid when copying several nodes');
  assert.equal(result.flow.layout[writer!]!.x, source.layout.implement!.x + 36);
});
