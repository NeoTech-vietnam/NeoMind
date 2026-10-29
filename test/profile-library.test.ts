import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { profileJsonSchema, profileSchema } from '../src/domain/schema.js';
import { ProfileLibrary } from '../src/storage/profile-library.js';

const profile = {
  schemaVersion: 1, profileId: 'implementer', version: 1, name: 'Implementer',
  instructions: 'Implement the approved plan.',
  skills: [{ id: 'coding', path: 'skills/coding.md', sha256: 'a'.repeat(64) }],
  requestedPermissions: { read: true, write: true, checks: true, gitCommit: false },
  outputDefaults: { kind: 'changes' },
};

test('profile drafts publish immutable versions and detect tampering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-profile-'));
  const library = new ProfileLibrary(root);
  await library.create('implementer', 'Implementer');
  await library.saveDraft('implementer', { profileId: 'implementer' });
  await assert.rejects(library.publish('implementer'));
  await library.saveDraft('implementer', profile);
  assert.equal((await library.publish('implementer')).version, 1);
  await library.rename('implementer', 'Coding agent');
  assert.equal((await library.publish('implementer')).version, 2);
  assert.equal((await library.readVersion('implementer', 1)).name, 'Implementer');
  await library.cloneDraft('implementer', 'custom', 'Custom');
  assert.equal((await library.publish('custom')).profileId, 'custom');
  await library.setArchived('custom', true);
  await assert.rejects(library.publish('custom'), /Archived/);
  await assert.rejects(library.deletePermanently('custom', 'wrong'), /confirmation/);
  await library.deletePermanently('custom', 'Custom');
  assert.equal((await library.list()).length, 1);
  const file = path.join(root, 'implementer', 'versions', '000001.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as { instructions: string };
  stored.instructions = 'changed without publication';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(library.readVersion('implementer', 1), /hash mismatch/);
});

test('profile skill paths must stay project-relative and appear in JSON schema', () => {
  for (const skillPath of ['../secret', 'skills/../secret', 'C:/outside', '\\server\\share']) {
    assert.equal(profileSchema.safeParse({ ...profile, skills: [{ ...profile.skills[0], path: skillPath }] }).success, false, skillPath);
  }
  assert.equal(profileSchema.safeParse(profile).success, true);
  assert.equal((profileJsonSchema() as { additionalProperties: boolean }).additionalProperties, false);
});
