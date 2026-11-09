// Add the deterministic MCP provider only to an already owned disposable proof
// extension. No User settings, trust decisions, chat requests or model calls.
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url)), repository = realpathSync.native(resolve(here, '../../..'));
const base = realpathSync.native(join(repository, 'artifacts/workforce-native-local-proof'));
const extension = realpathSync.native(resolve(process.argv[2] ?? ''));
const child = relative(base, extension);
if (!child || child.startsWith('..') || isAbsolute(child) || !/^[a-f0-9]{8}[\\/]extension$/.test(child)) throw Error('Select an owned native Local fixture extension.');
const fixturePath = join(extension, 'fixture.json'), manifestPath = join(extension, 'package.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const identity = file => { const actual = realpathSync.native(file); return process.platform === 'win32' ? actual.toLowerCase() : actual; };
if (identity(fixture.repository) !== identity(repository) || identity(fixture.workspace) !== identity(join(extension, '../workspace')) ||
    identity(fixture.evidence) !== identity(join(extension, '../evidence'))) throw Error('Fixture ownership does not match expected paths.');
fixture.enable_mcp_fixture = true;
fixture.mcp_fixture_nonce ??= randomBytes(16).toString('hex');
fixture.mcp_fixture_node = process.execPath;
fixture.mcp_fixture_hold_until_release = process.argv.includes('--hold-echo');
mkdirSync(join(fixture.evidence, 'native-mcp'), { recursive: true });
manifest.contributes ??= {};
const providers = manifest.contributes.mcpServerDefinitionProviders ?? [];
if (!Array.isArray(providers) || providers.some(provider => provider.id === 'native-proof-fixture' && provider.label !== 'Native Fixture')) throw Error('Existing provider contribution differs.');
if (!providers.some(provider => provider.id === 'native-proof-fixture')) providers.push({ id: 'native-proof-fixture', label: 'Native Fixture' });
manifest.contributes.mcpServerDefinitionProviders = providers;
for (const name of ['extension.cjs', 'native-mcp-provider.cjs', 'native-mcp-fixture.cjs']) copyFileSync(join(here, name), join(extension, name));
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ workspace: fixture.workspace, extension, provider_id: 'native-proof-fixture', label: 'Native Fixture',
  nonce: fixture.mcp_fixture_nonce, evidence: join(fixture.evidence, 'native-mcp'), gated: fixture.mcp_fixture_hold_until_release,
  dispatched: false, trust: 'unchanged', native_tool_name: 'not-yet-observed', native_tool_reference: 'not-yet-observed' }));
