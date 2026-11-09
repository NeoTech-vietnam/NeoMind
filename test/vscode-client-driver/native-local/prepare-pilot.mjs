// Upgrade an OWNED disposable proof fixture; never edit a user's workspace.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeLocalProfile, nativeLocalWorkerProfile, nativeSpecialists, nativeLocalRequestJsonSchema, nativeRoles, nativeRequestControlJsonSchema } from '../../../dist/native-local-contract.js';
import { nativeRoleJobJsonSchema } from '../../../dist/native-role-job.js';
import { nativeWorkPrepareJsonSchema } from '../../../dist/native-work.js';

const here = dirname(fileURLToPath(import.meta.url));
const repository = realpathSync.native(resolve(here, '../../..'));
const fixtureBase = realpathSync.native(join(repository, 'artifacts/workforce-native-local-proof'));
const extension = realpathSync.native(resolve(process.argv[2] ?? ''));
const child = relative(fixtureBase, extension);
if (!child || child.startsWith('..') || isAbsolute(child) || !/^[a-f0-9]{8}[\\/]extension$/.test(child))
  throw new Error('Select an existing owned native Local fixture extension directory.');
const fixturePath = join(extension, 'fixture.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const nativeEntry = process.argv.includes('--native-entry');
const identity = path => process.platform === 'win32' ? realpathSync.native(path).toLowerCase() : realpathSync.native(path);
if (identity(fixture.repository) !== identity(repository) || identity(fixture.workspace) !== identity(join(extension, '../workspace')) ||
    identity(fixture.evidence) !== identity(join(extension, '../evidence')))
  throw new Error('The fixture does not own its expected repository, workspace and evidence paths.');
mkdirSync(join(fixture.evidence, 'native-pilot'), { recursive: true });
// Existing installed plug-ins can contribute the same legacy role names. The
// isolated M3 proof binds these workspace profiles only; user projects and
// global plug-in enablement are left unchanged.
const settingsPath = join(fixture.workspace, '.vscode/settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings['chat.plugins.enabled'] = false;
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
for (const role of nativeRoles) {
  const path = join(fixture.workspace, '.github/agents', `native-${role.slice(3).toLowerCase()}.agent.md`);
  const text = nativeEntry ? nativeLocalProfile(role) : nativeLocalProfile(role).replace(/\bworkforceNativeRequest\b/g, 'workforceNativePilot');
  if (existsSync(path) && readFileSync(path, 'utf8') !== text && !process.argv.includes('--refresh-owned-profiles')) throw new Error('Existing fixture profile differs; inspect it before changing.');
  if (!existsSync(path) || process.argv.includes('--refresh-owned-profiles')) writeFileSync(path, text);
}
for (const role of nativeSpecialists) {
  const path = join(fixture.workspace, '.github/agents', `native-worker-${role.slice(3).toLowerCase()}.agent.md`);
  const text = nativeLocalWorkerProfile(role);
  if (existsSync(path) && readFileSync(path, 'utf8') !== text && !process.argv.includes('--refresh-owned-profiles')) throw new Error('Existing fixture worker profile differs; inspect it before changing.');
  if (!existsSync(path) || process.argv.includes('--refresh-owned-profiles')) writeFileSync(path, text);
}
const guide = join(fixture.workspace, '.workforce/guides/native-reuse.md');
mkdirSync(dirname(guide), { recursive: true });
copyFileSync(join(repository, 'resources/guides/native-reuse.md'), guide);
const manifestPath = join(extension, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.contributes.languageModelTools = [{ name: 'workforce_m3_pilot', toolReferenceName: 'workforceNativePilot',
  displayName: 'WorkForce native software pilot', canBeReferencedInPrompt: true,
  modelDescription: 'Implement and independently review/check a bounded software request using its short professional plan. The adapter owns native specialist calls and record identities. Return the actual backend result.',
  inputSchema: nativeLocalRequestJsonSchema }, { name: 'workforce_m4_role', toolReferenceName: 'workforceRoleJob',
  displayName: 'WorkForce scoped role job', canBeReferencedInPrompt: true,
  modelDescription: 'Delegate an explicitly requested single role scope. The backend saves the professional result without claiming whole-product acceptance.',
  inputSchema: nativeRoleJobJsonSchema }, { name: 'workforce_m5_prepare', toolReferenceName: 'workforcePrepare',
  displayName: 'WorkForce experience preparation', canBeReferencedInPrompt: true,
  modelDescription: 'Find relevant accepted experience and eligible project procedures before planning. Preparation never executes a procedure or blocks ordinary implementation.',
  inputSchema: nativeWorkPrepareJsonSchema }, { name: 'workforce_m4_control', toolReferenceName: 'workforceRequestControl',
  displayName: 'WorkForce retained request', canBeReferencedInPrompt: true,
  modelDescription: 'Inspect a returned public request key, or recheck unchanged independently inspected products after correcting their environment. Keep the existing request; do not submit a replacement.',
  inputSchema: nativeRequestControlJsonSchema }];
if (nativeEntry) {
  const product = JSON.parse(readFileSync(join(repository, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  manifest.contributes.languageModelTools = product.contributes.languageModelTools.filter(tool => tool.name.startsWith('workforce_native_'));
  if (manifest.contributes.languageModelTools.length !== 10) throw new Error('The product native tool manifest is incomplete.');
  const packageCommands = product.contributes.commands.filter(command => command.command === 'workforce.nativePackages.manage');
  if (packageCommands.length !== 1) throw new Error('The product native package-management command is missing or ambiguous.');
  manifest.contributes.commands = [...(manifest.contributes.commands ?? []).filter(command => command.command !== 'workforce.nativePackages.manage'),
    ...packageCommands];
}
for (const name of ['extension.cjs', 'v-model-fixture.cjs', 'native-pilot.cjs']) copyFileSync(join(here, name), join(extension, name));
copyFileSync(join(here, 'hook.cjs'), join(fixture.workspace, 'm2-hook.cjs'));
fixture.nativePilot = true;
fixture.nativeProductEntry = nativeEntry;
fixture.coordinator = 'WF.PM';
fixture.worker = 'WF.Tester';
if (!nativeEntry) fixture.prompt = 'Create add.mjs exporting add(a, b), and add.test.mjs using node:test. Cover positive numbers, zero and negative numbers. Use WorkForce to implement, independently review and test the result, then report the accepted product. Keep all existing fixture files unchanged.';
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ workspace: fixture.workspace, entry: nativeEntry ? 'product-native' : 'development-pilot',
  registered_tools: manifest.contributes.languageModelTools.map(tool => tool.name), dispatched: false }));
