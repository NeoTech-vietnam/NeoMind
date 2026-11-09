// Build a self-contained, machine-independent Git-installable Agent Plugin.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pluginVersion } from './agent-plugin/version.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalOutput = join(repository, 'agent-plugin');
const templateRoot = join(repository, 'resources/agent-plugin-url');
const schemaRoot = 'https://agent-plugins.org/schemas/1.0.0/';
const pluginRepository = 'https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin';

function normalPath(path) { return path.split(sep).join('/'); }
function readText(path) { return readFileSync(path, 'utf8').replaceAll('\r\n', '\n'); }

function assertOutputPath(out, paths) {
  if (!isAbsolute(out)) throw new Error('--out must be an absolute directory.');
  const safeOut = resolve(out);
  if (safeOut === repository || safeOut === dirname(repository)) throw new Error('Choose the agent-plugin directory or a separate output directory.');
  if (existsSync(safeOut)) {
    const info = lstatSync(safeOut);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Output must be an ordinary directory.');
    const names = readdirSync(safeOut);
    if (names.some(name => name !== 'README.md')) {
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(safeOut, 'plugin.json'), 'utf8')); } catch { /* Refuse unrelated output. */ }
      if (manifest?.name !== 'workforce' || manifest.$schema !== `${schemaRoot}plugin.schema.json`)
        throw new Error('Existing output is not a WorkForce Agent Plugin; its files were preserved.');
    }
  }
  for (const path of paths) {
    let candidate = join(safeOut, path);
    while (candidate !== safeOut) {
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error('Generated output cannot pass through symbolic links.');
      candidate = dirname(candidate);
    }
  }
  return safeOut;
}

function dependencyNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    const absolute = resolve(repository, input);
    if (!normalPath(absolute).includes('/node_modules/')) continue;
    let directory = dirname(absolute);
    while (directory !== dirname(directory)) {
      const metadata = join(directory, 'package.json');
      if (existsSync(metadata)) {
        const pkg = JSON.parse(readFileSync(metadata, 'utf8'));
        if (pkg.name && pkg.version) {
          const key = `${pkg.name}@${pkg.version}`;
          if (!packages.has(key)) {
            const license = readdirSync(directory).find(name => /^(?:licen[cs]e|copying)(?:\..+)?$/i.test(name));
            if (!license) throw new Error(`Bundled dependency ${key} has no license text.`);
            packages.set(key, readText(join(directory, license)).trim());
          }
          break;
        }
      }
      directory = dirname(directory);
    }
  }
  return '# Third-party notices\n\nThe executable bundle includes the following dependencies. Their full license texts follow.\n\n' +
    [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, text]) => `## ${name}\n\n${text}\n`).join('\n');
}

export async function buildAgentPlugin({ out = canonicalOutput, check = false } = {}) {
  if (!isAbsolute(out)) throw new Error('--out must be an absolute directory.');
  const { build } = await import('esbuild');
  const [{ workforceNativeClientInstructions }, { nativeLocalProfile, nativeLocalWorkerProfile, nativeRoles, nativeSpecialists }] = await Promise.all([
    import('../dist/adapters.js'), import('../dist/native-local-contract.js'),
  ]);
  const bundled = await build({ absWorkingDir: repository, entryPoints: ['scripts/agent-plugin/entry.mjs'],
    outfile: 'workforce-plugin.mjs', bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', target: 'node24',
    // jsonc-parser's UMD main uses indirect require; bundle its static ESM module instead.
    mainFields: ['module', 'main'],
    legalComments: 'inline', banner: { js: 'import { createRequire as __wfCreateRequire } from "node:module"; const require = __wfCreateRequire(import.meta.url);' } });
  const files = new Map();
  const json = value => JSON.stringify(value, null, 2) + '\n';
  files.set('plugin.json', json({ $schema: `${schemaRoot}plugin.schema.json`, name: 'workforce', version: pluginVersion,
    description: 'WorkForce agents, skills and workspace-aware MCP for Copilot Local.', author: { name: 'NeoTech Vietnam' },
    homepage: pluginRepository, repository: pluginRepository, license: 'MIT' }));
  files.set('mcp.json', json({ $schema: `${schemaRoot}mcp.schema.json`, mcpServers: {
    workforce: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/workforce-plugin.mjs'] },
  } }));
  files.set('bin/workforce-plugin.mjs', bundled.outputFiles[0].text);
  files.set('.gitattributes', '* text eol=lf\n');
  files.set('LICENSE', readText(join(repository, 'LICENSE')));
  files.set('THIRD_PARTY_NOTICES.md', dependencyNotices(bundled.metafile.inputs));
  const connectionInstructions = readText(join(templateRoot, 'connection-instructions.md')).trim();
  const instructions = workforceNativeClientInstructions('copilot').replaceAll('\r\n', '\n') + '\n' + connectionInstructions + '\n';
  for (const role of nativeRoles) {
    files.set(`com.github.copilot/agents/workforce-${role.slice(3).toLowerCase()}.agent.md`, nativeLocalProfile(role));
  }
  for (const role of nativeSpecialists)
    files.set(`com.github.copilot/agents/workforce-worker-${role.slice(3).toLowerCase()}.agent.md`, nativeLocalWorkerProfile(role));
  files.set('skills/workforce-request/SKILL.md', `---\nname: workforce-request\ndescription: Submit an engineering request to WorkForce, inspect its saved deliverables, or control the same request from Copilot Local.\n---\n\n${instructions}`);
  for (const skill of ['workforce-plugin-status', 'workforce-plugin-connection'])
    files.set(`skills/${skill}/SKILL.md`, readText(join(templateRoot, 'skills', skill, 'SKILL.md')));

  const target = assertOutputPath(out, files.keys());
  if (check) {
    const changed = [...files].flatMap(([path, expected]) => {
      const full = join(target, path);
      try { return readFileSync(full).equals(Buffer.from(expected)) ? [] : [path]; } catch { return [path]; }
    });
    if (changed.length) throw new Error(`Agent Plugin output is missing or stale: ${changed.join(', ')}. Run npm run agent-plugin:build.`);
  } else {
    for (const [path, content] of files) {
      const full = join(target, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  return { plugin: 'workforce', version: pluginVersion, path: target, checked: check,
    files: [...files.keys()], agents: nativeRoles, skills: 3, mcp_servers: ['workforce'],
    runtime_bundled: false, npm_install_required_in_distribution: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'boolean', default: false } }, strict: true });
  console.log(JSON.stringify(await buildAgentPlugin(values), null, 2));
}
