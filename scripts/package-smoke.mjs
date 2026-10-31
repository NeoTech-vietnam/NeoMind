// Installed-package checks only. This does not replace client/model acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml } from 'yaml';
import { fileHash, distributionTarget, packedArchive, nativeTarCommand } from './package-runtime.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const args = process.argv.slice(2), supplied = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
if (args.some((value, index) => index % 2 === 0 && !['--tarball', '--runtime', '--runtime-archive', '--report'].includes(value)) || args.length % 2)
  throw new Error('Usage: node scripts/package-smoke.mjs [--tarball FILE | --runtime DIRECTORY | --runtime-archive FILE] [--report FILE]');
if (['--tarball', '--runtime', '--runtime-archive'].filter(name => supplied(name)).length > 1) throw new Error('Choose exactly one installed-package source.');
const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path));
function run(executable, parameters, cwd, timeout = 180000) {
  const result = spawnSync(executable, parameters, { cwd, env: process.env, encoding: 'utf8', shell: false,
    windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
const temporaryRoot = join(repository, 'artifacts/package-smoke-staging'); mkdirSync(temporaryRoot, { recursive: true });
const workspace = mkdtempSync(join(temporaryRoot, 'workforce-package-'));
let tarball, installed;
try {
  if (supplied('--runtime')) installed = realpathSync.native(resolve(supplied('--runtime')));
  else if (supplied('--runtime-archive')) {
    tarball = resolve(supplied('--runtime-archive'));
    const names = run(nativeTarCommand(), ['-tzf', tarball], workspace).trim().split(/\r?\n/);
    assert.ok(names.every(name => name.startsWith('workforce/') && !name.split('/').includes('..')), 'Portable archive entries stay under workforce/.');
    run(nativeTarCommand(), ['-xzf', tarball, '-C', workspace], workspace); installed = join(workspace, 'workforce');
    assert.ok(existsSync(join(installed, 'distribution-manifest.json')), 'Portable assets include their dependency/integrity manifest.');
  } else {
    assert.ok(npm, 'Run npm run package:smoke so the npm CLI path is available.');
    if (supplied('--tarball')) tarball = resolve(supplied('--tarball'));
    else {
      mkdirSync(join(repository, 'artifacts'), { recursive: true });
      const inventory = packedArchive(JSON.parse(run(process.execPath, [npm, 'pack', '--pack-destination', 'artifacts', '--json', '--cache', join(repository, 'artifacts/npm-build-cache')], repository)));
      assert.ok(!inventory.files.some(file => /__pycache__|\.pyc$|\.o$|\.obj$/.test(file.path)));
      tarball = join(repository, 'artifacts', inventory.filename);
    }
    writeFileSync(join(workspace, 'package.json'), '{"private":true,"type":"module"}\n');
    run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(repository, 'artifacts/npm-build-cache'), tarball], workspace, 300000);
    installed = join(workspace, 'node_modules/workforce');
  }
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'workforce'); assert.equal(manifest.version, pkg.version);
  const portable = Boolean(supplied('--runtime') || supplied('--runtime-archive'));
  const dependencyRoot = portable ? installed : workspace;
  // Staging is deliberately on the workspace drive. Do not let an incomplete
  // asset borrow dependencies from this checkout through Node's parent lookup.
  for (const name of Object.keys(manifest.dependencies ?? {}))
    assert.ok(existsSync(join(dependencyRoot, 'node_modules', name, 'package.json')), `Installed runtime is missing its own dependency: ${name}`);
  const cli = join(installed, 'dist/cli.js'), project = join(workspace, 'project'); mkdirSync(project);
  assert.equal(run(process.execPath, [cli, '--version'], project).trim(), pkg.version);
  const help = run(process.execPath, [cli, '--help'], project);
  assert.match(help, /^WorkForce engineering workspace/); assert.match(help, /request submit/); assert.doesNotMatch(help, /NeoMind|Usage: neomind/);
  const core = await import(pathToFileURL(join(installed, 'dist/index.js')).href);
  let buildFingerprint;
  if (portable) {
    const distribution = JSON.parse(readFileSync(join(installed, 'distribution-manifest.json'), 'utf8'));
    buildFingerprint = core.createRuntimeInfo(project).build_fingerprint;
    assert.equal(distribution.build_fingerprint, buildFingerprint, 'The extracted runtime must load the build recorded by its archive.');
  }
  const host = await import(pathToFileURL(join(installed, 'dist/workforce-host.js')).href);
  assert.equal(typeof host.enableWorkForceHost, 'function');
  const engine = await import(pathToFileURL(join(installed, 'dist/opencode-engine.js')).href), binary = engine.openCodeBinary();
  if (process.platform === 'win32') {
    const guardian = engine.openCodeWindowsGuardian();
    assert.equal(await fileHash(guardian.path), guardian.sha256, 'The installed Windows helper is precompiled and pinned.');
    if (portable) assert.equal(JSON.parse(readFileSync(join(installed, 'distribution-manifest.json'), 'utf8')).windows_guardian.sha256, guardian.sha256);
  }
  const binaryChild = relative(dependencyRoot, binary.path);
  assert.ok(!isAbsolute(binaryChild) && binaryChild !== '..' && !binaryChild.startsWith('../') && !binaryChild.startsWith('..\\'), 'The engine binary belongs to the tested install, not the source checkout.');
  assert.equal(run(binary.path, ['--version'], project).trim(), '1.19.4'); assert.equal(await fileHash(binary.path), binary.sha256);
  const sdk = JSON.parse(readFileSync(join(dependencyRoot, 'node_modules/@opencode-ai/sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, '1.19.4');
  if (portable) {
    assert.equal(JSON.parse(readFileSync(join(installed, 'resources/opencode-bootstrap/node_modules/@opencode-ai/plugin/package.json'), 'utf8')).version, '1.19.4');
    assert.equal(resolve(engine.openCodeBootstrap().path), resolve(installed, 'resources/opencode-bootstrap'), 'Portable setup validates its shipped dependency-copy worker.');
  }
  const extension = JSON.parse(readFileSync(join(installed, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  assert.equal(`${extension.publisher}.${extension.name}`, 'workforce.workforce-model-bridge'); assert.equal(extension.version, '0.12.0');
  const invoke = parameters => JSON.parse(run(process.execPath, [cli, ...parameters, '--project', project, '--json'], project));
  run('git', ['init', '--quiet', project], workspace);
  const gitignore = '# Existing project ignore rules\nproducts/private/\n', agents = '# Existing project instructions\n';
  writeFileSync(join(project, '.gitignore'), gitignore); writeFileSync(join(project, 'AGENTS.md'), agents);
  writeFileSync(join(project, '.git/info/exclude'), '# Existing private exclusions\nlocal-only.bin\n');
  const initialization = invoke(['init', '--name', 'Installed WorkForce smoke project', '--project-id', 'PACKAGED', '--platforms', 'codex,copilot', '--local']);
  assert.equal(initialization.installation.version, pkg.version);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), gitignore);
  const agentsAfterInit = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.ok(agentsAfterInit.startsWith(agents), 'Existing user instructions are preserved before the installer-owned entrypoint.');
  assert.equal(agentsAfterInit.match(/<!-- BEGIN WORKFORCE instructions -->/g)?.length, 1);
  assert.match(readFileSync(join(project, '.git/info/exclude'), 'utf8'), /local-only\.bin/);
  assert.match(run('git', ['check-ignore', '.workforce/config.json'], project), /\.workforce\/config\.json/);
  const squad = [['coordinator', 'pm', 'WF.PM'], ['planner', 'swsd', 'WF.SWSD'], ['architect', 'p-res', 'WF.P-RES'],
    ['implementer', 'fnd', 'WF.FnD'], ['reviewer', 'reviewer', 'WF.Reviewer'], ['verifier', 'tester', 'WF.Tester']];
  assert.deepEqual(core.agentProfiles.map(({ id, name }) => [id, name]), squad.map(([id, _file, name]) => [id, name]));
  const files = readdirSync(join(project, '.github/agents')).filter(path => path.startsWith('workforce-') && path.endsWith('.agent.md')).sort();
  assert.deepEqual(files, squad.map(([_id, file]) => `workforce-${file}.agent.md`).sort());
  for (const [_id, suffix, name] of squad) {
    const contents = readFileSync(join(project, `.github/agents/workforce-${suffix}.agent.md`), 'utf8');
    const metadata = parseYaml(contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
    assert.equal(metadata.name, name); assert.equal(metadata['user-invocable'], suffix === 'pm');
    assert.deepEqual(metadata.agents, [], `${name} cannot spawn a second client-owned team.`);
    assert.equal(metadata.model, suffix === 'pm' ? 'top-models' : undefined, `${name} is a runtime responsibility, not a native worker model selection.`);
    if (suffix !== 'pm') assert.deepEqual(metadata.tools, ['workforce/request_status']);
  }
  assert.equal(readdirSync(join(project, '.codex/agents')).filter(path => path.endsWith('.toml')).length, 6);
  const routing = core.readRoutingPolicy(project); assert.equal(routing.strong_model, 'top-models'); assert.deepEqual(routing.worker_models, ['worker-models']);
  for (const profile of core.agentProfiles)
    assert.deepEqual(core.roleModelPolicy(project, profile.modelRole).models, [profile.id === 'implementer' ? 'worker-models' : 'top-models']);
  assert.deepEqual(invoke(['request', 'status']).requests, []);
  assert.equal(invoke(['request', 'setup']).ready, false, 'A version check must not claim live provider readiness.');
  const client = new Client({ name: 'workforce-installed-smoke', version: pkg.version });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--project', project], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['request_control', 'request_status', 'request_submit']);
    const result = await client.callTool({ name: 'request_status', arguments: {} });
    assert.notEqual(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text).requests, []);
  } finally { await client.close(); }
  const edited = join(project, '.github/agents/workforce-fnd.agent.md'), changed = '# User-authored specialist instructions\n';
  writeFileSync(edited, changed); const routingBefore = readFileSync(join(project, '.workforce/routing.json'));
  const updated = invoke(['update', '--local']);
  assert.equal(updated.version, pkg.version); assert.equal(readFileSync(edited, 'utf8'), changed);
  assert.ok(updated.conflicts.some(item => item.path === '.github/agents/workforce-fnd.agent.md'));
  assert.deepEqual(readFileSync(join(project, '.workforce/routing.json')), routingBefore);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), gitignore); assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agentsAfterInit);
  const report = { schema_version: 1, package: pkg.name, version: pkg.version, target: distributionTarget().target,
    source: supplied('--runtime') ? 'extracted-runtime' : supplied('--runtime-archive') ? 'portable-runtime-archive' : 'npm-tarball',
    ...(tarball ? { archive: relative(repository, tarball).replaceAll('\\', '/'), archive_sha256: await fileHash(tarball) } : {}),
    node: process.version, ...(buildFingerprint ? { build_fingerprint: buildFingerprint } : {}),
    engine: { version: '1.19.4', binary_sha256: binary.sha256 }, status: 'passed',
    checks: ['installed-cli-and-resource-resolution', 'pinned-engine-and-sdk-present-before-request', 'six-agent-catalog', 'Local-project-integration',
      'gitignore-untouched-and-local-exclusions-preserved', 'top-and-worker-aliases', 'request-status-and-honest-setup', 'MCP-request-only-discovery-and-status', 'edited-profile-and-routing-preserving-update'],
    limitations: ['No model inference, client interaction or product workflow is run by package smoke.', 'This is core/package evidence; Copilot Local, Codex and installed extension acceptance are separate.', 'Linux desktop is not certified by Linux package smoke.'] };
  const reportPath = resolve(supplied('--report') ?? join(repository, 'artifacts/package-smoke.json')); mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} finally {
  const child = relative(temporaryRoot, resolve(workspace));
  assert.ok(!isAbsolute(child) && /^workforce-package-[^\\/]+$/.test(child)); rmSync(workspace, { recursive: true, force: true });
}
