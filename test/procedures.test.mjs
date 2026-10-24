import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  registerProcedure, discoverProcedureScripts, listProcedures, resolveProcedure,
  reviewProcedure, runProcedure, qualifyProcedure, suspendProcedure,
} from '../dist/procedures.js';

const generator = `import {mkdirSync,writeFileSync} from 'node:fs'; import {dirname} from 'node:path';
let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);
mkdirSync(dirname(input.outputs[0]),{recursive:true});writeFileSync(input.outputs[0],JSON.stringify({number:input.parameters.number}));
console.log('generated');`;
const verifier = `import {readFileSync} from 'node:fs';let data='';for await(const chunk of process.stdin)data+=chunk;
const input=JSON.parse(data);if(JSON.parse(readFileSync(input.outputs[0],'utf8')).number!==input.parameters.number)process.exit(2);console.log('verified');`;
function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-procedures-'));
  t.after(() => { const target = resolve(root); assert.ok(relative(tmpdir(), target).startsWith('neomind-procedures-')); rmSync(target, { recursive: true, force: true }); });
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'scripts', 'generate.mjs'), generator); writeFileSync(join(root, 'scripts', 'verify.mjs'), verifier);
  writeFileSync(join(root, 'checks', 'negative-cases.json'), JSON.stringify({ boundary: 'zero', invalid: 'negative number is rejected', independent_oracle: 'compare parsed generated value with input' }));
  const definition = {
    id: 'example-procedure', version: '1.0.0', title: 'Parameterized JSON artifact', description: 'Create and independently verify a JSON artifact.', task_family: 'json-artifact', keywords: ['json'], author: 'implementer',
    script: 'scripts/generate.mjs', verification_script: 'scripts/verify.mjs',
    parameters: { number: { type: 'integer', min: 0, max: 100 }, output: { type: 'string', path: true } },
    outputs: [{ path: '{output}', min_bytes: 1 }], environment: { platforms: [process.platform], clients: ['cli', 'codex', 'copilot'] },
    effects: { write_roots: ['output'], network: false, publication: false }, timeout_ms: 10000, ...changes,
  };
  registerProcedure(root, definition);
  const review = (overrides = {}) => reviewProcedure(root, { procedure_id: definition.id, reviewer: 'independent-reviewer', verdict: 'pass', rationale: 'Reviewed parameters, effect scope and independent negative-case evidence.', negative_cases: [{ name: 'invalid input contract', evidence_path: 'checks/negative-cases.json' }], ...overrides });
  const run = (name, number = 1, overrides = {}) => runProcedure(root, { procedure_id: definition.id, parameters: { number, output: `output/${name}.json` }, request_id: name, actor: 'worker', client: 'cli', mode: 'pilot', authorized_effects: { write_roots: ['output'], network: false, publication: false }, ...overrides });
  return { root, definition, review, run };
}

test('registers immutable candidates and discovers scripts and package commands without executing', t => {
  const { root, definition } = fixture(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { evil: 'touch this-must-not-run', test: 'node test.mjs' } }));
  assert.equal(resolveProcedure(root, definition.id).status, 'candidate');
  assert.equal(listProcedures(root).length, 1);
  const found = discoverProcedureScripts(root);
  assert.deepEqual(found.scripts.map(item => item.path), ['scripts/generate.mjs', 'scripts/verify.mjs']);
  assert.equal(found.package_commands.length, 2); assert.equal(existsSync(join(root, 'this-must-not-run')), false);
  assert.equal(registerProcedure(root, definition).contract_hash, resolveProcedure(root, definition.id).contract_hash);
  assert.throws(() => registerProcedure(root, { ...definition, title: 'Changed title' }), /immutable/);
  assert.throws(() => registerProcedure(root, { ...definition, status: 'eligible' }), /Unrecognized/);
});

