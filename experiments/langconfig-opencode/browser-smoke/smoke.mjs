import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const stage = process.env.LANGCONFIG_STAGE;
const modules = process.env.LANGCONFIG_MODULES;
const requireLab = createRequire(path.join(modules, 'package.json'));
const esbuild = requireLab('esbuild');
const { chromium } = requireLab('playwright');
const panel = path.join(stage, 'src/features/workflows/node-config/NodeConfigPanel.tsx');
const panelHash = createHash('sha256').update(await readFile(panel)).digest('hex');

const build = await esbuild.build({
  entryPoints: [path.join(here, 'fixture.tsx')], bundle: true, write: false,
  format: 'iife', platform: 'browser', jsx: 'automatic',
  nodePaths: [modules], logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ DEV: true, PROD: false, MODE: 'development' }), 'process.env.NODE_ENV': '"development"' },
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  plugins: [{ name: 'stage-alias', setup(build) {
    build.onResolve({ filter: /^@\// }, args => build.resolve(path.join(stage, 'src', args.path.slice(2)), { kind: args.kind, resolveDir: stage }));
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: requireLab.resolve(args.path) }));
  } }],
});

const apiRequests = [];
const unexpected = [];
const errors = [];
const routes = new Map([
  ['/api/custom-tools', []], ['/api/skills/', []], ['/api/workflows/', []],
  ['/api/output-schemas', []], ['/api/settings/default-guardrails', { guardrails: '', description: '' }],
]);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root"></div><pre id="saved"></pre><script src="/fixture.js"></script></body></html>');
  } else if (req.method === 'GET' && url.pathname === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(build.outputFiles[0].contents);
  } else if (req.method === 'GET' && routes.has(url.pathname)) {
    apiRequests.push(url.pathname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(routes.get(url.pathname)));
  } else {
    unexpected.push(`${req.method} ${url.pathname}`);
    res.writeHead(404); res.end();
  }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-proxy-server'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port)) {
      external.push(url.origin); await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('page crashed'));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
  const select = page.locator('select').filter({ has: page.locator('option[value="mcp:opencode_review"]') });
  await select.waitFor({ timeout: 15000 });
  await select.selectOption('mcp:opencode_review');
  await page.locator('label').filter({ hasText: 'attempt_id' }).locator('..').locator('input').fill('fixture-attempt-001');
  await page.locator('label').filter({ hasText: 'instruction' }).locator('..').locator('input').fill('Review only this fixture.');
  await page.getByRole('button', { name: 'Save Tool Configuration' }).click();
  const saved = JSON.parse(await page.locator('#saved').textContent());
  assert.equal(saved.nodeId, 'fixture-review-node');
  assert.equal(saved.config.tool_type, 'mcp');
  assert.equal(saved.config.tool_id, 'opencode_review');
  assert.deepEqual(saved.config.tool_params, { attempt_id: 'fixture-attempt-001', instruction: 'Review only this fixture.' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(unexpected, []);
  assert(apiRequests.includes('/api/custom-tools'));
  console.log(JSON.stringify({ result: 'pass', panel_sha256: panelHash, node_id: saved.nodeId,
    tool_type: saved.config.tool_type, tool_id: saved.config.tool_id, tool_params: saved.config.tool_params,
    api_requests: apiRequests, external_requests: external.length, page_errors: errors.length }, null, 2));
} catch (error) {
  console.error('Smoke failed:', error.message, JSON.stringify({ apiRequests, unexpected, errors }));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
