// Public metadata only. Never clones, installs, evaluates or adopts candidate code.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const commitPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packagePattern = /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const integrity = value => typeof value === 'string' && integrityPattern.test(value) && Buffer.from(value.slice(7), 'base64').length === 64;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export function validateWatchManifest(value) {
  if (!keys(value, ['schema_version', 'sources', 'discovery']) || value.schema_version !== 1 || !Array.isArray(value.sources) || value.sources.length > 12 || !Array.isArray(value.discovery) || value.discovery.length > 3)
    throw new Error('Invalid upstream watch manifest.');
  const ids = new Set();
  for (const source of value.sources) {
    if (!keys(source, ['id', 'repository', 'ref', 'commit', 'license', 'package']) || typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(source.id) || ids.has(source.id) ||
        typeof source.repository !== 'string' || !repositoryPattern.test(source.repository) || typeof source.ref !== 'string' || !source.ref || source.ref.length > 200 || /[\x00-\x20\x7f]/.test(source.ref) ||
        typeof source.commit !== 'string' || !commitPattern.test(source.commit) || typeof source.license !== 'string' || !/^[A-Za-z0-9.+-]{1,100}$/.test(source.license)) throw new Error('Invalid watched source or pin.');
    ids.add(source.id);
    if (source.package !== undefined && (!keys(source.package, ['name', 'version', 'integrity']) || typeof source.package.name !== 'string' || !packagePattern.test(source.package.name) || typeof source.package.version !== 'string' || !versionPattern.test(source.package.version) || !integrity(source.package.integrity)))
      throw new Error('Watched npm packages require exact versions and SHA-512 integrity.');
  }
  for (const discovery of value.discovery) if (!keys(discovery, ['query', 'minimum_stars', 'limit']) || typeof discovery.query !== 'string' || !discovery.query.trim() || discovery.query.length > 300 || /[\x00-\x1f\x7f]/.test(discovery.query) ||
      !Number.isSafeInteger(discovery.minimum_stars) || discovery.minimum_stars < 0 || discovery.minimum_stars > 1_000_000_000 || !Number.isSafeInteger(discovery.limit) || discovery.limit < 1 || discovery.limit > 10)
    throw new Error('Invalid bounded discovery query.');
  return value;
}
function metadata(value, expected) {
  if (!object(value) || typeof value.full_name !== 'string' || !repositoryPattern.test(value.full_name) || (expected && value.full_name.toLowerCase() !== expected.toLowerCase()) ||
      (value.private !== undefined && value.private !== false) || (value.visibility !== undefined && value.visibility !== 'public') ||
      !Number.isSafeInteger(value.stargazers_count) || value.stargazers_count < 0 || typeof value.archived !== 'boolean') throw new Error('Invalid repository metadata.');
  const license = value.license?.spdx_id ?? null;
  if (license !== null && (typeof license !== 'string' || !/^[A-Za-z0-9.+-]{1,100}$/.test(license))) throw new Error('Invalid license metadata.');
  return { repository: value.full_name, url: `https://github.com/${value.full_name}`, stars: value.stargazers_count, archived: value.archived, license };
}
function npmMetadata(value, name) {
  if (!object(value) || value.name !== name || typeof value.version !== 'string' || !versionPattern.test(value.version) || !integrity(value.dist?.integrity)) throw new Error('Invalid npm metadata.');
  const node = value.engines?.node ?? null;
  if (node !== null && (typeof node !== 'string' || node.length > 200 || /[\x00-\x1f\x7f]/.test(node))) throw new Error('Invalid npm Node requirement.');
  return { name, version: value.version, integrity: value.dist.integrity, node };
}
export async function checkWatchedUpstreams(input, options = {}) {
  const manifest = validateWatchManifest(input), fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  const request = async url => {
    const github = new URL(url).origin === 'https://api.github.com';
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { Accept: 'application/json', 'User-Agent': 'NeoMind-upstream-candidate-check',
        ...(github ? { 'X-GitHub-Api-Version': '2022-11-28', ...(options.githubToken ? { Authorization: `Bearer ${options.githubToken}` } : {}) } : {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing metadata body');
    let size = 0; const chunks = [];
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error('Metadata size limit'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const sources = [];
  for (const source of manifest.sources) {
    try {
      const repo = metadata(await request(`https://api.github.com/repos/${source.repository}`), source.repository);
      const head = await request(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`);
      if (!object(head) || typeof head.sha !== 'string' || !commitPattern.test(head.sha)) throw new Error('Invalid candidate commit');
      let packageResult = null;
      if (source.package) {
        const name = encodeURIComponent(source.package.name);
        const pinned = npmMetadata(await request(`https://registry.npmjs.org/${name}/${source.package.version}`), source.package.name);
        const latest = npmMetadata(await request(`https://registry.npmjs.org/${name}/latest`), source.package.name);
        if (pinned.version !== source.package.version) throw new Error('Wrong npm pinned version');
        packageResult = { pinned, integrity_matches: pinned.integrity === source.package.integrity, latest,
          update_available: latest.version !== pinned.version };
      }
      sources.push({ id: source.id, status: 'checked', ...repo, pinned_commit: source.commit, candidate_commit: head.sha,
        source_update_available: head.sha !== source.commit, license_changed: repo.license !== source.license, package: packageResult });
    } catch (error) {
      const status = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? ` (${error.message})` : '';
      sources.push({ id: source.id, repository: source.repository, status: 'failed', error: `Public metadata check failed${status}; no adoption attempted.` });
    }
  }
  const discoveries = [];
  for (const discovery of manifest.discovery) {
    try {
      const query = `${discovery.query} stars:>=${discovery.minimum_stars} archived:false fork:false`;
      const result = await request(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${discovery.limit}`);
      if (!Array.isArray(result.items) || result.items.length > 10) throw new Error('Invalid discovery result');
      discoveries.push({ query: discovery.query, status: 'checked', minimum_stars: discovery.minimum_stars,
        candidates: result.items.map(item => metadata(item)).filter(item => !item.archived && item.stars >= discovery.minimum_stars).slice(0, discovery.limit) });
    } catch { discoveries.push({ query: discovery.query, status: 'failed', error: 'Public discovery failed; no candidates adopted.' }); }
  }
  return { schema_version: 1, observed_at: options.observedAt ?? new Date().toISOString(),
    mode: 'candidate-report-only', adopted_changes: 0, sources, discoveries };
}
const md = value => String(value ?? 'unknown').replace(/[\\`*_[\]<>|]/g, character => `\\${character}`);
export function renderCandidateReport(report) {
  const lines = ['# NeoMind upstream candidates', '', `Observed: ${md(report.observed_at)}`, '',
    'Metadata checks only. Adopted pins, installed packages and original skills were not changed. Stars select research candidates; they do not establish safety or suitability.', '',
    '| Source | Result | Source candidate | npm candidate | Review |', '| --- | --- | --- | --- | --- |'];
  for (const source of report.sources) {
    if (source.status !== 'checked') { lines.push(`| ${md(source.id)} | failed | — | — | ${md(source.error)} |`); continue; }
    const review = [source.license_changed ? 'license changed' : null, source.archived ? 'archived' : null,
      source.package && !source.package.integrity_matches ? 'PIN INTEGRITY MISMATCH' : null,
      source.source_update_available || source.package?.update_available ? 'review candidate diff and tests' : 'no update observed'].filter(Boolean).join('; ');
    lines.push(`| [${md(source.repository)}](${source.url}) | checked | ${source.source_update_available ? md(source.candidate_commit) : 'unchanged'} | ${source.package?.update_available ? md(source.package.latest.version) : 'unchanged'} | ${md(review)} |`);
  }
  for (const discovery of report.discoveries) {
    lines.push('', `## Discovery: ${md(discovery.query)}`, '');
    if (discovery.status !== 'checked') lines.push(md(discovery.error));
    else for (const candidate of discovery.candidates) lines.push(`- [${md(candidate.repository)}](${candidate.url}) — ${candidate.stars} stars; license ${md(candidate.license)}; inspect before reuse.`);
  }
  return lines.join('\n') + '\n';
}
async function main() {
  const args = process.argv.slice(2), flags = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--manifest', '--out'].includes(args[index]) || !args[index + 1] || flags[args[index]]) throw new Error('Usage: node scripts/check-upstreams.mjs --manifest <JSON> --out <report.json>');
    flags[args[index]] = args[index + 1];
  }
  if (!flags['--manifest'] || !flags['--out']) throw new Error('Manifest and output are required.');
  const output = resolve(flags['--out']);
  if (!output.toLowerCase().endsWith('.json')) throw new Error('Candidate output must be a .json file.');
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(flags['--manifest']), 'utf8')); }
  catch { throw new Error('Public watch manifest could not be read as JSON.'); }
  const report = await checkWatchedUpstreams(manifest, { githubToken: process.env.GITHUB_TOKEN });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); writeFileSync(output.replace(/\.json$/i, '') + '.md', renderCandidateReport(report));
  console.log(JSON.stringify({ mode: report.mode, adopted_changes: 0, checked_sources: report.sources.length,
    failed_sources: report.sources.filter(source => source.status === 'failed').length, discovery_queries: report.discoveries.length }));
  if (report.sources.some(source => source.status === 'failed' || (source.package && !source.package.integrity_matches)) || report.discoveries.some(discovery => discovery.status === 'failed')) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
