// Prepare a reviewable D-drive fixture/config. Never launches VS Code or a model.
import { randomUUID, createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(repository, 'artifacts/workforce-client-driver'), runId = randomUUID(), run = join(base, runId);
const fixture = join(run, 'workspace'), output = join(run, 'evidence'); mkdirSync(output, { recursive: true });
cpSync(join(repository, 'test/fixtures/workforce-client'), fixture, { recursive: true, errorOnExist: true });
const promptFile = join(repository, 'test/fixtures/workforce-client/request.txt');
const prompt = readFileSync(promptFile, 'utf8').trim(), authorization = join(run, 'authorization.json');
const config = { schema_version: 1, run_id: runId, workspace_root: fixture, runtime_root: repository, output_directory: output,
  prompt_file: promptFile, authorization_file: authorization, model_vendor: 'customendpoint', model_alias: 'top-models',
  context_paths: [join(fixture, '02_contiguous_vs_linked_structures/README.md')], forbidden_roots: ['D:/workspace/NeoLearning'], observation_timeout_ms: 1200000 };
writeFileSync(join(base, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(authorization, `${JSON.stringify({ allow_chat_dispatch: false, run_id: runId, workspace_root: fixture,
  prompt_sha256: createHash('sha256').update(prompt).digest('hex'), max_user_prompts: 1 }, null, 2)}\n`);
const git = spawnSync('git', ['init', '--quiet', fixture], { cwd: fixture, encoding: 'utf8', shell: false, windowsHide: true });
if (git.status !== 0) throw new Error('The acceptance fixture requires its own isolated Git root.');
const initialized = spawnSync(process.execPath, [join(repository, 'dist/cli.js'), 'init', '--name', 'Real Local Copilot acceptance fixture', '--profile', 'software',
  '--platforms', 'copilot', '--local', '--project', fixture, '--json'], { cwd: fixture, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 });
if (initialized.status !== 0) throw new Error(`Fixture initialization failed: ${initialized.stderr.slice(-2000)}`);
console.log(JSON.stringify({ config: join(base, 'config.json'), workspace: fixture, authorization,
  status: 'prepared-with-chat-dispatch-disabled', user_prompt: prompt, launched_vscode: false, model_calls: 0 }, null, 2));
