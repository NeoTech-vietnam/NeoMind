import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { compileFlow } from '../domain/compiler.js';
import { flowJsonSchema, profileJsonSchema } from '../domain/schema.js';
import { defaultProject, templates } from '../domain/templates.js';
import { FlowLibrary } from '../storage/flow-library.js';
import { ProfileLibrary } from '../storage/profile-library.js';

async function executableAvailable(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { await access(path.join(dir, name), constants.X_OK); return true; } catch { /* continue */ }
  }
  return false;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'editor' && (args.length === 2 || (args.length === 4 && args[2] === '--port'))) {
    const port = args[3] === undefined ? 0 : Number(args[3]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const { startEditorServer } = await import('../ui-server/server.js');
    const server = await startEditorServer(args[1]!, port);
    console.log(`NeoMind Flow Studio: ${server.url}`);
    return 0;
  }
  if (args[0] === 'schema' && args[1] === 'flow' && args.length === 2) {
    console.log(JSON.stringify(flowJsonSchema(), null, 2)); return 0;
  }
  if (args[0] === 'schema' && args[1] === 'profile' && args.length === 2) {
    console.log(JSON.stringify(profileJsonSchema(), null, 2)); return 0;
  }
  if (args[0] === 'template' && args.length === 2) {
    const name = args[1] as keyof typeof templates;
    if (!Object.hasOwn(templates, name)) { console.error('Unknown template; use fast, dev, or research.'); return 2; }
    console.log(JSON.stringify(templates[name], null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'validate' && (args.length === 3 || args.length === 4)) {
    const document: unknown = JSON.parse(await readFile(args[2]!, 'utf8'));
    const policy: unknown = args[3] ? JSON.parse(await readFile(args[3], 'utf8')) : defaultProject.policy;
    const result = compileFlow(document, policy);
    console.log(JSON.stringify(result.ok ? { valid: true, order: result.order } : { valid: false, diagnostics: result.diagnostics }, null, 2));
    return result.ok ? 0 : 1;
  }
  if (args[0] === 'flow' && args[1] === 'list' && args.length === 3) {
    console.log(JSON.stringify(await new FlowLibrary(args[2]!).list(), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'create' && args.length === 5) {
    console.log(JSON.stringify(await new FlowLibrary(args[2]!).create(args[3]!, args[4]!), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'draft' && args.length === 5) {
    await new FlowLibrary(args[2]!).saveDraft(args[3]!, JSON.parse(await readFile(args[4]!, 'utf8')) as unknown);
    console.log(JSON.stringify({ saved: true })); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'publish' && (args.length === 4 || args.length === 5)) {
    const policy: unknown = args[4] ? JSON.parse(await readFile(args[4], 'utf8')) : defaultProject.policy;
    // Library publishes only after the policy has been parsed and the graph validated.
    const { projectPolicySchema } = await import('../domain/schema.js');
    console.log(JSON.stringify(await new FlowLibrary(args[2]!).publish(args[3]!, projectPolicySchema.parse(policy)), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'rename' && args.length === 5) {
    await new FlowLibrary(args[2]!).rename(args[3]!, args[4]!); console.log(JSON.stringify({ renamed: true })); return 0;
  }
  if (args[0] === 'flow' && ['archive', 'restore'].includes(args[1] ?? '') && args.length === 4) {
    const archived = args[1] === 'archive';
    await new FlowLibrary(args[2]!).setArchived(args[3]!, archived); console.log(JSON.stringify({ archived })); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'clone' && args.length === 6) {
    console.log(JSON.stringify(await new FlowLibrary(args[2]!).cloneDraft(args[3]!, args[4]!, args[5]!), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'delete' && args.length === 6 && args[4] === '--confirm-name') {
    await new FlowLibrary(args[2]!).deletePermanently(args[3]!, args[5]!); console.log(JSON.stringify({ deleted: true })); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'export' && args.length === 5) {
    console.log(JSON.stringify(await new FlowLibrary(args[2]!).readVersion(args[3]!, Number(args[4])), null, 2)); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'list' && args.length === 3) {
    console.log(JSON.stringify(await new ProfileLibrary(args[2]!).list(), null, 2)); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'create' && args.length === 5) {
    console.log(JSON.stringify(await new ProfileLibrary(args[2]!).create(args[3]!, args[4]!), null, 2)); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'draft' && args.length === 5) {
    await new ProfileLibrary(args[2]!).saveDraft(args[3]!, JSON.parse(await readFile(args[4]!, 'utf8')) as unknown);
    console.log(JSON.stringify({ saved: true })); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'publish' && args.length === 4) {
    console.log(JSON.stringify(await new ProfileLibrary(args[2]!).publish(args[3]!), null, 2)); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'rename' && args.length === 5) {
    await new ProfileLibrary(args[2]!).rename(args[3]!, args[4]!); console.log(JSON.stringify({ renamed: true })); return 0;
  }
  if (args[0] === 'profile' && ['archive', 'restore'].includes(args[1] ?? '') && args.length === 4) {
    const archived = args[1] === 'archive';
    await new ProfileLibrary(args[2]!).setArchived(args[3]!, archived); console.log(JSON.stringify({ archived })); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'clone' && args.length === 6) {
    console.log(JSON.stringify(await new ProfileLibrary(args[2]!).cloneDraft(args[3]!, args[4]!, args[5]!), null, 2)); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'delete' && args.length === 6 && args[4] === '--confirm-name') {
    await new ProfileLibrary(args[2]!).deletePermanently(args[3]!, args[5]!); console.log(JSON.stringify({ deleted: true })); return 0;
  }
  if (args[0] === 'profile' && args[1] === 'export' && args.length === 5) {
    console.log(JSON.stringify(await new ProfileLibrary(args[2]!).readVersion(args[3]!, Number(args[4])), null, 2)); return 0;
  }
  if (args[0] === 'memory' && args[1] === 'configure' && args.length === 5) {
    const { ProjectMemoryRegistry } = await import('../memory/registry.js');
    const registry = new ProjectMemoryRegistry(args[3]!);
    try { registry.set(args[2]!, args[4]!, null); console.log(JSON.stringify({ configured: true, root: registry.resolve(args[2]!) })); }
    finally { registry.close(); }
    return 0;
  }
  if (args[0] === 'memory' && args[1] === 'project-search' && (args.length === 4 || args.length === 5)) {
    const { ProjectMemoryRegistry } = await import('../memory/registry.js');
    const { MemoryStore } = await import('../memory/store.js');
    const registry = new ProjectMemoryRegistry(args[3]!);
    try {
      const root = registry.resolve(args[2]!);
      if (!root) throw new Error('Project memory root is not configured');
      const store = new MemoryStore(root, args[3]!);
      try { console.log(JSON.stringify(store.search(args[4] ? { query: args[4] } : {}), null, 2)); }
      finally { store.close(); }
    } finally { registry.close(); }
    return 0;
  }
  if (args[0] === 'memory' && args[1] === 'search' && (args.length === 4 || args.length === 5)) {
    const { MemoryStore } = await import('../memory/store.js');
    const store = new MemoryStore(args[2]!, args[3]!);
    try { console.log(JSON.stringify(store.search(args[4] ? { query: args[4] } : {}), null, 2)); }
    finally { store.close(); }
    return 0;
  }
  if (args[0] === 'memory' && args[1] === 'get' && args.length === 6) {
    const { MemoryStore } = await import('../memory/store.js');
    const type = args[4];
    if (type !== 'context' && type !== 'decision' && type !== 'lesson') throw new Error('Unknown memory type');
    const store = new MemoryStore(args[2]!, args[3]!);
    try { const record = store.read(type, args[5]!); if (!record) { console.error('Memory record not found'); return 1; } console.log(JSON.stringify(record, null, 2)); }
    finally { store.close(); }
    return 0;
  }
  if (args[0] === 'doctor' && args[1] === 'capabilities' && args.length === 2) {
    const executables = Object.fromEntries(await Promise.all(['codex', 'claude', 'opencode'].map(async name => [name, await executableAvailable(name)])));
    console.log(JSON.stringify({ simulated: false, executables, auth: 'unknown', inference: 'not_tested', delegationEnforcement: 'unknown' }, null, 2));
    return 0;
  }
  console.error('Usage: neomind editor <project-directory> [--port N] | schema <flow|profile> | template <fast|dev|research> | flow validate <flow.json> [policy.json] | flow|profile list|create|draft|publish|rename|archive|restore|clone|delete|export ... | memory configure|project-search|search|get ... | doctor capabilities');
  return 2;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
});
