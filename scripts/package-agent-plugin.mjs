// Materialize an exact-project Agent Plugins package around an installed runtime.
// Model credentials and project state remain outside the package.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templates = join(repository, 'resources/agent-plugin');
const schema = 'https://agent-plugins.org/schemas/1.0.0/';
const below = (parent, child) => { const path = relative(parent, child); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute directory.`);
  const path = realpathSync.native(value);
  if (!lstatSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return path;
}

function futurePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('--out must be an absolute directory.');
  let parent = resolve(value), tail = [];
  while (!existsSync(parent)) { tail.unshift(parent.slice(dirname(parent).length + (dirname(parent).endsWith(sep) ? 0 : 1))); parent = dirname(parent); }
  return resolve(realpathSync.native(parent), ...tail);
}

export async function packageAgentPlugin({ runtime: inputRuntime, project: inputProject, out: inputOut }) {
  if (process.versions.electron) throw new Error('Package with standalone Node.js, not Electron.');
  const runtime = absoluteDirectory(inputRuntime, '--runtime'), project = absoluteDirectory(inputProject, '--project');
  const out = futurePath(inputOut);
  if ([runtime, project].some(root => below(root, out) || below(out, root)))
    throw new Error('Plugin output must be separate from both the runtime and project.');
  if (existsSync(out) && (!lstatSync(out).isDirectory() || readdirSync(out).length))
    throw new Error('Plugin output must be a new or empty directory; existing files are preserved.');
  const metadata = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
  if (metadata.name !== 'workforce' || typeof metadata.version !== 'string')
    throw new Error('--runtime must contain an installed WorkForce package.');
  const cli = join(runtime, 'dist/cli.js');
  if (!existsSync(cli) || !lstatSync(cli).isFile()) throw new Error('WorkForce runtime dist/cli.js is missing.');
  const { readConfig } = await import(pathToFileURL(join(runtime, 'dist/storage.js')).href);
  const { workforceClientInstructions, workforceNativeClientInstructions } = await import(pathToFileURL(join(runtime, 'dist/adapters.js')).href);
  const { agentProfiles, workforceProfileFileId } = await import(pathToFileURL(join(runtime, 'dist/agent-profiles.js')).href);
  const config = readConfig(project);
  if (config.execution_engine !== 'opencode' || !config.platforms.includes('copilot'))
    throw new Error('The project must already be initialized for WorkForce OpenCode and Copilot.');
  if (!Array.isArray(agentProfiles) || agentProfiles.length !== 6 || typeof workforceClientInstructions !== 'function')
    throw new Error('This runtime does not expose the supported WorkForce profile contract.');
  const nativeLocal = config.copilot_integration === 'local';
  const native = nativeLocal ? await import(pathToFileURL(join(runtime, 'dist/native-local-contract.js')).href) : undefined;
  if (nativeLocal && (native?.nativeLocalContractVersion !== 'vscode-native/v1' || typeof workforceNativeClientInstructions !== 'function' ||
      typeof native.nativeLocalWorkerProfile !== 'function' || native.nativeSpecialists?.length !== 5 ||
      !native.nativeSpecialists.every(role => native.nativeWorkerProfiles?.[role] === `${role} Worker`)))
    throw new Error('Native Local packaging requires the matching native WorkForce runtime and VSIX.');
  const instructions = (nativeLocal ? workforceNativeClientInstructions : workforceClientInstructions)('copilot');
  const files = new Map();
  const json = value => JSON.stringify(value, null, 2) + '\n';
  files.set('plugin.json', json({ $schema: `${schema}plugin.schema.json`, name: 'workforce',
    version: metadata.version, description: 'WorkForce Local intake, V-model agent profiles, skills and exact-project MCP.',
    author: { name: 'WorkForce' }, repository: 'https://github.com/NeoTech-vietnam/NeoMind', license: 'MIT' }));
  files.set('mcp.json', json({ $schema: `${schema}mcp.schema.json`, mcpServers: {
    workforce: { type: 'stdio', command: 'node', args: [cli, 'mcp', '--project', project] },
  } }));
  for (const profile of agentProfiles) {
    const tools = profile.id === 'coordinator' ? ['request_submit', 'request_status', 'request_control'] : ['request_status'];
    files.set(`com.github.copilot/agents/workforce-${workforceProfileFileId(profile.id)}.agent.md`,
      nativeLocal ? native.nativeLocalProfile(profile.name) :
        `---\nname: ${JSON.stringify(profile.name)}\ndescription: ${JSON.stringify(profile.duty)}\ntools: ${JSON.stringify(tools.map(tool => `workforce/${tool}`))}\nagents: []\nuser-invocable: ${profile.id === 'coordinator'}\n---\n\n${instructions}\nRuntime responsibility: ${profile.name}. ${profile.procedure}\n`);
  }
  if (nativeLocal) for (const role of native.nativeSpecialists)
    files.set(`com.github.copilot/agents/workforce-worker-${role.slice(3).toLowerCase()}.agent.md`, native.nativeLocalWorkerProfile(role));
  files.set('skills/workforce-request/SKILL.md', `---\nname: workforce-request\ndescription: Submit an engineering request to WorkForce, inspect its saved deliverables, or control the same request from Copilot Local.\n---\n\n${instructions}`);
  files.set('skills/workforce-plugin-status/SKILL.md', readFileSync(join(templates, 'skills/workforce-plugin-status/SKILL.md'), 'utf8'));
  files.set('README.md', (nativeLocal ? `# WorkForce native Local Agent Plugin\n\nInstall the matching WorkForce VSIX and runtime, then install this package through VS Code's native Agent Customizations editor in the intended Local workspace. Keep one owner of each WorkForce agent/MCP registration.\n\nThe six profiles share the installed runtime's native contract. WF.PM delegates actual native subagents; model selection inherits from chat unless a role preference is set. The MCP connection remains available for compatibility/status; native product execution uses the extension tools and does not connect the legacy engine.\n\n${instructions}\nInstallation is not proof of tool loading or successful execution. Test discovery, actual delegation, independent checks and disable/uninstall separately. Preserve project products/history during uninstall.\n` : readFileSync(join(templates, 'README.md'), 'utf8')) +
    `\n## This materialized installation\n\n- Project: ${project}\n- Project ID: ${config.project_id}\n- Runtime: ${runtime}\n- Runtime version: ${metadata.version}\n\nThis copy always addresses that project, even if installed in another window. Install it only in the matching workspace. Generate another copy for another project.\n`);
  files.set('binding.json', json({ schema_version: 1, project, project_id: config.project_id, runtime, runtime_version: metadata.version,
    packaging_node: process.execPath, registration_owner: 'agent-plugin', profile_source: nativeLocal ? 'runtime/dist/native-local-contract.js#nativeLocalProfile' : 'runtime/dist/agent-profiles.js',
    instruction_source: `runtime/dist/adapters.js#${nativeLocal ? 'workforceNativeClientInstructions' : 'workforceClientInstructions'}` }));
  // All validation and rendering precede the first write. This generator never
  // writes into the selected workspace, VS Code settings, or installed runtime.
  mkdirSync(out, { recursive: true });
  for (const [path, content] of files) {
    const target = join(out, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  }
  copyFileSync(join(runtime, 'LICENSE'), join(out, 'LICENSE'));
  return { plugin: 'workforce', version: metadata.version, path: out, project, project_id: config.project_id,
    agents: agentProfiles.map(profile => profile.name), skills: ['workforce-request', 'workforce-plugin-status'],
    mcp_servers: ['workforce'], runtime_bundled: false, credentials_bundled: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { runtime: { type: 'string' }, project: { type: 'string' }, out: { type: 'string' } }, strict: true });
  console.log(JSON.stringify(await packageAgentPlugin(values), null, 2));
}