test('requires independent review, real successful executions and current evidence before automatic reuse', async t => {
  const { root, definition, review, run } = fixture(t);
  await assert.rejects(() => run('candidate'), /not eligible/);
  assert.throws(() => review({ reviewer: 'implementer' }), /independent/);
  assert.equal(review().status, 'reviewed');
  assert.throws(() => qualifyProcedure(root, { procedure_id: definition.id, actor: 'coordinator' }), /three successful/);
  for (const [index, number] of [0, 1, 2].entries()) assert.equal((await run(`pilot-${index}`, number)).status, 'succeeded');
  assert.equal(qualifyProcedure(root, { procedure_id: definition.id, actor: 'coordinator' }).status, 'eligible');
  const auto = await run('automatic', 3, { mode: 'automatic' });
  assert.equal(auto.status, 'succeeded'); assert.match(auto.verification.stdout, /verified/);
  assert.equal(auto.outputs.length, 1); assert.equal(auto.outputs[0].sha256.length, 64);
  writeFileSync(join(root, 'output', 'pilot-0.json'), 'changed');
  assert.equal(resolveProcedure(root, definition.id).status, 'suspended');
});

test('fixture-only observations cannot qualify a procedure', async t => {
  const { root, definition, review, run } = fixture(t); review();
  for (let index = 0; index < 3; index++) assert.equal((await run(`fixture-${index}`, index, { observation: 'fixture' })).status, 'succeeded');
  assert.throws(() => qualifyProcedure(root, { procedure_id: definition.id, actor: 'coordinator' }), /fixture runs do not qualify/);
});

test('destination-only changes do not count as representative qualification variants', async t => {
  const { root, definition, review, run } = fixture(t); review();
  for (let index = 0; index < 3; index++) assert.equal((await run(`same-input-${index}`, 1)).status, 'succeeded');
  assert.throws(() => qualifyProcedure(root, { procedure_id: definition.id, actor: 'coordinator' }), /excluding destination-only/);
});

test('different input artifact paths count as substantive variants while destination paths do not', async t => {
  const { root, definition, review, run } = fixture(t);
  mkdirSync(join(root, 'inputs')); writeFileSync(join(root, 'inputs', 'one.json'), '{"number":1}'); writeFileSync(join(root, 'inputs', 'two.json'), '{"number":2}');
  writeFileSync(join(root, 'scripts', 'generate.mjs'), `import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';import {dirname} from 'node:path';let data='';for await(const part of process.stdin)data+=part;const input=JSON.parse(data);mkdirSync(dirname(input.outputs[0]),{recursive:true});writeFileSync(input.outputs[0],readFileSync(input.parameters.source));`);
  writeFileSync(join(root, 'scripts', 'verify.mjs'), `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';let data='';for await(const part of process.stdin)data+=part;const input=JSON.parse(data);assert.deepEqual(JSON.parse(readFileSync(input.outputs[0],'utf8')),JSON.parse(readFileSync(input.parameters.source,'utf8')));`);
  registerProcedure(root, { ...definition, version: '2.0.0', parameters: { source: { type: 'string', path: true }, output: { type: 'string', path: true } } });
  review({ version: '2.0.0' });
  for (const [index, source] of ['one', 'two', 'one'].entries()) {
    const result = await run(`source-${index}`, 1, { version: '2.0.0', parameters: { source: `inputs/${source}.json`, output: `output/source-${index}.json` } });
    assert.equal(result.status, 'succeeded');
  }
  assert.equal(qualifyProcedure(root, { procedure_id: definition.id, version: '2.0.0', actor: 'coordinator' }).status, 'eligible');
});

