import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { compileFlow } from '../domain/compiler.js';
import { renderPlanMarkdown } from '../domain/plan-markdown.js';
import { hashJson } from '../domain/resolve.js';
import { flowJsonSchema, profileJsonSchema } from '../domain/schema.js';
import { defaultProject, templates } from '../domain/templates.js';
import { FlowLibrary } from '../storage/flow-library.js';
import { migrateProjectDir } from '../storage/project-dir.js';
import { readProject } from '../runtime/project.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { installShutdown } from './shutdown.js';
import { parseRunCommand, readRunCommandInput, runUsage } from './run-command.js';
import { flowBlocks, draftFlow, getFlow, validateFlow, flowDiff, publishFlow, assess } from '../runtime/flow-authoring.js';
import { skillCatalog, skillStatus } from '../storage/skill-catalog.js';
import { draftProfile, getProfile, getProfileVersion, migrateProfile, profileSkillStatus, profileUsage, publishProfile } from '../runtime/profile-authoring.js';

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

/** `neomind skill get|create|update|delete|usage|repin …`: the skill library, as the editor's Skills screen (human author). */
async function skillCommand(args: string[]): Promise<unknown> {
  const library = await import('../storage/skill-library.js'), root = args[1] ? path.resolve(args[1]) : '', id = args[2];
  const source = args.includes('--source') && args[args.indexOf('--source') + 1] === 'claude' ? 'claude' as const : 'neomind' as const;
  const file = (skill: string) => source === 'claude' ? `.claude/skills/${skill}/SKILL.md` : `neomind/skills/${skill}/SKILL.md`;
  if (args[0] === 'list' && args.length === 2) return { skills: await library.skillLibrary(root) };
  if (args[0] === 'get' && id) return library.getSkill(root, id, source);
  if (args[0] === 'usage' && id) return library.skillUsage(root, file(id));
  if (args[0] === 'repin' && id && args.length === 3) return library.repinSkill(root, file(id));
  if (args[0] === 'create' && args.length === 3) return library.createSkill(root, JSON.parse(await readFile(args[2]!, 'utf8')) as Parameters<typeof library.createSkill>[1]);
  if (args[0] === 'update' && id && args.length === 4) return library.updateSkill(root, id, JSON.parse(await readFile(args[3]!, 'utf8')) as Parameters<typeof library.updateSkill>[2]);
  if (args[0] === 'delete' && id && (args.length === 3 || (args.length === 4 && args[3] === '--force'))) {
    try { return await library.deleteSkill(root, id, { force: args[3] === '--force' }); }
    catch (error) { if (error instanceof library.SkillInUse) return { deleted: false, error: error.message, usage: error.usage }; throw error; }
  }
  return undefined;
}
/** `neomind profile templates | from-template <project> <id> <name> <template> | remove <project> <id>`. */
async function profileTemplateCommand(args: string[]): Promise<unknown> {
  const { profileTemplates } = await import('../domain/profile-templates.js'), authoring = await import('../runtime/profile-authoring.js');
  if (args[0] === 'templates' && args.length === 1) return { templates: Object.entries(profileTemplates).map(([id, template]) => ({ id, ...template })) };
  if (args[0] === 'from-template' && args.length === 5) return authoring.createProfileFromTemplate(path.resolve(args[1]!), { profileId: args[2]!, name: args[3]!, template: args[4] as keyof typeof profileTemplates });
  if (args[0] === 'remove' && args.length === 3) return authoring.deleteProfile(path.resolve(args[1]!), args[2]!);
  return undefined;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'mcp' && args.length === 2) {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp(path.resolve(args[1]!));
    return 0;
  }
  if (args[0] === 'rules' && args.length === 2) { const { readProjectRules } = await import('../runtime/project.js'); console.log(JSON.stringify(await readProjectRules(path.resolve(args[1]!)) ?? { rules: [], warnings: [], file: 'neomind/rules.md not found' }, null, 2)); return 0; }
  if (args[0] === 'skills' && args.length === 2) { console.log(JSON.stringify({ skills: await skillCatalog(path.resolve(args[1]!)) }, null, 2)); return 0; }
  if (args[0] === 'skills' && args[1] === 'status' && args.length === 4) { const { z } = await import('zod'), { skillReferenceSchema } = await import('../domain/schema.js'); const refs = z.array(skillReferenceSchema).parse(JSON.parse(await readFile(args[3]!, 'utf8'))); console.log(JSON.stringify({ skills: await skillStatus(path.resolve(args[2]!), refs) }, null, 2)); return 0; }
  if (args[0] === 'skill') { const result = await skillCommand(args.slice(1)); if (result !== undefined) { console.log(JSON.stringify(result, null, 2)); return 0; } }
  if (args[0] === 'profile' && ['templates', 'from-template', 'remove'].includes(args[1] ?? '')) { const result = await profileTemplateCommand(args.slice(1)); if (result !== undefined) { console.log(JSON.stringify(result, null, 2)); return 0; } }
  if (args[0] === 'profile' && args[1] === 'get' && args.length === 4) { console.log(JSON.stringify(await getProfile(path.resolve(args[2]!), args[3]!), null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'version' && args.length === 5) { console.log(JSON.stringify({ version: await getProfileVersion(path.resolve(args[2]!), args[3]!, Number(args[4])) }, null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'skills-status' && args.length === 4) { console.log(JSON.stringify({ skills: await profileSkillStatus(path.resolve(args[2]!), args[3]!) }, null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'usage' && args.length === 4) { console.log(JSON.stringify({ flows: await profileUsage(path.resolve(args[2]!), args[3]!) }, null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'migrate' && args.length === 6) { const { z } = await import('zod'); const selected = z.array(z.strictObject({ flowId: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) })).parse(JSON.parse(await readFile(args[5]!, 'utf8'))); console.log(JSON.stringify(await migrateProfile(path.resolve(args[2]!), args[3]!, Number(args[4]), selected), null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'author-draft' && args.length === 4) { const { z } = await import('zod'); const input = z.strictObject({ profileId: z.string().min(1), name: z.string().min(1).optional(), from: z.strictObject({ profileId: z.string().min(1) }).optional(), draft: z.json().optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(JSON.parse(await readFile(args[3]!, 'utf8'))); console.log(JSON.stringify(await draftProfile(path.resolve(args[2]!), input), null, 2)); return 0; }
  if (args[0] === 'profile' && args[1] === 'author-publish' && args.length === 6) { console.log(JSON.stringify(await publishProfile(path.resolve(args[2]!), args[3]!, { author: { kind: 'ai', reason: args[5]! }, expectedRevision: args[4]! }), null, 2)); return 0; }
  if (args[0] === 'run') {
    const parsed = parseRunCommand(args);
    // Input files are read before any state opens, so an empty or oversized file is a usage error like any other.
    const command = parsed && await readRunCommandInput(parsed);
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
        case 'stats': {
          const { runStats, statsCsv } = await import('../runtime/run-stats.js');
          const stats = await runStats(command.project, manager, command.flowId ? { flowId: command.flowId } : {});
          if (command.format === 'json') console.log(JSON.stringify(stats, null, 2));
          else if (command.format === 'csv') process.stdout.write(statsCsv(stats));
          else {
            const percent = (value: number | null) => value === null ? '-' : `${Math.round(value * 100)}%`, round = (value: number | null) => value === null ? '-' : String(Math.round(value));
            console.log(['flow | runs | delivered | tokens (median) | active s (median) | repair rounds | first-pass review', ...stats.byFlow.map(item =>
              `${item.key} | ${item.runs} | ${percent(item.deliveryRate)} | ${round(item.tokens.median)} | ${round(item.activeSeconds.median)} | ${item.repairRounds?.toFixed(1) ?? '-'} | ${percent(item.firstPassReviewRate)}`)].join('\n'));
          }
          return 0;
        }
        case 'show': console.log(JSON.stringify(await manager.get(command.runId), null, 2)); return 0;
        case 'plan': {
          const run = await manager.get(command.runId), proposal = run.plans.at(-1);
          if (!proposal) { console.error(`${command.runId}: chưa có plan`); return 1; }
          const planHash = hashJson(proposal.plan);
          const markdown = renderPlanMarkdown(proposal.plan, { runId: command.runId, phase: run.runtimeState?.phase, planHash,
            approved: run.approvals.some(item => item.approval.decision === 'approved' && item.approval.planHash === planHash) });
          if (command.out) { await writeFile(command.out, markdown, 'utf8'); console.log(JSON.stringify({ written: path.resolve(command.out), planHash }, null, 2)); }
          else process.stdout.write(markdown);
          return 0;
        }
        case 'preview': console.log(JSON.stringify(await manager.preview(command.flowId, undefined, {}, {}, command.workspaceMode), null, 2)); return 0;
        case 'start': {
          const preview = await manager.preview(command.flowId, undefined, {}, {}, command.workspaceMode);
          console.log(JSON.stringify({ configuration: preview.snapshot.configuration, workspace: preview.snapshot.configuration.flow.definition.workspacePolicy, dirtyPaths: preview.dirtyPaths }, null, 2));
          if (preview.dirtyImport.changes.length && !command.importDirty) console.error(`Checkout có ${preview.dirtyImport.changes.length} thay đổi chưa commit; run dùng HEAD. Mang vào run: thêm --import-dirty ${preview.dirtyImport.baselineHash}`);
          const run = await manager.create(command.flowId, command.task, undefined, {}, preview.configurationHash, {}, command.importDirty, command.workspaceMode);
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
        case 'extend-time': await manager.extendTime(command.runId, command.seconds, command.tokens ?? 0); await settle(command.runId); return 0;
        case 'resume': case 'pause': case 'cancel': await manager.action(command.runId, command.kind, 'cli'); await settle(command.runId); return 0;
      }
    } finally { uninstall(); await manager.close(); }
  }
  if (args[0] === 'program' && ((args[1] === 'list' && args.length === 3) || (['create', 'status', 'next'].includes(args[1] ?? '') && args.length === 4) || (args[1] === 'deliver' && args.length === 6))) {
    const programs = await import('../runtime/programs.js'), { RunManager } = await import('../runtime/run-manager.js');
    const project = await (await import('node:fs/promises')).realpath(args[2]!);
    // The program file is read before any state opens, so a malformed spec fails without touching runs.
    const spec = args[1] === 'create' ? JSON.parse(await readFile(args[3]!, 'utf8')) as unknown : undefined;
    if (args[1] === 'create') { console.log(JSON.stringify({ program: await programs.createProgram(project, spec) }, null, 2)); return 0; }
    const manager = await RunManager.open(project);
    const uninstall = installShutdown(async () => {
      for (const state of await manager.close()) console.error(`${state.runId}: ${state.phase} (${state.reason}). Tiếp tục: neomind run resume <project> ${state.runId}`);
    });
    try {
      if (args[1] === 'list') console.log(JSON.stringify(await programs.listPrograms(project, manager), null, 2));
      else if (args[1] === 'status') console.log(JSON.stringify(await programs.programStatus(project, manager, args[3]!), null, 2));
      else if (args[1] === 'deliver') console.log(JSON.stringify(await programs.markPhaseDelivered(project, manager, args[3]!, args[4]!, args[5]!), null, 2));
      else {
        const result = await programs.programNext(project, manager, args[3]!);
        console.log(JSON.stringify(result.started ? { ...result, run: await manager.settle(result.runId) } : result, null, 2));
        return result.started ? 0 : 1;
      }
      return 0;
    } finally { uninstall(); await manager.close(); }
  }
  if (args[0] === 'assess' && ((args.length === 3 && args[2] !== '--task-file') || (args.length === 4 && args[2] === '--task-file'))) {
    const task = args[2] === '--task-file' ? await readFile(args[3]!, 'utf8') : args[2]!;
    if (!task.trim() || task.length > 10000) throw new Error('Task must contain 1–10000 characters');
    console.log(JSON.stringify(await assess(path.resolve(args[1]!), task), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'blocks' && args.length === 3) {
    console.log(JSON.stringify(await flowBlocks(path.resolve(args[2]!)), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'get' && args.length === 4) {
    console.log(JSON.stringify(await getFlow(path.resolve(args[2]!), args[3]!), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'diff' && args.length === 4) {
    console.log(JSON.stringify(await flowDiff(path.resolve(args[2]!), args[3]!), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'author-draft' && args.length === 4) {
    const { z } = await import('zod');
    const input = z.strictObject({ flowId: z.string().min(1), name: z.string().min(1).optional(), from: z.union([z.strictObject({ template: z.enum(['fast', 'dev', 'parallel', 'research']) }), z.strictObject({ flowId: z.string().min(1) })]).optional(), draft: z.json().optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(JSON.parse(await readFile(args[3]!, 'utf8')));
    console.log(JSON.stringify(await draftFlow(path.resolve(args[2]!), input), null, 2)); return 0;
  }
  if (args[0] === 'flow' && args[1] === 'author-validate' && args.length === 4) {
    const result = await validateFlow(path.resolve(args[2]!), args[3]!); console.log(JSON.stringify(result, null, 2)); return result.valid ? 0 : 1;
  }
  if (args[0] === 'flow' && args[1] === 'author-publish' && args.length === 6) {
    console.log(JSON.stringify(await publishFlow(path.resolve(args[2]!), args[3]!, { author: { kind: 'ai', reason: args[5]! }, expectedRevision: args[4]! }), null, 2)); return 0;
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
  console.error('Usage: neomind mcp <project> | rules <project> | program create <project> <program.json> | program list <project> | program status|next <project> <programId> | program deliver <project> <programId> <phaseId> <note> | skills <project> | skills status <project> <refs.json> | profile get|skills-status|usage <project> <id> | profile version <project> <id> <n> | profile migrate <project> <id> <n> <selection.json> | profile author-draft <project> <input.json> | profile author-publish <project> <id> <revision> <reason> | assess <project> --task-file <file>|<task> | flow blocks <project> | flow get|diff|author-validate <project> <id> | flow author-draft <project> <input.json> | flow author-publish <project> <id> <revision> <reason> | editor <project-directory> [--port N] | schema <flow|profile> | template <fast|dev|parallel|research> | flow validate <flow.json> [policy.json] | flow|profile list|create|draft|publish|rename|archive|restore|clone|delete|export ... | flow canvas export|import <flows-dir> <flow-id> [file.canvas] | project migrate <project> | memory configure|project-search|search|get ... | doctor capabilities');
  console.error('       neomind skill list <project> | skill get|usage <project> <id> [--source claude] | skill repin <project> <id> | skill create <project> <input.json> | skill update <project> <id> <input.json> | skill delete <project> <id> [--force] | profile templates | profile from-template <project> <id> <name> <template> | profile remove <project> <id>');
  return 2;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
});
