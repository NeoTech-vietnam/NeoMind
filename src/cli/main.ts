import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { compileFlow } from '../domain/compiler.js';
import { flowJsonSchema, profileJsonSchema } from '../domain/schema.js';
import { defaultProject, templates } from '../domain/templates.js';
import { FlowLibrary } from '../storage/flow-library.js';
import { migrateProjectDir } from '../storage/project-dir.js';
import { readProject } from '../runtime/project.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { installShutdown } from './shutdown.js';
import { parseRunCommand, runUsage } from './run-command.js';

async function executableAvailable(name: string): Promise<boolean> {
  // Windows has no execute bit; a command resolves through PATHEXT (codex.cmd, codex.exe, ...).
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      try { await access(path.join(dir, name + extension), constants.X_OK); return true; } catch { /* continue */ }
    }
  }
  return false;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'run') {
    const command = parseRunCommand(args);
    if (!command) { console.error(runUsage); return 2; }
    const { RunManager } = await import('../runtime/run-manager.js');
    const manager = await RunManager.open(await (await import('node:fs/promises')).realpath(command.project));
    // A signal pauses runs owned by this process and confirms their workers stopped before exit.
    const uninstall = installShutdown(async () => {
      for (const state of await manager.close()) console.error(`${state.runId}: ${state.phase} (${state.reason}). Tiếp tục: neomind run resume <project> ${state.runId}`);
    });
    const settle = async (runId: string) => console.log(JSON.stringify(await manager.settle(runId), null, 2));
    try {
      switch (command.kind) {
        case 'list': console.log(JSON.stringify(await manager.list(), null, 2)); return 0;
        case 'show': console.log(JSON.stringify(await manager.get(command.runId), null, 2)); return 0;
        case 'preview': console.log(JSON.stringify(await manager.preview(command.flowId), null, 2)); return 0;
        case 'start': {
          const preview = await manager.preview(command.flowId);
          console.log(JSON.stringify({ configuration: preview.snapshot.configuration, workspace: 'isolated', dirtyPaths: preview.dirtyPaths }, null, 2));
          if (preview.dirtyImport.changes.length && !command.importDirty) console.error(`Checkout có ${preview.dirtyImport.changes.length} thay đổi chưa commit; run dùng HEAD. Mang vào run: thêm --import-dirty ${preview.dirtyImport.baselineHash}`);
          const run = await manager.create(command.flowId, command.task, undefined, {}, preview.configurationHash, {}, command.importDirty);
          await settle(run.runId); return 0;
        }
        case 'approve': await manager.action(command.runId, 'approve', 'cli', command.planHash); await settle(command.runId); return 0;
        case 'changes': await manager.revisePlan(command.runId, command.feedback, command.planHash); await settle(command.runId); return 0;
        case 'retry-git': await manager.action(command.runId, 'retry_git', 'cli'); await settle(command.runId); return 0;
        case 'include-imported': await manager.action(command.runId, 'include_imported', 'cli'); await settle(command.runId); return 0;
        case 'apply': await manager.action(command.runId, 'apply', 'cli'); console.log(JSON.stringify((await manager.get(command.runId)).checkoutApply ?? {}, null, 2)); return 0;
        case 'clean': {
          if (command.runId) { const run = await manager.clean(command.runId, command.force); console.log(JSON.stringify(run.workspaceCleanup ?? {}, null, 2)); return 0; }
          const results = await manager.cleanFinished(command.force);
          console.log(JSON.stringify(results, null, 2)); return results.some(item => item.status === 'kept') ? 1 : 0;
        }
        case 'extend-time': await manager.extendTime(command.runId, command.seconds); await settle(command.runId); return 0;
        case 'resume': case 'pause': case 'cancel': await manager.action(command.runId, command.kind, 'cli'); await settle(command.runId); return 0;
      }
    } finally { uninstall(); await manager.close(); }
  }
  if (args[0] === 'editor' && (args.length === 2 || (args.length === 4 && args[2] === '--port'))) {
    const port = args[3] === undefined ? 0 : Number(args[3]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const { startEditorServer } = await import('../ui-server/server.js');
    const server = await startEditorServer(args[1]!, port);
    installShutdown(() => server.close());
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
  if (args[0] === 'project' && args[1] === 'migrate' && args.length === 3) {
    // Move a legacy .neomind/ to neomind/, which Obsidian and other tools that hide dot-folders can see.
    console.log(JSON.stringify(await migrateProjectDir(path.resolve(args[2]!)), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'canvas' && (args[2] === 'export' || args[2] === 'import') && (args.length === 5 || args.length === 6)) {
    // Default board: <library>/<flow>/flow.canvas, opened by Nimbalyst and Obsidian.
    const library = new FlowLibrary(args[3]!), file = args[5] ? path.resolve(args[5]) : undefined;
    // The flows directory sits at <project>/neomind/flows; the project config resolves which agent runs each step.
    if (args[2] === 'export') { console.log(JSON.stringify(await library.exportCanvas(args[4]!, file, await readProject(path.dirname(path.dirname(path.resolve(args[3]!))))), null, 2)); return 0; }
    const result = await library.importCanvas(args[4]!, file);
    console.log(JSON.stringify({ saved: true, revision: result.revision, report: result.report }, null, 2)); return 0;
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
  console.error('Usage: neomind editor <project-directory> [--port N] | schema <flow|profile> | template <fast|dev|parallel|research> | flow validate <flow.json> [policy.json] | flow|profile list|create|draft|publish|rename|archive|restore|clone|delete|export ... | flow canvas export|import <flows-dir> <flow-id> [file.canvas] | project migrate <project> | memory configure|project-search|search|get ... | doctor capabilities');
  return 2;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
});
