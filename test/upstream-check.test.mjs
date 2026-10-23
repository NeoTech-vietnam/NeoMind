import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateWatchManifest, checkWatchedUpstreams, renderCandidateReport } from '../scripts/check-upstreams.mjs';

const integrity = byte => `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
function manifest() { return { schema_version: 1, sources: [{ id: 'example', repository: 'example/agents', ref: 'main', commit: 'a'.repeat(40), license: 'MIT',
  package: { name: '@example/agents', version: '1.0.0', integrity: integrity(1) } }], discovery: [{ query: 'topic:ai-agents', minimum_stars: 1000, limit: 5 }] }; }
const repository = (name = 'example/agents', stars = 1500, extra = {}) => ({ full_name: name, stargazers_count: stars, archived: false, license: { spdx_id: 'MIT' }, ...extra });
function fixture(options = {}) {
  const requests = [];
  const fetcher = async (url, request) => {
    requests.push({ url, headers: request.headers });
    if (options.fail) throw new Error('Provider included super-private-token-and-url');
    let data;
    if (url.includes('/search/repositories')) data = { items: [repository(), repository('example/small', 2), repository('example/archived', 2000, { archived: true })] };
    else if (url.endsWith('/commits/main')) data = { sha: 'b'.repeat(40) };
    else if (url.startsWith('https://api.github.com/repos/')) data = repository('example/agents', 1500, { license: { spdx_id: options.license ?? 'MIT' } });
    else data = { name: '@example/agents', version: url.endsWith('/latest') ? '2.0.0' : '1.0.0', dist: { integrity: options.badIntegrity ? integrity(3) : integrity(url.endsWith('/latest') ? 2 : 1) }, engines: { node: '>=26' } };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, fetcher };
}

test('metadata checks report distinct source/package candidates, filter popularity, preserve pins and isolate GitHub authentication', async () => {
  const input = manifest(), before = structuredClone(input), remote = fixture();
  const report = await checkWatchedUpstreams(input, { ...remote, githubToken: 'private-fixture-token', observedAt: '2026-10-24T00:00:00.000Z' });
  assert.deepEqual(input, before);
  assert.equal(report.mode, 'candidate-report-only'); assert.equal(report.adopted_changes, 0);
  assert.equal(report.sources[0].pinned_commit, 'a'.repeat(40));
  assert.equal(report.sources[0].candidate_commit, 'b'.repeat(40));
  assert.equal(report.sources[0].package.pinned.version, '1.0.0');
  assert.equal(report.sources[0].package.latest.version, '2.0.0');
  assert.equal(report.sources[0].package.integrity_matches, true);
  assert.deepEqual(report.discoveries[0].candidates.map(candidate => candidate.repository), ['example/agents']);
  assert.ok(remote.requests.every(request => request.url.startsWith('https://api.github.com/') || request.url.startsWith('https://registry.npmjs.org/')));
  for (const request of remote.requests) assert.equal(Boolean(request.headers.Authorization), request.url.startsWith('https://api.github.com/'));
  assert.doesNotMatch(JSON.stringify(report) + renderCandidateReport(report), /private-fixture-token/);
  assert.match(renderCandidateReport(report), /review candidate diff and tests/);
  assert.ok(remote.requests.some(request => decodeURIComponent(request.url).includes('stars:>=1000 archived:false fork:false')));
});

test('license and pinned-integrity changes require review; provider errors disclose no upstream body or token', async () => {
  const report = await checkWatchedUpstreams(manifest(), fixture({ license: 'GPL-3.0', badIntegrity: true }));
  assert.equal(report.sources[0].license_changed, true);
  assert.equal(report.sources[0].package.integrity_matches, false);
  assert.match(renderCandidateReport(report), /PIN INTEGRITY MISMATCH/);
  const failed = await checkWatchedUpstreams(manifest(), fixture({ fail: true }));
  assert.equal(failed.sources[0].status, 'failed');
  assert.equal(failed.discoveries[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /super-private-token|included|url/);
  assert.equal(failed.adopted_changes, 0);
});

test('watch manifests reject ranges, arbitrary endpoints, malformed pins and ambiguous entries before fetching', async () => {
  const changes = [
    input => { input.sources[0].package.version = '^1.0.0'; },
    input => { input.sources[0].repository = 'https://evil.invalid/agents'; },
    input => { input.sources[0].package.integrity = 'sha512-YWJj'; },
    input => { input.sources[0].package = false; },
    input => { delete input.sources[0].license; },
    input => { input.sources[0].id = false; },
    input => { input.sources[0].repository = ['example/agents']; },
    input => { input.sources[0].commit = ['a'.repeat(40)]; },
    input => { input.sources[0].package.name = ['@example/agents']; },
    input => { input.sources[0].package.version = ['1.0.0']; },
    input => { input.sources.push(input.sources[0]); },
    input => { input.discovery[0].limit = 999; },
    input => { input.sources[0].ref = 'main\nrun-command'; },
  ];
  for (const change of changes) {
    const input = manifest(); change(input); let calls = 0;
    await assert.rejects(checkWatchedUpstreams(input, { fetcher: async () => { calls++; throw new Error('Must not fetch'); } }));
    assert.equal(calls, 0);
  }
  assert.equal(validateWatchManifest(JSON.parse(readFileSync(new URL('../examples/upstream-watch.json', import.meta.url), 'utf8'))).sources[0].id, 'rea');
});

test('oversized metadata and repository substitution fail instead of producing an adoption proposal', async () => {
  const input = manifest(); input.discovery = [];
  const oversized = await checkWatchedUpstreams(input, { fetcher: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  assert.equal(oversized.sources[0].status, 'failed');
  const wrong = await checkWatchedUpstreams(input, { fetcher: async () => new Response(JSON.stringify(repository('other/agents'))) });
  assert.equal(wrong.sources[0].status, 'failed');
  assert.equal(wrong.adopted_changes, 0);
  for (const extra of [{ private: true }, { visibility: 'private' }, { visibility: 'internal' }, { full_name: ['example/agents'] }]) {
    const hidden = await checkWatchedUpstreams(input, { fetcher: async () => new Response(JSON.stringify(repository('example/agents', 1500, extra))) });
    assert.equal(hidden.sources[0].status, 'failed');
    assert.equal(hidden.adopted_changes, 0);
    assert.equal(hidden.sources[0].stars, undefined);
  }
});

test('scheduled workflow is metadata-only and self-hosted verification requires explicit dispatch', () => {
  const scheduled = parseYaml(readFileSync(new URL('../.github/workflows/upstream-check.yml', import.meta.url), 'utf8'));
  assert.deepEqual(scheduled.permissions, { contents: 'read' });
  assert.ok(scheduled.on.schedule[0].cron.startsWith('37 '));
  assert.equal(scheduled.on.pull_request, undefined);
  assert.equal(scheduled.on.workflow_dispatch.inputs.runner.default, 'github-hosted');
  const steps = scheduled.jobs.candidates.steps;
  assert.equal(steps.find(step => step.run).run, 'node scripts/check-upstreams.mjs --manifest examples/upstream-watch.json --out artifacts/upstream-candidates/report.json');
  assert.equal(steps.find(step => step.if === 'always()').with['retention-days'], 14);
  assert.ok(steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
  const manual = parseYaml(readFileSync(new URL('../.github/workflows/self-hosted-linux.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch']);
  assert.deepEqual(manual.permissions, { contents: 'read' });
  assert.deepEqual(manual.jobs.verify['runs-on'], ['self-hosted', 'linux', 'x64', 'neomind-ci']);
  assert.ok(manual.jobs.verify['timeout-minutes'] <= 45);
});
