import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isProjectMetadataPath, migrateProjectDir, projectDir } from '../src/storage/project-dir.js';
import { readProject } from '../src/runtime/project.js';
import { sharedImpactPaths } from '../src/core/review-impact.js';
import { defaultProject } from '../src/domain/templates.js';

const project = () => mkdtemp(path.join(tmpdir(), 'neomind-project-dir-'));

test('NeoMind keeps its data in neomind/, still reads a legacy .neomind/, and leaves a project\'s own neomind/ folder alone', async () => {
  const fresh = await project();
  assert.equal(projectDir(fresh), path.join(fresh, 'neomind'), 'new projects use the visible folder');
  const legacy = await project(); await mkdir(path.join(legacy, '.neomind'));
  assert.equal(projectDir(legacy), path.join(legacy, '.neomind'));
  const both = await project(); await mkdir(path.join(both, '.neomind')); await mkdir(path.join(both, 'neomind', 'flows'), { recursive: true });
  assert.equal(projectDir(both), path.join(both, 'neomind'));
  const ownSource = await project(); await mkdir(path.join(ownSource, 'neomind')); await writeFile(path.join(ownSource, 'neomind', '__init__.py'), '');
  assert.equal(projectDir(ownSource), path.join(ownSource, '.neomind'), 'a source package named neomind is not NeoMind data');
});

test('migrating moves .neomind/ to neomind/ and the project config is read from the new place', async () => {
  const root = await project(), config = { ...structuredClone(defaultProject), projectId: 'migrated' };
  await mkdir(path.join(root, '.neomind', 'flows', 'dev'), { recursive: true });
  await writeFile(path.join(root, '.neomind', 'project.json'), JSON.stringify(config));
  assert.equal((await readProject(root)).projectId, 'migrated');
  assert.deepEqual(await migrateProjectDir(root), { migrated: true, directory: path.join(root, 'neomind') });
  assert.ok(!existsSync(path.join(root, '.neomind')) && existsSync(path.join(root, 'neomind', 'flows', 'dev')));
  assert.equal((await readProject(root)).projectId, 'migrated');
  assert.equal(JSON.parse(await readFile(path.join(root, 'neomind', 'project.json'), 'utf8')).projectId, 'migrated');
  assert.deepEqual(await migrateProjectDir(root), { migrated: false, directory: path.join(root, 'neomind') });
  await mkdir(path.join(root, '.neomind'));
  await assert.rejects(migrateProjectDir(root), /Đã có cả neomind\/ và \.neomind\//);
});

test('both folder names count as NeoMind metadata for imports and review impact', () => {
  for (const file of ['neomind', 'neomind/project.json', '.neomind/flows/dev/draft.json']) assert.ok(isProjectMetadataPath(file), file);
  for (const file of ['src/neomind/x.ts', 'neomind.md', '.neomindrc']) assert.ok(!isProjectMetadataPath(file), file);
  assert.deepEqual(sharedImpactPaths(['src/a.ts', 'neomind/flows/dev/draft.json', '.neomind/project.json']), ['neomind/flows/dev/draft.json', '.neomind/project.json']);
});
