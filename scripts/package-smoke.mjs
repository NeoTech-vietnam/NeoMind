// Installed-package checks only. This does not replace client/model acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { fileHash, distributionTarget, packedArchive, nativeTarCommand, assertNativeOnlyRuntime, packageSmokeWorkspace, assertPackageRuntimeIsolated } from './package-runtime.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const expectedExtension = JSON.parse(readFileSync(join(repository, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
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
const workspace = packageSmokeWorkspace(), temporaryRoot = dirname(workspace);
let tarball, installed, gatewayPrivate;
try {
  if (supplied('--runtime')) {
    installed = realpathSync.native(resolve(supplied('--runtime'))); assertPackageRuntimeIsolated(installed);
  }
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
  assertNativeOnlyRuntime(installed);
  const portable = Boolean(supplied('--runtime') || supplied('--runtime-archive'));
  const dependencyRoot = portable ? installed : workspace;
  assertNativeOnlyRuntime(dependencyRoot);
  // Both the filesystem location and own-dependency checks prevent a product
  // from borrowing this checkout's development SDK through parent lookup.
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
  for (const name of ['opencode-ai', '@opencode-ai/sdk']) assert.equal(existsSync(join(dependencyRoot, 'node_modules', name)), false,
    'The installed native product has no legacy engine or SDK, including hoisted npm dependencies.');
  const gatewayModule = await import(pathToFileURL(join(installed, 'dist/managed-gateway-artifact.js')).href);
  const gatewayManifest = JSON.parse(readFileSync(join(installed, 'resources/managed-gateway/manifest.json'), 'utf8'));
  assert.deepEqual(gatewayManifest.pin, gatewayModule.MANAGED_GATEWAY_PIN);
  assert.equal(gatewayManifest.archive, `9router-${gatewayModule.MANAGED_GATEWAY_PIN.version}.tgz`);
  const gatewayArchive = join(installed, 'resources/managed-gateway', gatewayManifest.archive);
  assert.equal(await fileHash(gatewayArchive), gatewayManifest.archive_sha256);
  gatewayPrivate = mkdtempSync(join(tmpdir(), 'workforce-installed-gateway-'));
  const gatewayArtifact = await gatewayModule.installManagedGateway(join(gatewayPrivate, 'private'), {
    allowDownload: false, archivePath: gatewayArchive, nodeCommand: process.execPath,
    fetch() { throw new Error('Installed package smoke cannot download gateway dependencies.'); },
  });
  assert.equal(gatewayModule.verifyManagedGatewayArtifact(join(gatewayPrivate, 'private'), gatewayArtifact.id).fingerprint, gatewayArtifact.fingerprint);
  assert.ok(gatewayArtifact.files.length > 1000, 'The real pinned standalone dependency closure was validated offline.');
  const extension = JSON.parse(readFileSync(join(installed, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  assert.equal(`${extension.publisher}.${extension.name}`, 'workforce.workforce-model-bridge'); assert.equal(extension.version, expectedExtension.version);
  const invoke = parameters => JSON.parse(run(process.execPath, [cli, ...parameters, '--project', project, '--json'], project));
  run('git', ['init', '--quiet', project], workspace);
  const gitignore = '# Existing project ignore rules\nproducts/private/\n', agents = '# Existing project instructions\n';
  writeFileSync(join(project, '.gitignore'), gitignore); writeFileSync(join(project, 'AGENTS.md'), agents);
  writeFileSync(join(project, '.git/info/exclude'), '# Existing private exclusions\nlocal-only.bin\n');
  const initialization = invoke(['init', '--name', 'Installed WorkForce smoke project', '--project-id', 'PACKAGED', '--platforms', 'codex,copilot', '--local']);
  assert.equal(initialization.installation.version, pkg.version);
  assert.equal(core.readConfig(project).execution_engine, 'vscode-native', 'The public installed CLI defaults to native Local execution.');
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), gitignore);
  const agentsAfterInit = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.ok(agentsAfterInit.startsWith(agents), 'Existing user instructions are preserved before the installer-owned entrypoint.');
  assert.equal(agentsAfterInit.match(/<!-- BEGIN WORKFORCE instructions -->/g)?.length, 1);
  assert.match(readFileSync(join(project, '.git/info/exclude'), 'utf8'), /local-only\.bin/);
  assert.match(run('git', ['check-ignore', '.workforce/config.json'], project), /\.workforce\/config\.json/);
  const squad = [['coordinator', 'pm', 'WF.PM'], ['planner', 'swsd', 'WF.SWSD'], ['architect', 'p-res', 'WF.P-RES'],
    ['implementer', 'fnd', 'WF.FnD'], ['reviewer', 'reviewer', 'WF.Reviewer'], ['verifier', 'tester', 'WF.Tester']];
  assert.deepEqual(core.agentProfiles.map(({ id, name }) => [id, name]), squad.map(([id, _file, name]) => [id, name]));
  const specialists = squad.slice(1), workerNames = specialists.map(([_id, _file, name]) => `${name} Worker`);
  assert.deepEqual(core.nativeRoles, squad.map(([_id, _file, name]) => name));
  assert.deepEqual(core.nativeWorkerProfiles, Object.fromEntries(specialists.map(([_id, _file, name]) => [name, `${name} Worker`])));
  const files = readdirSync(join(project, '.github/agents')).filter(path => path.startsWith('workforce-') && path.endsWith('.agent.md')).sort();
  assert.deepEqual(files, [...squad.map(([_id, file]) => `workforce-${file}.agent.md`),
    ...specialists.map(([_id, file]) => `workforce-worker-${file}.agent.md`)].sort());
  const profileMetadata = file => {
    const contents = readFileSync(join(project, `.github/agents/${file}`), 'utf8');
    assert.match(contents, /Execution contract: vscode-native\/v1\./);
    assert.doesNotMatch(contents, /^model:|assignment_claim|assignment_progress|reported_assignment/m);
    return parseYaml(contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
  };
  for (const [_id, suffix, name] of squad) {
    const metadata = profileMetadata(`workforce-${suffix}.agent.md`);
    assert.equal(metadata.name, name); assert.equal(metadata['user-invocable'], true);
    assert.equal(metadata['disable-model-invocation'], true, 'Visible entries cannot be recursively delegated as workers.');
    assert.equal(metadata.model, undefined, `${name} inherits the native model instead of requiring a routing alias.`);
    assert.deepEqual(metadata.agents, ['*'], 'Native core admits host-pinned versioned workers; fixed root tool references retain dispatch ownership.');
    assert.deepEqual(metadata.tools, suffix === 'pm'
      ? ['read', 'search', 'workforceNativeRequest', 'workforcePrepare', 'workforceRoleJob', 'workforceRequestControl', 'workforceCapabilities']
      : ['read', 'search', `workforceRole${name.slice(3).replaceAll('-', '')}`]);
  }
  for (const [_id, suffix, name] of specialists) {
    const metadata = profileMetadata(`workforce-worker-${suffix}.agent.md`);
    assert.equal(metadata.name, `${name} Worker`); assert.equal(metadata['user-invocable'], false);
    assert.equal(metadata.model, undefined, 'Worker model selection belongs to the native invocation.');
    assert.deepEqual(metadata.agents, [], 'Hidden workers cannot recursively delegate.');
    assert.deepEqual(metadata.tools, ['read', 'search', ...(suffix === 'fnd' ? ['edit', 'execute'] : suffix === 'tester' ? ['execute'] : [])]);
    assert.ok(metadata.tools.every(tool => !/workforce|runSubagent|^agent$|tool_search|assignment|claim|recover|lifecycle/i.test(tool)),
      'Hidden workers have no request, authentication or lifecycle tools.');
  }
  assert.deepEqual(readdirSync(join(project, '.codex/agents')).filter(path => path.endsWith('.toml')).sort(),
    squad.map(([_id, suffix]) => `workforce-${suffix}.toml`).sort());
  // Native profiles inherit the actual Local catalog. Historical routing, when
  // present, is retained as bytes; no alias is required to install this product.
  assert.deepEqual(invoke(['request', 'status']).requests, []);
  assert.equal(invoke(['request', 'setup']).ready, false, 'A version check must not claim live provider readiness.');
  // A saved Local project may still say opencode. Public native commands must
  // not resurrect its removed engine, rewrite that value or destroy history.
  const oldProject = join(workspace, 'retained-local-project'); mkdirSync(oldProject);
  core.initialize(oldProject, { name: 'Retained Local compatibility smoke', project_id: 'PACKAGED-OLD',
    execution_engine: 'opencode', platforms: ['copilot'], copilot_integration: 'local' });
  const oldConfigPath = core.safePath(oldProject, '.workforce/config.json'), oldConfig = readFileSync(oldConfigPath);
  const oldHistoryPath = core.safePath(oldProject, '.workforce/legacy-history-sentinel.txt'), oldHistory = Buffer.from('Retained fixture history; no legacy workflow execution is claimed.\n');
  writeFileSync(oldHistoryPath, oldHistory);
  const retainedRequest = core.openNativeRequest(oldProject, { requirement: 'Retained pending native fixture; no model has run.', title: 'Retained installed-smoke request' });
  const retainedFolder = core.requestFolderForWorkflow(oldProject, retainedRequest.request_ref);
  const oldExecutionPath = core.safePath(oldProject, `.workforce/${retainedFolder.directory}/native/execution.json`), oldExecution = readFileSync(oldExecutionPath);
  const invokeOld = parameters => JSON.parse(run(process.execPath, [cli, ...parameters, '--project', oldProject, '--json'], oldProject));
  const retainedStatus = invokeOld(['request', 'status']).requests;
  assert.equal(retainedStatus.length, 1); assert.equal(retainedStatus[0].workflow_id, retainedRequest.request_ref); assert.equal(retainedStatus[0].accepted, false);
  const oldSetup = invokeOld(['request', 'setup']);
  assert.equal(oldSetup.ready, false); assert.equal(oldSetup.transport, 'vscode-native', 'Old config does not trigger a legacy connector probe.');
  const oldSubmission = invokeOld(['request', 'submit', '--requirement', 'Create a bounded arithmetic module.']);
  assert.equal(oldSubmission.state, 'native-local-handoff'); assert.equal(oldSubmission.submitted, false);
  assert.equal(invokeOld(['request', 'status']).requests.length, 1, 'A public CLI handoff cannot create a replacement editor-owned request.');
  for (const action of ['pause', 'resume', 'cancel']) {
    const handoff = invokeOld(['request', action, retainedRequest.request_key]);
    assert.equal(handoff.state, 'native-local-handoff'); assert.equal(handoff.applied, false); assert.equal(handoff.action, action);
    assert.equal(handoff.request_key, retainedRequest.request_key);
  }
  for (const target of [project, oldProject]) {
    const hook = JSON.parse(run(process.execPath, [cli, 'hook', '--event', 'session-start', '--platform', 'copilot', '--project', target, '--json'], target));
    const hookText = JSON.stringify(hook);
    assert.match(hookText, /vscode-native\/v1/); assert.match(hookText, /workforceNativeRequest/); assert.match(hookText, /workforcePrepare/);
    assert.doesNotMatch(hookText, /workforce\/request_submit|assignment_claim|claim_token/, 'Session instructions must reference the installed native tool contract.');
    const client = new Client({ name: 'workforce-installed-smoke', version: pkg.version });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--project', target], stderr: 'pipe' });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['request_status', 'work_prepare']);
      const result = await client.callTool({ name: 'request_status', arguments: {} });
      assert.notEqual(result.isError, true);
      const expected = target === oldProject ? [retainedRequest.request_ref] : [];
      assert.deepEqual(JSON.parse(result.content[0].text).requests.map(row => row.workflow_id), expected);
      const prepare = await client.callTool({ name: 'work_prepare', arguments: {
        requirement: 'Inspect existing local project scripts before planning an arithmetic module.', role: 'WF.P-RES',
      } });
      assert.notEqual(prepare.isError, true);
      const preparation = JSON.parse(prepare.content[0].text);
      assert.equal(preparation.execution, 'not-executed'); assert.equal(preparation.execution_authorized, false);
      assert.equal(preparation.strategy, 'ordinary');
      assert.deepEqual(JSON.parse((await client.callTool({ name: 'request_status', arguments: {} })).content[0].text).requests.map(row => row.workflow_id), expected,
        'Advisory installed MCP discovery does not create a request or start a model.');
    } finally { await client.close(); }
  }
  assert.deepEqual(readFileSync(oldConfigPath), oldConfig); assert.deepEqual(readFileSync(oldHistoryPath), oldHistory);
  assert.deepEqual(readFileSync(oldExecutionPath), oldExecution, 'CLI/MCP observations and control handoffs preserve the actual saved native request.');
  const edited = join(project, '.github/agents/workforce-fnd.agent.md'), changed = '# User-authored specialist instructions\n';
  writeFileSync(edited, changed);
  const routingPath = join(project, '.workforce/routing.json'), routingBefore = existsSync(routingPath) ? readFileSync(routingPath) : undefined;
  const updated = invoke(['update', '--local']);
  assert.equal(updated.version, pkg.version); assert.equal(readFileSync(edited, 'utf8'), changed);
  assert.ok(updated.conflicts.some(item => item.path === '.github/agents/workforce-fnd.agent.md'));
  assert.deepEqual(existsSync(routingPath) ? readFileSync(routingPath) : undefined, routingBefore);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), gitignore); assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agentsAfterInit);
  const report = { schema_version: 1, package: pkg.name, version: pkg.version, target: distributionTarget().target,
    source: supplied('--runtime') ? 'extracted-runtime' : supplied('--runtime-archive') ? 'portable-runtime-archive' : 'npm-tarball',
    ...(tarball ? { archive: relative(repository, tarball).replaceAll('\\', '/'), archive_sha256: await fileHash(tarball) } : {}),
    node: process.version, ...(buildFingerprint ? { build_fingerprint: buildFingerprint } : {}),
    execution: 'vscode-native/v1', transport: 'vscode-local', gateway: { pin: gatewayManifest.pin, archive_sha256: gatewayManifest.archive_sha256,
      offline_verified_files: gatewayArtifact.files.length }, status: 'passed',
    checks: ['installed-cli-and-resource-resolution', 'legacy-engine-sdk-bootstrap-absent', 'optional-pinned-gateway-offline-install', 'six-visible-and-five-hidden-native-profiles',
      'native-root-worker-tool-boundaries', 'native-model-inheritance', 'Local-project-integration',
      'gitignore-untouched-and-local-exclusions-preserved', 'native-default-and-no-required-model-alias', 'request-status-and-honest-setup',
      'retained-local-config-native-public-entrypoints-no-engine-probe', 'native-hook-instructions-match-exposed-tools',
      'MCP-native-read-only-status-and-reuse', 'edited-profile-and-routing-preserving-update'],
    limitations: ['No model inference, client interaction or product workflow is run by package smoke.', 'This is core/package evidence; Copilot Local, Codex and installed extension acceptance are separate.', 'Linux desktop is not certified by Linux package smoke.'] };
  const reportPath = resolve(supplied('--report') ?? join(repository, 'artifacts/package-smoke.json')); mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} finally {
  if (gatewayPrivate) rmSync(gatewayPrivate, { recursive: true, force: true });
  const child = relative(temporaryRoot, resolve(workspace));
  assert.ok(!isAbsolute(child) && /^workforce-package-[^\\/]+$/.test(child)); rmSync(workspace, { recursive: true, force: true });
}
