import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const requireLab = createRequire(path.join(process.env.LANGCONFIG_MODULES, 'package.json'));
const { chromium } = requireLab('playwright');
const { startEditorServer } = await import(pathToFileURL(path.join(root, 'dist/src/ui-server/server.js')).href);
const project = path.join(process.env.WORK, 'project');
await mkdir(project);
await writeFile(path.join(project, 'fixture.txt'), 'fixture before preview\n');
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', encoding: 'utf8' });
git('init', '-q');
git('add', 'fixture.txt');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');

async function snapshot(dir, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name), full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(full, rel));
    else if (entry.isFile()) result[rel] = createHash('sha256').update(await readFile(full)).digest('hex');
    else throw new Error('Unexpected non-regular fixture entry');
  }
  return result;
}

const before = await snapshot(project);
const head = git('rev-parse', 'HEAD').trim();
const fixture = await readFile(path.join(root, 'experiments/langconfig-opencode/graph-preview/fixtures/workflow-export.json'));
const requests = [], mocked = [], unexpected = [], errors = [];
let editor, browser;
try {
  editor = await startEditorServer(project, 0, path.join(root, 'dist-ui'));
  browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-proxy-server'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== editor.url) { unexpected.push('external origin'); return route.abort(); }
    if (method === 'GET' && ['/api/runs', '/api/programs', '/api/runners/opencode', '/api/stats'].includes(url.pathname)) {
      mocked.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname === '/api/programs' ? { programs: [] } : url.pathname === '/api/runners/opencode' ? { runners: [] } : url.pathname === '/api/stats' ? { byFlowRunners: [] } : { runs: [] }) });
    }
    if (method === 'POST' && url.pathname === '/api/langconfig/preview') {
      assert.equal(request.headers()['x-neomind-token'], editor.token);
      assert.equal(request.headers().origin, editor.url);
      requests.push('POST /api/langconfig/preview');
      return route.continue();
    }
    if (method === 'GET' && (!url.pathname.startsWith('/api/') || ['/api/bootstrap', '/api/runners'].includes(url.pathname))) return route.continue();
    unexpected.push(`${method} ${url.pathname}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(editor.url, { waitUntil: 'load', timeout: 60000 });
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước LangConfig…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Xem trước workflow LangConfig' });
  const previewResponse = page.waitForResponse(response => response.url() === `${editor.url}/api/langconfig/preview` && response.request().method() === 'POST');
  await dialog.getByLabel('Chọn file .langconfig hoặc JSON (tối đa 1 MiB)').setInputFiles({ name: 'fixture.langconfig', mimeType: 'application/json', buffer: fixture });
  const received = await previewResponse;
  assert.equal(received.status(), 200);
  assert.doesNotMatch(await received.text(), /SECRET_|BLUEPRINT_NOT_CANVAS/);
  await dialog.getByRole('heading', { name: 'Chẩn đoán' }).waitFor();
  await dialog.getByText('Workflow export 1.0', { exact: false }).waitFor();
  assert.match(await dialog.innerText(), /loop không tương đương vòng sửa/);
  assert.match(await dialog.innerText(), /không phải flow có thể chạy/);
  assert.doesNotMatch(await page.locator('body').innerText(), /SECRET_|BLUEPRINT_NOT_CANVAS/);
  assert.deepEqual(requests, ['POST /api/langconfig/preview']);

  // The limit is enforced in the browser before a second request is sent.
  await dialog.getByLabel('Chọn file .langconfig hoặc JSON (tối đa 1 MiB)').setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(1024 * 1024 + 1, 0x20) });
  await dialog.getByRole('alert').getByText(/vượt giới hạn 1 MiB/).waitFor();
  assert.deepEqual(requests, ['POST /api/langconfig/preview']);
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().click();
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(await snapshot(project), before);
  assert.equal(git('rev-parse', 'HEAD').trim(), head);
  assert.equal(git('status', '--porcelain'), '');
  console.log(JSON.stringify({ result: 'pass', editor: 'actual HTTP server and built web UI', preview_posts: requests.length,
    fake_background_gets: [...new Set(mocked)], unexpected_requests: unexpected.length, page_errors: errors.length,
    fixture_project_files_unchanged: true, git_head_unchanged: true, no_large_file_request: true }, null, 2));
} catch (error) {
  console.error('Smoke failed:', error instanceof Error ? error.message : 'unknown', JSON.stringify({ requests, mocked, unexpected, errors }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (editor) await editor.close();
}
