import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { materializeRun } from '../src/domain/materialize.js';
import { defaultProject, templates } from '../src/domain/templates.js';
import type { Profile } from '../src/domain/schema.js';

const binding = { runner: 'codex', provider: 'example', model: 'model', reasoning: 'high' };
const project = { ...defaultProject, roleDefaults: { implementer: binding, verifier: binding } };
const permissions = { read: true, write: true, checks: true, gitCommit: false };
const reviewerPermissions = { ...permissions, write: false };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function profiles(content: string): Record<string, Profile> {
  return {
    'implementer@1': { schemaVersion: 1, profileId: 'implementer', version: 1, name: 'Implementer', instructions: 'Implement',
      skills: [{ id: 'coding', path: 'skills/coding.md', sha256: hash(content) }], requestedPermissions: permissions, outputDefaults: {} },
    'verifier@1': { schemaVersion: 1, profileId: 'verifier', version: 1, name: 'Verifier', instructions: 'Review independently',
      skills: [], requestedPermissions: reviewerPermissions, outputDefaults: {} },
  };
}

test('materialization pins profile instructions, skill bytes and binding provenance per step', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-materialize-'));
  await mkdir(path.join(root, 'skills'));
  await writeFile(path.join(root, 'skills/coding.md'), 'Original skill');
  const flow = structuredClone(templates.dev);
  const implement = flow.definition.nodes.find(n => n.id === 'implement')!;
  if (implement.type !== 'agent_task') throw new Error('bad fixture');
  implement.instructionsOverride = 'Only implement the approved scope';
  const result = await materializeRun(flow, project, profiles('Original skill'), root);
  await writeFile(path.join(root, 'skills/coding.md'), 'Changed after start');
  assert.equal(result.profilesByStep.implement?.skills[0]?.content, 'Original skill');
  assert.equal(result.profilesByStep.implement?.instructions, 'Only implement the approved scope');
  assert.equal(result.profilesByStep['verify/required-reviewer']?.instructions, 'Review independently');
  assert.equal(result.configuration.bindings.implement?.sources.model, 'project');
  await assert.rejects(materializeRun(flow, project, profiles('Original skill'), root), /Skill hash mismatch/);
});

test('materialization rejects missing versions, overprivileged reviewers and symlink escape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-materialize-safe-'));
  const external = await mkdtemp(path.join(tmpdir(), 'neomind-materialize-outside-'));
  await mkdir(path.join(root, 'skills'));
  await writeFile(path.join(external, 'secret.md'), 'secret');
  await symlink(path.join(external, 'secret.md'), path.join(root, 'skills/coding.md'));
  await assert.rejects(materializeRun(templates.dev, project, profiles('secret'), root), /escapes project root/);
  const noSkills = profiles('secret');
  noSkills['implementer@1']!.skills = [];
  delete noSkills['verifier@1'];
  await assert.rejects(materializeRun(templates.dev, project, noSkills, root));
  const unsafe = profiles('secret');
  unsafe['implementer@1']!.skills = [];
  unsafe['verifier@1']!.requestedPermissions.write = true;
  await assert.rejects(materializeRun(templates.dev, project, unsafe, root), /Reviewer profile.*cannot request/);
});

test('materialization rejects a step whose requested permissions exceed its profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-materialize-perms-'));
  const data = profiles('unused');
  data['implementer@1']!.skills = [];
  data['implementer@1']!.requestedPermissions.write = false;
  await assert.rejects(materializeRun(templates.dev, project, data, root), /exceeds profile permission write/);
});
