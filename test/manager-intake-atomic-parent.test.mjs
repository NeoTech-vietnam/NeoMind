// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { loadRecords, getRecord, safePath } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-atomic-intake-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'ATOMIC', profile: 'basic' });
  return root;
}
function observeParentWrites(root, action, observe) {
  const original = fs.writeFileSync;
  fs.writeFileSync = function(path, data, ...rest) {
    if (typeof path === 'string' && path.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/.neomind/records/')) {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(data));
      if (frontmatter) {
        const meta = parse(frontmatter[1]);
        if (meta.data?.kind === 'manager-workflow') observe(meta);
      }
    }
    return Reflect.apply(original, this, [path, data, ...rest]);
  };
  syncBuiltinESMExports();
  try { return action(); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
}
function assertComplete(root, parent, requirements) {
  const records = loadRecords(root), rootRequirement = records.find(record => record.meta.id === parent.meta.data.requirement_id);
  assert.equal(rootRequirement.meta.data.intake_workflow_id, parent.meta.id);
  assert.equal(rootRequirement.meta.data.batch_item, undefined);
  const leaves = parent.meta.data.requirement_ids;
  assert.equal(leaves.length, requirements.length);
  if (requirements.length === 1) assert.deepEqual(leaves, [rootRequirement.meta.id]);
  else for (const [index, id] of leaves.entries()) {
    const leaf = records.find(record => record.meta.id === id);
    assert.equal(leaf.meta.data.intake_workflow_id, parent.meta.id); assert.equal(leaf.meta.data.batch_item, index);
    assert.ok(leaf.meta.links.some(link => link.type === 'derives-from' && link.target === rootRequirement.meta.id));
  }
  const linked = new Set(parent.meta.links.filter(link => link.type === 'documents').map(link => link.target));
  assert.deepEqual([...linked].sort(), [...new Set([rootRequirement.meta.id, ...leaves])].sort());
  return records.map(record => record.meta.id).sort();
}

for (const requirements of [['Deliver scalar six.'], ['Deliver scalar six.', 'Independently document the scalar.']]) {
  const family = requirements.length === 1 ? 'single' : 'batch';
  const input = { requirements, request_id: `atomic-${family}`, execution_mode: 'neomind-controlled' };
  test(`new ${family} intake publishes complete requirement links together and same-nonce replay preserves IDs`, t => {
    const root = fixture(t), linkedWrites = [];
    const parent = observeParentWrites(root, () => beginWorkflow(root, input), meta => {
      if (meta.data.requirement_id !== undefined || meta.data.requirement_ids !== undefined) linkedWrites.push(meta);
    });
    assert.ok(linkedWrites.length > 0);
    for (const write of linkedWrites) {
      assert.equal(typeof write.data.requirement_id, 'string');
      assert.equal(write.data.requirement_ids?.length, requirements.length,
        'No observable parent write may publish only a root link while its final leaves remain unbound.');
    }
    const ids = assertComplete(root, parent, requirements), bytes = readFileSync(safePath(root, parent.path));
    const replay = beginWorkflow(root, input);
    assert.equal(replay.meta.id, parent.meta.id); assert.deepEqual(assertComplete(root, replay, requirements), ids);
    assert.deepEqual(readFileSync(safePath(root, parent.path)), bytes);
  });

  test(`interrupted ${family} root/leaf creation recovers the same IDs before one final parent binding`, t => {
    const root = fixture(t);
    assert.throws(() => observeParentWrites(root, () => beginWorkflow(root, input), meta => {
      if (meta.data.requirement_id && Array.isArray(meta.data.requirement_ids)) throw new Error('Fixture interruption before final parent publication.');
    }), /Fixture interruption/);
    const existing = loadRecords(root), parent = existing.find(record => record.meta.data.kind === 'manager-workflow');
    assert.equal(parent.meta.data.requirement_id, undefined, 'Interrupted admission must not leave a partially linked parent.');
    assert.equal(parent.meta.data.requirement_ids, undefined);
    const requirementsBefore = existing.filter(record => record.meta.type === 'requirement');
    assert.equal(requirementsBefore.length, requirements.length === 1 ? 1 : requirements.length + 1);
    const ids = existing.map(record => record.meta.id).sort(), recovered = beginWorkflow(root, input);
    assert.equal(recovered.meta.id, parent.meta.id);
    assert.deepEqual(assertComplete(root, recovered, requirements), ids);
    for (const record of requirementsBefore) assert.deepEqual(getRecord(root, record.meta.id), record);
  });
}
