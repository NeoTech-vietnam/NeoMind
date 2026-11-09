// One schema source for the packaged native tools and generated role profiles.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nativeLocalRequestJsonSchema, nativeRequestControlJsonSchema, nativeLocalToolReferences, nativeRootRoleToolReferences } from '../dist/native-local-contract.js';
import { nativeRoleJobJsonSchema, nativeRoleContentJsonSchema } from '../dist/native-role-job.js';
import { nativeWorkPrepareJsonSchema } from '../dist/native-work.js';
import { nativeCapabilityJsonSchema, nativeCapabilitySourceJsonSchema, DEFAULT_NATIVE_CAPABILITY_SOURCES } from '../dist/native-capabilities.js';

const require = createRequire(import.meta.url);
const { nativeToolNames, nativeRoleToolNames } = require('../extensions/vscode-model-bridge/native-entry.cjs');
const path = fileURLToPath(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url));
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const descriptions = {
  request: 'Submit the ordinary requirement and professional software plan once. WorkForce owns valid native specialist calls, saved engineering identities, independent inspection, actual checks and acceptance. Optional plan.role_skills selects exact installed current workspace skill names per worker; omission uses ordinary project tools. Selection does not prove skill loading or use. Do not open a replacement request to retry an unfinished one.',
  role: 'Complete an explicitly requested single named role scope. Optional skills selects exact installed current workspace skill names with host-pinned receipts and files; omit for ordinary tools. Whole-product acceptance is not implied by a scoped professional report.',
  prepare: 'Find relevant accepted experience and eligible project scripts before planning. Retrieval never starts a procedure or blocks ordinary implementation.',
  control: 'Inspect a public request key, recheck unchanged reviewed products after an environment correction or confirmed ended checker interruption, or explicitly resume retained findings or a backend-reconciled editor interruption. Preserve scope, history and repair allowance; keep the same request instead of submitting a replacement. Unknown effects are not blindly replayed.',
  capabilities: 'Search approved pinned capability catalogs, inspect a named package, install an exact portable skill, or view current workspace skills. The host owns source approval and license verification. Optional unavailable or unsupported capabilities fall back to ordinary project tools; this never starts workers, runs hooks or installs MCP dependencies.',
};
const schemas = { request: nativeLocalRequestJsonSchema, role: nativeRoleJobJsonSchema,
  prepare: nativeWorkPrepareJsonSchema, control: nativeRequestControlJsonSchema, capabilities: nativeCapabilityJsonSchema };
const tools = Object.keys(nativeToolNames).map(kind => ({ name: nativeToolNames[kind],
  toolReferenceName: nativeLocalToolReferences[kind], displayName: `WorkForce native ${kind}`,
  canBeReferencedInPrompt: true, modelDescription: descriptions[kind], inputSchema: {
    ...schemas[kind], properties: { ...schemas[kind].properties, workspace_folder: { type: 'string', minLength: 1, maxLength: 4096,
      description: 'Exact absolute open workspace folder. Optional for one local folder; required when multiple projects are open.' } },
  } }));
for (const [role, name] of Object.entries(nativeRoleToolNames)) tools.push({ name,
  toolReferenceName: nativeRootRoleToolReferences[role], displayName: `WorkForce ${role} role request`, canBeReferencedInPrompt: true,
  modelDescription: `Complete the ${role} assignment through its backend-owned scoped worker. Supply professional content; the role is fixed by this tool. Optional skills selects exact installed current workspace skill names; omission uses ordinary project tools. The host pins selected receipts and files; selection does not prove loading/use.`,
  inputSchema: { ...nativeRoleContentJsonSchema, properties: { ...nativeRoleContentJsonSchema.properties,
    workspace_folder: { type: 'string', minLength: 1, maxLength: 4096, description: 'Exact absolute open workspace folder. Optional for one local folder; required when multiple projects are open.' } } } });
const names = new Set([...Object.values(nativeToolNames), ...Object.values(nativeRoleToolNames)]);
manifest.contributes.languageModelTools = [...manifest.contributes.languageModelTools.filter(tool => !names.has(tool.name)), ...tools];
manifest.activationEvents = [...new Set([...manifest.activationEvents, ...[...names].map(name => `onLanguageModelTool:${name}`)])];
manifest.files = [...new Set([...manifest.files, 'native-entry.cjs'])];
manifest.contributes.configuration.properties['workforce.capabilities.sources'] = {
  type: 'array', scope: 'machine', default: DEFAULT_NATIVE_CAPABILITY_SOURCES,
  description: 'Approved immutable public capability catalogs for native WF.PM. Read only from User settings; workspace overrides are ignored. An explicit empty User array disables external sources. Project network policy still controls downloads. Only portable skill files are installed, without hooks or MCP dependencies.',
  maxItems: 32, items: nativeCapabilitySourceJsonSchema,
};
const text = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== text) throw new Error('Native tool manifest differs from the shared runtime contract. Run node scripts/build-native-tools.mjs after building.');
} else writeFileSync(path, text);
