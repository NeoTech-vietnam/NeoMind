// Explicit read-only acceptance probe. These are source-comparison examples,
// not a fixed plugin catalog, automatic role selection or installation proof.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAgentMarketplace, inspectAgentMarketplacePlugin } from '../../../dist/agent-marketplace.js';
import { createGitHubAgentMarketplaceReader } from '../../../dist/agent-marketplace-github.js';

const repository = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const base = realpathSync.native(join(repository, 'artifacts/workforce-native-local-proof'));
const extension = realpathSync.native(resolve(process.argv[2] ?? ''));
const child = relative(base, extension), name = process.argv[3];
if (!/^[a-f0-9]{8}[\\/]extension$/.test(child) || isAbsolute(child) || !/^[a-z0-9-]+\.json$/.test(name ?? ''))
  throw new Error('Select an owned proof fixture and a new evidence JSON filename.');
const fixture = JSON.parse(readFileSync(join(extension, 'fixture.json'), 'utf8'));
if (realpathSync.native(fixture.evidence) !== realpathSync.native(join(extension, '../evidence')))
  throw new Error('Evidence does not belong to the selected proof fixture.');
const sources = [
  { repository: 'https://github.com/github/awesome-copilot', commit: '797337f33f73e35d08d82f840e21c4b8c4932d88' },
  { repository: 'https://github.com/github/copilot-plugins', commit: 'b0216dbc8f6f7ac1cfce85e925dfa5d5e423876a' },
];
const calls = [];
const reader = createGitHubAgentMarketplaceReader({ allowed_repositories: sources.map(source => source.repository), timeout_ms: 10000,
  fetch: async (url, options) => {
    calls.push({ url, at: new Date().toISOString() });
    return globalThis.fetch(url, options);
  } });
const catalogs = [];
for (const source of sources) {
  const catalog = await discoverAgentMarketplace(source, reader);
  catalogs.push(catalog);
}
const examples = ['project-documenter', 'testing-automation', 'security-best-practices', 'frontend-web-dev'];
const packages = [];
for (const name of examples) {
  const candidate = catalogs[0].candidates.find(candidate => candidate.name === name);
  if (!candidate) throw new Error('The pinned catalog lacks an expected inspected example.');
  packages.push(await inspectAgentMarketplacePlugin(candidate, reader));
}
const files = [];
const resolveAliases = process.argv.includes('--resolve-git-aliases');
for (const path of ['LICENSE', 'plugins/project-documenter/skills/md-to-docx/SKILL.md',
  'plugins/security-best-practices/skills/ai-prompt-engineering-safety-review/SKILL.md']) {
  try {
    const input = { ...sources[0], path, max_bytes: 256 * 1024, signal: new AbortController().signal };
    const resolution = resolveAliases ? await reader.resolvePath(input) : undefined;
    const file = await reader({ ...input, path: resolution?.resolved_path ?? path });
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    files.push({ path, state: 'ordinary-pinned-file-read', bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...(resolution ? { resolution } : {}) });
  } catch (error) {
    files.push({ path, state: 'not-read', code: error.code ?? 'UNKNOWN', reason: error.reason ?? 'unknown' });
  }
}
const result = { at: new Date().toISOString(), source_reader: 'explicit-public-github-rest', model_calls: 0,
  explicit_pinned_git_alias_resolution: resolveAliases,
  catalogs: catalogs.map(catalog => ({ name: catalog.name, status: catalog.status, provenance: catalog.provenance,
    candidates: catalog.candidates.length, package_pin_required: catalog.candidates.filter(candidate => candidate.state === 'package-pin-required').length,
    issues: catalog.issues })), packages, component_file_observations: files, transport_requests: calls,
  installation: 'not-performed', execution: 'not-performed', native_local_compatibility: 'not-verified' };
writeFileSync(join(fixture.evidence, name), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ catalogs: result.catalogs.map(catalog => ({ name: catalog.name, state: catalog.status, candidates: catalog.candidates })),
  packages: packages.map(item => item.name), files, network_reads: calls.length, model_calls: 0, installation: 'not-performed' }));