test('request keys are idempotent and payload conflicts preserve existing artifacts', async t => {
  const { root, review, run } = fixture(t); review();
  const first = await run('request-1', 1), repeated = await run('request-1', 1);
  assert.equal(first.status, 'succeeded'); assert.equal(first.replayed, false); assert.deepEqual(repeated, { ...first, replayed: true });
  assert.equal(Object.hasOwn(resolveProcedure(root, 'example-procedure').runs[0], 'replayed'), false);
  await assert.rejects(() => run('request-1', 2), /different payload/);
  await assert.rejects(() => run('request-2', 2, { parameters: { number: 2, output: 'output/request-1.json' } }), /already exists/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output', 'request-1.json'), 'utf8')), { number: 1 });
  writeFileSync(join(root, 'output', 'request-1.json'), 'changed');
  await assert.rejects(() => run('request-1', 1), /historical result cannot establish current success/);
});

test('rejects invalid parameter types, scopes, platforms, protected fields and unsafe paths before effects', async t => {
  const { root, definition, review, run } = fixture(t); review();
  await assert.rejects(() => run('bad', -1), /outside its bounds/);
  await assert.rejects(() => run('bad', 1, { parameters: { number: 1, output: '../outside.json' } }), /canonical/);
  await assert.rejects(() => run('bad', 1, { parameters: { number: 1, output: '.git/config' } }), /managed storage/);
  for (const managed of ['.neomind', '.taskforces', '.verythinker', '.VERYTHINKER'])
    await assert.rejects(() => run('bad', 1, { parameters: { number: 1, output: `${managed}/records/overwrite.md` } }), /managed storage/);
  await assert.rejects(() => run('bad', 1, { parameters: { number: 1, output: 'output/a.json', status: 'eligible' } }), /Unknown/);
  await assert.rejects(() => run('bad', 1, { authorized_effects: { write_roots: ['elsewhere'], network: false, publication: false } }), /authorization/);
  assert.throws(() => registerProcedure(root, { ...definition, id: 'unsafe', script: '../bad.mjs' }), /canonical/);
  assert.throws(() => registerProcedure(root, { ...definition, id: 'same-script', verification_script: definition.script }), /distinct/);
  assert.equal(existsSync(join(root, 'output')), false);
});

test('script and review evidence drift suspend procedures and new versions preserve history', async t => {
  const { root, definition, review } = fixture(t); review();
  writeFileSync(join(root, 'scripts', 'generate.mjs'), `${generator}\n// changed executable bytes`);
  assert.equal(resolveProcedure(root, definition.id).status, 'suspended');
  assert.throws(() => registerProcedure(root, definition), /immutable/);
  const revised = registerProcedure(root, { ...definition, version: '1.1.0' });
  assert.equal(revised.status, 'candidate'); assert.equal(resolveProcedure(root, definition.id).version, '1.1.0');
  assert.equal(listProcedures(root).length, 2);
});

test('declared dependency drift suspends a previously reviewed procedure', t => {
  const { root, definition, review } = fixture(t);
  writeFileSync(join(root, 'scripts', 'settings.json'), '{"format":1}');
  const manifest = registerProcedure(root, { ...definition, version: '1.1.0', dependencies: ['scripts/settings.json'] });
  assert.equal(manifest.dependency_sha256['scripts/settings.json'].length, 64);
  review({ version: '1.1.0' });
  writeFileSync(join(root, 'scripts', 'settings.json'), '{"format":2}');
  assert.match(resolveProcedure(root, definition.id).reason, /dependency hash drifted/);
});

test('failed generator or verifier suspends reuse and records actual process results', async t => {
  const { root, definition, review, run } = fixture(t);
  writeFileSync(join(root, 'scripts', 'verify.mjs'), 'console.error("expected deliberate failure");process.exit(4);');
  registerProcedure(root, { ...definition, version: '2.0.0' }); review({ version: '2.0.0' });
  const failure = await run('failure', 1, { version: '2.0.0' });
  assert.equal(failure.status, 'failed'); assert.equal(failure.generator.exit_code, 0); assert.equal(failure.verification.exit_code, 4);
  assert.equal(resolveProcedure(root, definition.id).status, 'suspended');
  await assert.rejects(() => run('again', 2), /suspended/);
});

test('timeouts and bounded output terminate the process and retain limited diagnostics', async t => {
  const { root, definition, review, run } = fixture(t);
  writeFileSync(join(root, 'scripts', 'generate.mjs'), 'setInterval(()=>{},1000);');
  registerProcedure(root, { ...definition, version: '2.0.0', timeout_ms: 100 }); review({ version: '2.0.0' });
  const timed = await run('timeout', 1, { version: '2.0.0' }); assert.equal(timed.status, 'failed'); assert.equal(timed.generator.timed_out, true);
  writeFileSync(join(root, 'scripts', 'generate.mjs'), 'process.stdout.write("x".repeat(100000));');
  registerProcedure(root, { ...definition, version: '3.0.0', max_output_bytes: 256 }); review({ version: '3.0.0' });
  const limited = await run('limit', 1, { version: '3.0.0' }); assert.equal(limited.status, 'failed'); assert.equal(limited.generator.output_limited, true); assert.ok(Buffer.byteLength(limited.generator.stdout) <= 256);
});

test('symlinked scripts or output ancestors are rejected even for links inside the project', async t => {
  const { root, definition, review, run } = fixture(t); review(); mkdirSync(join(root, 'real'));
  try { symlinkSync(join(root, 'real'), join(root, 'output'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit test symlinks.'); return; } throw error; }
  await assert.rejects(() => run('linked', 1), /symbolic links/);
  try { symlinkSync(join(root, 'scripts', 'generate.mjs'), join(root, 'scripts', 'link.mjs'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.throws(() => registerProcedure(root, { ...definition, id: 'linked-script', script: 'scripts/link.mjs' }), /symbolic links/);
});

test('an interrupted run with possible side effects is uncertain and never executed again', async t => {
  const { root, definition, review } = fixture(t);
  writeFileSync(join(root, 'scripts', 'generate.mjs'), `${generator}\nsetTimeout(()=>{},500);`);
  registerProcedure(root, { ...definition, version: '2.0.0' }); review({ version: '2.0.0' });
  const input = { procedure_id: definition.id, version: '2.0.0', parameters: { number: 1, output: 'output/interrupted.json' }, request_id: 'interrupted', actor: 'worker', client: 'cli', mode: 'pilot', authorized_effects: { write_roots: ['output'], network: false, publication: false } };
  const moduleUrl = pathToFileURL(resolve('dist/procedures.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runProcedure} from ${JSON.stringify(moduleUrl)};await runProcedure(${JSON.stringify(root)},${JSON.stringify(input)});`], { stdio: 'ignore', windowsHide: true });
  const start = Date.now();
  while (!existsSync(join(root, 'output', 'interrupted.json')) && Date.now() - start < 5000) await new Promise(done => setTimeout(done, 20));
  assert.equal(existsSync(join(root, 'output', 'interrupted.json')), true);
  child.kill('SIGKILL'); await new Promise(done => child.once('exit', done));
  const record = resolveProcedure(root, definition.id, '2.0.0'); assert.equal(record.status, 'suspended'); assert.equal(record.runs[0].status, 'uncertain');
  const retry = await runProcedure(root, input); assert.equal(retry.status, 'uncertain'); assert.equal(retry.id, record.runs[0].id);
  await assert.rejects(() => runProcedure(root, { ...input, request_id: 'second', parameters: { number: 2, output: 'output/second.json' } }), /suspended/);
  // The deliberately orphaned generator exits shortly after the interrupted parent.
  await new Promise(done => setTimeout(done, 600));
});

test('manual suspension is durable and independent review evidence remains integrity checked', t => {
  const { root, definition, review } = fixture(t); review();
  assert.equal(suspendProcedure(root, { procedure_id: definition.id, actor: 'owner', reason: 'User disabled this automation.' }).status, 'suspended');
  assert.equal(resolveProcedure(root, definition.id).reason, 'User disabled this automation.');
  writeFileSync(join(root, 'checks', 'negative-cases.json'), 'changed evidence');
  assert.match(resolveProcedure(root, definition.id).reason, /review evidence changed/);
});

test('a contract reviewer cannot later act as its execution worker', async t => {
  const { review, run } = fixture(t); review();
  await assert.rejects(() => run('reviewer-execution', 1, { actor: 'independent-reviewer' }), /reviewer cannot execute/);
});
