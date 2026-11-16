import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('CLI LangConfig preview is bounded, read-only and never echoes input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-lc-cli-'));
  const file = path.join(root, 'fixture.json');
  const cli = path.resolve('dist/src/cli/main.js');
  const run = () => spawnSync(process.execPath, [cli, 'langconfig', 'preview', file], { cwd: root, encoding: 'utf8' });
  const input = JSON.stringify({ nodes: [{ node_id: 'SECRET', display_name: 'SECRET', node_type: 'start' }], edges: [], entry_point_id: 'SECRET' });
  await writeFile(file, input);
  const before = await readdir(root);
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).executable, false);
  assert.doesNotMatch(good.stdout + good.stderr, /SECRET/);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(file, 'utf8'), input);

  await writeFile(file, '{"SECRET":1,"SECRET":2}');
  const duplicate = run();
  assert.equal(duplicate.status, 2);
  assert.doesNotMatch(duplicate.stdout + duplicate.stderr, /SECRET/);
  await writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.equal(run().status, 2);
  await writeFile(file, 'x'.repeat(1_048_577));
  assert.equal(run().status, 2);
});
