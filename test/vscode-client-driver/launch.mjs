// Prints a reviewable native launch by default. --launch requires an explicit operator decision.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = join(repository, 'artifacts/workforce-client-driver/config.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
const installation = join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code');
const versions = readdirSync(installation).filter(name => existsSync(join(installation, name, 'resources/app/out/cli.js')));
if (versions.length !== 1) throw new Error('Select one installed VS Code CLI before using this launcher.');
const executable = join(installation, 'Code.exe'), cli = join(installation, versions[0], 'resources/app/out/cli.js');
const args = [cli, '--new-window', `--extensionDevelopmentPath=${join(repository, 'test/vscode-client-driver')}`,
  `--extensionEnvironment=${JSON.stringify({ WORKFORCE_ACCEPTANCE_CONFIG: configPath })}`, config.workspace_root];
const launch = { executable, args, workspace: config.workspace_root, uses_extension_tests_path: false, changes_trust_or_auth_policy: false,
  auto_dispatches_prompt: false, requires_installed_workforce_vsix: true, profile: 'existing default profile; account/settings are not copied' };
console.log(JSON.stringify(launch, null, 2));
if (process.argv.includes('--launch')) {
  const child = spawn(executable, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, shell: false, windowsHide: false, stdio: 'ignore', detached: false });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
}
