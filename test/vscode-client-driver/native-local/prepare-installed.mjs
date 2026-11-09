// Prepare only. The real installed CLI supplies the project/agents; this driver
// contributes no product tools, profiles, hooks, providers or backend runners.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { captureInstalledDescriptor } = require('./installed-entry.cjs');
const here = dirname(fileURLToPath(import.meta.url)), repository = realpathSync.native(resolve(here, '../../..'));

export function prepareInstalledFixture({ runtime, productExtension, outDirectory } = {}) {
  if (![runtime, productExtension].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Select absolute installed --runtime and --product-extension directories.');
  const installedProduct = captureInstalledDescriptor({ repository, runtimeRoot: runtime, extensionRoot: productExtension });
  const base = join(repository, 'artifacts/workforce-native-local-proof'); mkdirSync(base, { recursive: true });
  const run = resolve(outDirectory ?? join(base, randomUUID().slice(0, 8))), child = relative(realpathSync.native(base), run);
  if (!/^[a-f0-9]{8}$/.test(child) || isAbsolute(child) || existsSync(run)) throw new Error('Use a NEW eight-hex owned fixture directory. Existing fixtures and history are preserved.');
  mkdirSync(run);
  const workspace = join(run, 'workspace'), extension = join(run, 'extension'), evidence = join(run, 'evidence');
  for (const path of [workspace, extension, evidence]) mkdirSync(path);
  const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const cli = join(installedProduct.runtime.root, 'dist/cli.js');
  function execute(command, args) {
    const result = spawnSync(command, args, { cwd: workspace, shell: false, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`Installed fixture preparation failed: ${result.error?.code ?? result.status}`);
    return result.stdout;
  }
  try {
    execute('git', ['init', '--quiet', workspace]);
    const initialization = JSON.parse(execute(process.execPath, [cli, 'init', '--name', 'Installed WorkForce VSIX acceptance',
      '--project-id', `WF-FINAL-${child.toUpperCase()}`, '--platforms', 'copilot', '--local', '--project', workspace, '--json']));
    const config = JSON.parse(readFileSync(join(workspace, '.workforce/config.json'), 'utf8'));
    if (config.execution_engine !== 'vscode-native') throw new Error('The installed CLI did not initialize the native contract.');
    const profiles = readdirSync(join(workspace, '.github/agents')).filter(name => name.endsWith('.agent.md'));
    if (profiles.length !== 11 || profiles.some(name => !name.startsWith('workforce-') ||
      !readFileSync(join(workspace, '.github/agents', name), 'utf8').includes('Execution contract: vscode-native/v1.')))
      throw new Error('The installed CLI did not generate exactly the native product profiles.');
    for (const file of ['extension.cjs', 'installed-entry.cjs']) copyFileSync(join(here, file), join(extension, file));
    json(join(extension, 'fixture.json'), { workspace, evidence, repository, nativeInstalledEntry: true, installedProduct,
      nativePilot: false, nativeProductEntry: false, enable_mcp_fixture: false, enable_rea_proof: false, showVModel: false,
      coordinator: 'WF.PM', worker: 'WF.Tester Worker', marker: 'INSTALLED_PRODUCTION_WORKFORCE',
      prompt: 'Wait for an explicitly authorized ordinary requirement. No model request has been submitted by preparation.' });
    json(join(extension, 'package.json'), { name: 'workforce-installed-local-observer', publisher: 'workforce-test', version: '0.0.1',
      engines: { vscode: '^1.143.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'], extensionKind: ['workspace'],
      contributes: { commands: [
        { command: 'workforceM2.inspect', title: 'WorkForce Installed: Inspect Active Product (no inference)' },
        { command: 'workforceM2.run', title: 'WorkForce Installed: Run Authorized Local Prompt' },
        { command: 'workforceM2.capture', title: 'WorkForce Installed: Capture Public Chat Evidence' },
        { command: 'workforceM2.captureInstalled', title: 'WorkForce Installed: Capture Saved Product Snapshot' },
        { command: 'workforceM2.previewVModel', title: 'WorkForce Installed: Open Product V-model' },
      ] } });
    const launch = ['--new-window', `--extensionDevelopmentPath=${extension}`, workspace];
    const result = { schema_version: 1, workspace, extension, evidence, launch, dispatched: false,
      installed_runtime: { root: installedProduct.runtime.root, version: installedProduct.runtime.version },
      installed_extension: { root: installedProduct.extension.root, id: installedProduct.extension.id, version: installedProduct.extension.version },
      initialized_by: { command: 'actual-installed-workforce-cli', version: initialization.installation?.version, profile_count: profiles.length },
      user_setting_required: { key: 'workforce.bridge.runtimePath', value: installedProduct.runtime.root, modified_by_preparation: false },
      account_profile: 'reuse existing VS Code User profile; no credentials copied',
      harness: { backend_registration: false, model_hooks: false, source_runtime: false, private_chat_storage: false },
      next: ['Install/enable the matching production VSIX in the intended existing model account profile.',
        'Set the ordinary User runtimePath to the pinned installed runtime; preparation does not change it.',
        'Use the emitted launch arguments without disabling the product extension.',
        'Inspect before authorizing the exact original Local prompt and folder attachment.'] };
    json(join(evidence, 'installed-preparation.json'), result); return result;
  } catch (error) { json(join(evidence, 'installed-preparation-error.json'), { status: 'not-ready', error: error.message, dispatched: false }); throw error; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { runtime: { type: 'string' }, 'product-extension': { type: 'string' }, 'out-dir': { type: 'string' } } });
  console.log(JSON.stringify(prepareInstalledFixture({ runtime: values.runtime, productExtension: values['product-extension'], outDirectory: values['out-dir'] }), null, 2));
}
