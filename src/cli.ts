#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initialize,
  readConfig,
  createRecord,
  updateRecord,
  getRecord,
  loadRecords,
  now,
  safePath,
  atomicWrite,
  withOperationLock,
} from './storage.js';
import { rebuildIndex, searchMemory } from './indexing.js';
import { registerProcedure, listProcedures, discoverProcedureScripts, resolveProcedure,
  reviewProcedure, runProcedure, qualifyProcedure, suspendProcedure } from './procedures.js';
import { prepareWork, rebuildProcedureIndex } from './procedure-reuse.js';
import { runPreparedWork } from './work-runtime.js';
import { openAssignment, assignmentContext, assignmentProgress, assignmentResult } from './assignment-runtime.js';
import {
  acceptTask,
  assignmentReport,
  archiveEvidence,
  contextPacket,
  reviewTask,
  reviewRecord,
  runCheck,
  inspectCheck,
  type InspectionInput,
  startTask,
  resumeTask,
  requestRepair,
  submitTask,
  traceRecord,
  verify,
} from './engineering.js';
import { installProject, updateProject, doctor, configureCodeGraph } from './installer.js';
import { installPack, listPacks, prepareContribution, suggestPacks } from './packs.js';
import { submitContribution } from './contributions.js';
import {
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  workflowStatus,
  finishWorkflow,
} from './manager.js';
import {
  startNative,
  nativeStatus,
  waitNative,
  interruptNative,
  resumeNative,
  shutdownNative,
} from './native.js';
import {
  prepareArchive,
  publishArchive,
  archiveStatus,
  restoreArchive,
  reassessArchive,
} from './archives.js';
import { dispatchKnowledgeCommand } from './knowledge-cli.js';
import { managedRun, type ManagedRunInput } from './managed.js';
import { migrateStorage } from './migration.js';
import { upgradeProject } from './upgrade.js';
import { workspaceWrite } from './workspace.js';
import { probeRouter } from './router-probe.js';
import { readAgentMap } from './agent-map.js';
import { reportAgentActivity } from './agent-activity.js';
import { observeNativeHook, readNativeHooks } from './agent-hooks.js';
import { readCodexRouting } from './codex-routing.js';
import { configureRea, reaStatus, probeRea } from './rea.js';
import { readPluginControlStatus, setPluginEnabled, installPlugin, probePlugin } from './plugin-control.js';
import { readPluginConnections, setPluginConnection, type PluginConnectionClient } from './plugin-connections.js';
import { homedir } from 'node:os';
import { cornellResearchSchema, compileCornellResearch, prepareCornellResearch, readCornellDestination,
  configureCornellDestination, prepareCornellExport, applyCornellExport } from './cornell-workflow.js';
import { prepareCornellPublication, publishCornellExport } from './cornell-publication.js';
import { validatePlatform } from './platform-validation.js';
import { modelControlStatus, setRoleModel, configureRouter, configureWorkForceModelCatalog, routerHealth, routerModels, routerProbe } from './model-control.js';
import { listUpstreams, discoverUpstreams, trackUpstream, checkUpstream, cloneUpstream, adoptUpstreamUpdate, readUpstreamInstructions, watchUpstreams } from './upstreams.js';
import { requestSubmit, requestStatus, requestControl, requestSetupStatus } from './workforce-requests.js';
import { checkpointLightweight, type LightweightCheckpoint } from './lightweight.js';
import { recordTypes, type Gate, type Platform, type Profile, type RecordType } from './types.js';

const help = `WorkForce engineering workspace (Node.js 24+)

Usage: workforce <command> [action] [id] [options]
  init --name NAME --profile basic|software|embedded --platforms codex,copilot [--local]
  update [--local]                  Refresh integration; preserve project edits
  doctor | validate               Inspect setup and installed capabilities
  request setup                   Read connection/tool readiness without calling a model
  request submit --requirement TEXT [--title TITLE]
  request status [REQUEST_ID]      Read saved products, checks and current action
  request pause|resume|cancel REQUEST_ID [--data-file FILE]
  request resume REQUEST_ID --question-id ISSUED_ID --answer TEXT
  mcp                             Start request_submit/status/control MCP for this project
  models status | models set --role ROLE --model ALIAS [--provider PROVIDER]
  models catalog --catalog-file FILE  Select and validate an existing custom endpoint catalog
  router configure --base-url URL [--api-key-env ENV] [--catalog-provider NAME]
  router health|models|probe [--model ALIAS]
  plugins status|enable|disable|install|probe PLUGIN
  plugins connections|connect|disconnect PLUGIN --client codex|copilot-vscode|copilot-cli [--mcp-file FILE]
  cornell compile|prepare|destination|configure|export-plan|export-apply|publish-plan|publish --data-file FILE
  procedure discover|list|show|register|review|run|qualify|suspend|index [ID] --data-file FILE
  work prepare|run --data-file FILE
  memory search QUERY | memory history | index rebuild
  upstream list|discover|track|check|clone|adopt|instructions|watch [ID] --data-file FILE
  migrate                         Move legacy storage to .workforce without rewriting history
  upgrade --to VERSION_OR_TAG_OR_LOCAL_TGZ
Options: --project DIRECTORY --json --help --version

Submit your complete requirement once. WorkForce manages agent sessions,
implementation, review and independent tests through the configured OpenCode engine.
VS Code must stay open with the exact workspace connected. A model alias does not
attest the upstream model. Setup and status commands never run inference.

Legacy workflow, record, task, assignment, check, review, archive, capability and
recipe commands remain available for historical projects and diagnostics; they are
not the ordinary WorkForce request protocol. See the installed documentation.
  check inspect ID --data JSON     Inspect a retained historical check contract
  workspace write --data JSON      Historical guarded write with explicit CAS
`;

async function main(): Promise<void> {
  const options: Record<string, { type: 'string' | 'boolean' }> = Object.fromEntries(
    [
      'project',
      'name',
      'profile',
      'platform',
      'platforms',
      'project-id',
      'title',
      'owner',
      'data',
      'data-file',
      'body',
      'type',
      'requires',
      'depends-on',
      'acceptance',
      'paths',
      'model',
      'confirmed-model',
      'invocation',
      'summary',
      'decision',
      'findings',
      'task',
      'gate',
      'max-chars',
      'event',
      'upstream',
      'report',
      'executable',
      'args',
      'url',
      'alias',
      'requirement',
      'request-id',
      'work-record',
      'destination',
      'disposition',
      'wait-ms',
      'to',
      'role',
      'provider',
      'effort',
      'base-url',
      'api-key-env',
      'catalog-provider',
      'catalog-file',
      'question-id',
      'answer',
      'client',
      'mcp-file',
    ].map((k) => [k, { type: 'string' }]),
  );
  for (const key of ['json', 'help', 'version', 'impact', 'generalization-review', 'public-safe', 'local'])
    options[key] = { type: 'boolean' };
  const parsed = parseArgs({ options, allowPositionals: true });
  const o = parsed.values;
  const [command, action, id] = parsed.positionals;
  if (o.version) {
    console.log(
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
    return;
  }
  if (o.help || !command) {
    console.log(help);
    return;
  }
  const root = resolve(String(o.project ?? process.cwd()));
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const data = (): Record<string, unknown> => {
    if (o.data && o['data-file']) throw new Error('Use --data or --data-file, not both.');
    const value = o['data-file'] ? JSON.parse(readFileSync(resolve(String(o['data-file'])), 'utf8')) : o.data ? JSON.parse(String(o.data)) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('--data must be a JSON object.');
    return value;
  };
  const body = () => (o.body ? readFileSync(resolve(String(o.body)), 'utf8') : undefined);
  const needed = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
    return value;
  };
  const list = (value: unknown): string[] =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  let result: unknown;
  const specialized = await dispatchKnowledgeCommand(
    root,
    command,
    action,
    parsed.positionals.slice(2),
    data(),
    { upstream: o.upstream as string | undefined },
  );
  if (specialized.handled) {
    console.log(json(specialized.result));
    return;
  }
  switch (command) {
    case 'request': {
      const input = data();
      const answer = o.answer ?? input.answer;
      if (action === 'setup') result = requestSetupStatus(root);
      else if (action === 'status') result = requestStatus(root, id);
      else if (action === 'submit') result = await requestSubmit(root, {
        requirement: needed(o.requirement ?? input.requirement, '--requirement'),
        ...(o.title ?? input.title ? { title: needed(o.title ?? input.title, '--title') } : {}),
      });
      else if (action === 'pause' || action === 'resume' || action === 'cancel') result = await requestControl(root, {
        request_id: needed(id, 'REQUEST_ID'), action,
        ...(answer !== undefined ? { answer: needed(answer, 'answer'), question_id: needed(o['question-id'] ?? input.question_id, '--question-id') } : {}),
      });
      else throw new Error('Use request setup|submit|status|pause|resume|cancel.');
      break;
    }
    case 'procedure': {
      const input = data();
      if (action === 'list') result = listProcedures(root);
      else if (action === 'discover') result = discoverProcedureScripts(root);
      else if (action === 'show' || action === 'resolve') result = resolveProcedure(root, needed(id, 'PROCEDURE_ID'), input.version as string | undefined);
      else if (action === 'index') result = rebuildProcedureIndex(root);
      else if (action === 'register') result = registerProcedure(root, input as Parameters<typeof registerProcedure>[1]);
      else if (action === 'review') result = reviewProcedure(root, { ...input, procedure_id: id ?? input.procedure_id } as Parameters<typeof reviewProcedure>[1]);
      else if (action === 'run') result = await runProcedure(root, { ...input, procedure_id: id ?? input.procedure_id } as Parameters<typeof runProcedure>[1]);
      else if (action === 'qualify') result = qualifyProcedure(root, { ...input, procedure_id: id ?? input.procedure_id } as Parameters<typeof qualifyProcedure>[1]);
      else if (action === 'suspend') result = suspendProcedure(root, { ...input, procedure_id: id ?? input.procedure_id } as Parameters<typeof suspendProcedure>[1]);
      else throw new Error('Use procedure discover|list|show|register|review|run|qualify|suspend|index.');
      break;
    }
    case 'work': {
      if (action === 'prepare') result = prepareWork(root, data() as unknown as Parameters<typeof prepareWork>[1]);
      else if (action === 'run') result = await runPreparedWork(root, data() as unknown as Parameters<typeof runPreparedWork>[1]);
      else throw new Error('Use work prepare|run --data-file FILE.');
      break;
    }
    case 'assignment': {
      const input = data();
      if (action === 'open') result = openAssignment(root, input as unknown as Parameters<typeof openAssignment>[1]);
      else if (action === 'context') result = assignmentContext(root, input.credential as Parameters<typeof assignmentContext>[1]);
      else if (action === 'progress') result = assignmentProgress(root, input.credential as Parameters<typeof assignmentProgress>[1], input.progress as Parameters<typeof assignmentProgress>[2]);
      else if (action === 'result') result = assignmentResult(root, input.credential as Parameters<typeof assignmentResult>[1], input.result as Parameters<typeof assignmentResult>[2]);
      else if (action === 'report') {
        if (!Array.isArray(input.target_ids) || input.target_ids.some((target) => typeof target !== 'string') ||
            (input.role !== undefined && typeof input.role !== 'string') ||
            (input.covered_invocation_ids !== undefined && (!Array.isArray(input.covered_invocation_ids) ||
              input.covered_invocation_ids.some((target) => typeof target !== 'string'))))
          throw new Error('Assignment report needs string target_ids, optional role and optional covered_invocation_ids.');
        result = assignmentReport(root, {
          target_ids: input.target_ids as string[], invocation_id: needed(input.invocation_id, 'Assignment invocation_id'),
          role: input.role as string | undefined, covered_invocation_ids: input.covered_invocation_ids as string[] | undefined,
          body: needed(body(), '--body'),
        });
      } else throw new Error('Use assignment open|context|progress|result|report.');
      break;
    }
    case 'plugins': {
      const targets = { codex: resolve(root, '.codex/config.toml'),
        copilotCli: resolve(homedir(), '.copilot/mcp-config.json'),
        ...(o['mcp-file'] && o.client === 'copilot-vscode' ? { copilotVscode: resolve(String(o['mcp-file'])) } : {}),
        ...(o['mcp-file'] && o.client === 'copilot-cli' ? { copilotCli: resolve(String(o['mcp-file'])) } : {}) };
      if (action === 'status') result = readPluginControlStatus(root);
      else if (action === 'connections') result = readPluginConnections(root, targets);
      else if (action === 'connect' || action === 'disconnect') {
        const client = needed(o.client, '--client');
        if (!['codex', 'copilot-vscode', 'copilot-cli'].includes(client)) throw new Error('Unknown plug-in client.');
        if (client === 'copilot-vscode' && !o['mcp-file']) throw new Error('Select the intended VS Code profile with --mcp-file.');
        result = setPluginConnection(root, { plugin: needed(id, 'PLUGIN'), client: client as PluginConnectionClient, connected: action === 'connect' }, targets);
      } else if (action === 'enable' || action === 'disable') {
        const status = setPluginEnabled(root, needed(id, 'PLUGIN'), action === 'enable');
        result = { status, integration: updateProject(root), client_reload_required: true,
          note: 'External MCP connections have separate connect/disconnect controls.' };
      } else if (action === 'install' || action === 'probe') {
        result = { status: await (action === 'install' ? installPlugin : probePlugin)(root, needed(id, 'PLUGIN')),
          integration: updateProject(root) };
      } else throw new Error('Use plugins status|enable|disable|install|probe|connections|connect|disconnect.');
      break;
    }
    case 'validate': result = validatePlatform(root); break;
    case 'codex': {
      if (action === 'status') result = readCodexRouting(root);
      else if (action === 'configure') {
        const mode = data().mode;
        if (mode !== 'inherit' && mode !== '9router') throw new Error('Codex mode must be inherit or 9router.');
        const routing = withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
          if (modelControlStatus(root).active_invocations.length) throw new Error('Stop active signed invocations before changing Codex routing.');
          const selected = readCodexRouting(root, mode), config = readConfig(root);
          atomicWrite(safePath(root, '.workforce/config.json'), JSON.stringify({ ...config, codex_routing: mode }, null, 2) + '\n');
          return selected;
        }));
        result = { routing, integration: updateProject(root) };
      } else throw new Error('Use codex status|configure.');
      break;
    }
    case 'rea':
      if (action === 'status') result = reaStatus(root);
      else if (action === 'probe') result = await probeRea(root);
      else if (action === 'configure') {
        const configured = await configureRea(root, data() as never);
        result = { configured, integration: updateProject(root) };
      } else throw new Error('Use rea status|configure|probe.');
      break;
    case 'cornell':
      if (action === 'compile') result = compileCornellResearch(root, cornellResearchSchema.parse(data()));
      else if (action === 'prepare') result = prepareCornellResearch(root, cornellResearchSchema.parse(data()));
      else if (action === 'destination') result = readCornellDestination(root);
      else if (action === 'configure') result = configureCornellDestination(root, data());
      else if (action === 'export-plan') result = prepareCornellExport(root, data() as never);
      else if (action === 'export-apply') result = applyCornellExport(root, data() as never);
      else if (action === 'publish-plan') result = prepareCornellPublication(root, data() as never);
      else if (action === 'publish') result = publishCornellExport(root, data() as never);
      else throw new Error('Use cornell compile|prepare|destination|configure|export-plan|export-apply|publish-plan|publish.');
      break;
    case 'activity':
      if (action === 'report') result = reportAgentActivity(root, data() as never);
      else if (action === 'hooks') result = readNativeHooks(root);
      else if (action === 'hook') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error('Hook payload exceeds 64 KiB.'); chunks.push(Buffer.from(chunk)); }
        result = observeNativeHook(root, String(o.provider) as 'copilot' | 'codex', JSON.parse(Buffer.concat(chunks).toString('utf8')), o.event as string | undefined);
      } else throw new Error('Use activity report|hook|hooks.');
      break;
    case 'map':
      result = readAgentMap(root);
      break;
    case 'models':
      if (action === 'status') result = modelControlStatus(root);
      else if (action === 'catalog') result = configureWorkForceModelCatalog(root, { path: needed(o['catalog-file'] ?? data().path, '--catalog-file') });
      else if (action === 'set') {
        const selection = setRoleModel(root, {
          role: needed(o.role, '--role'), model: needed(o.model, '--model'),
          ...(o.provider ? { provider: String(o.provider) } : {}),
          ...(o.effort ? { effort: String(o.effort) as 'high' | 'medium' | 'low' } : {}),
        });
        // Preserve a successful policy write if a user-edited adapter needs review.
        try { result = { ...selection, installation: updateProject(root) }; }
        catch (error) { result = { ...selection, adapter_error: error instanceof Error ? error.message : String(error) }; }
      }
      else throw new Error('Use models status|catalog|set.');
      break;
    case 'upstream': {
      const input = data();
      if (action === 'watch') {
        const controller = new AbortController(), stop = () => controller.abort();
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        try {
          for await (const event of watchUpstreams(root, {
            signal: controller.signal, ...(o['wait-ms'] ? { interval_ms: Number(o['wait-ms']) } : {}),
          })) console.log(json(event));
        } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
        return;
      }
      if (action === 'list') result = listUpstreams(root);
      else if (action === 'discover') result = await discoverUpstreams(root, input as never);
      else if (action === 'track') result = await trackUpstream(root, input as never);
      else if (action === 'check') result = await checkUpstream(root, needed(id, 'Upstream ID'));
      else if (action === 'clone') result = await cloneUpstream(root, needed(id, 'Upstream ID'));
      else if (action === 'adopt') result = await adoptUpstreamUpdate(root, needed(id, 'Upstream ID'), input as never);
      else if (action === 'instructions') result = readUpstreamInstructions(root, needed(id, 'Upstream ID'));
      else throw new Error('Use upstream list|discover|track|check|clone|adopt|instructions.');
      break;
    }
    case 'init': {
      initialize(root, {
        name: String(o.name ?? 'WorkForce project'),
        profile: String(o.profile ?? 'basic') as Profile,
        platforms: list(o.platforms ?? 'copilot') as Platform[],
        ...(o['project-id'] ? { project_id: String(o['project-id']) } : {}),
        ...(o.local ? { copilot_integration: 'local' as const } : {}),
      });
      const installation = installProject(root, o.local ? { copilot_integration: 'local' } : {});
      result = {
        config: readConfig(root),
        installation,
        pack: installPack(root, 'engineering-basics'),
      };
      break;
    }
    case 'doctor':
      result = doctor(root);
      break;
    case 'upgrade':
      if (parsed.positionals.length !== 1) throw new Error('Use upgrade --to VERSION_OR_TAG_OR_LOCAL_TGZ.');
      result = upgradeProject(root, needed(o.to, '--to'));
      break;
    case 'workflow': {
      if (action === 'begin' || action === 'run') {
        if (!existsSync(safePath(root, '.workforce/config.json'))) {
          initialize(root, {
            name: String(o.name ?? 'WorkForce project'),
            profile: String(o.profile ?? 'basic') as Profile,
            platforms: [String(o.platform ?? 'copilot') as Platform],
          });
          installProject(root);
          installPack(root, 'engineering-basics');
        }
        const input = data();
        const specification = {
          ...input,
          ...(Array.isArray(input.requirements)
            ? { requirements: input.requirements as string[] }
            : input.workflow_id
              ? {}
              : {
                  requirement: needed(
                    o.requirement ?? input.requirement,
                    '--requirement or --data requirement(s)',
                  ),
                }),
          ...(o.title ? { title: String(o.title) } : {}),
          ...(o['request-id'] ? { request_id: String(o['request-id']) } : {}),
          ...(typeof input.change_type === 'string'
            ? { change_type: input.change_type as never }
            : {}),
        };
        result =
          action === 'begin'
            ? beginWorkflow(root, specification as never)
            : await managedRun(root, specification as ManagedRunInput);
        if (action === 'run') {
          const managed = result as Awaited<ReturnType<typeof managedRun>>;
          let invocation = managed.invocation;
          while (invocation && ['starting', 'running'].includes(invocation.state))
            invocation = await waitNative(root, invocation.id, 60000);
          if (invocation)
            result = {
              ...managed,
              invocation,
              workflow: workflowStatus(root, invocation.workflow_id ?? undefined),
            };
          if (invocation?.state === 'waiting-native-permission') await shutdownNative();
        }
      } else if (action === 'status') result = workflowStatus(root, id);
      else if (action === 'checkpoint')
        result = checkpointLightweight(root, { ...data(), workflow_id: needed(id, 'Workflow ID') } as LightweightCheckpoint);
      else if (action === 'discuss')
        result = discussWorkflow(root, needed(id, 'Workflow ID'), data() as never);
      else if (action === 'decide')
        result = decideWorkflow(root, needed(id, 'Workflow ID'), data() as never);
      else if (action === 'finish')
        result = finishWorkflow(root, needed(id, 'Workflow ID'), data());
      else throw new Error('Unknown workflow action.');
      break;
    }
    case 'codegraph':
      if (action !== 'enable')
        throw new Error(
          'Use codegraph enable with a conformance report and exact server launch arguments.',
        );
      result = {
        configuration: configureCodeGraph(
          root,
          needed(o.report, '--report'),
          needed(o.executable, '--executable'),
          JSON.parse(needed(o.args, '--args')),
        ),
        installation: updateProject(root),
      };
      break;
    case 'update':
      result = updateProject(root, o.local ? { copilot_integration: 'local' } : {});
      break;
    case 'record': {
      if (action === 'list')
        result = loadRecords(root).filter((r) => !o.type || r.meta.type === o.type);
      else if (action === 'show') result = getRecord(root, needed(id, 'Record ID'));
      else if (action === 'create') {
        if (!recordTypes.includes(id as RecordType)) throw new Error('Unknown record type.');
        const d = data();
        const links = d.links;
        delete d.links;
        result = createRecord(root, {
          type: id as RecordType,
          title: needed(o.title, '--title'),
          owner: String(o.owner ?? 'manager'),
          body: body(),
          data: d,
          links: Array.isArray(links) ? links : [],
        });
      } else if (action === 'update') {
        const d = data();
        const { links, status, title, owner, ...fields } = d;
        result = updateRecord(
          root,
          needed(id, 'Record ID'),
          {
            data: fields,
            ...(Array.isArray(links) ? { links } : {}),
            ...(typeof title === 'string' ? { title } : {}),
            ...(typeof owner === 'string' ? { owner } : {}),
            ...(typeof status === 'string' ? { status: status as never } : {}),
          },
          body(),
        );
      } else throw new Error('Unknown record action.');
      break;
    }
    case 'task': {
      if (action === 'create') {
        const reqs = list(o.requires);
        const dependencies = list(o['depends-on']);
        const d = data();
        result = createRecord(root, {
          type: 'task',
          title: needed(o.title, '--title'),
          owner: String(o.owner ?? 'developer'),
          body: body(),
          links: [
            ...reqs.map((target) => ({ type: 'satisfies' as const, target })),
            ...dependencies.map((target) => ({ type: 'depends-on' as const, target })),
          ],
          data: {
            ...d,
            requirements: reqs,
            dependencies,
            acceptance_criteria: o.acceptance
              ? JSON.parse(String(o.acceptance))
              : (d.acceptance_criteria ?? []),
            allowed_paths: o.paths ? JSON.parse(String(o.paths)) : (d.allowed_paths ?? []),
          },
        });
      } else if (action === 'list')
        result = loadRecords(root).filter((r) => r.meta.type === 'task');
      else if (action === 'show') result = getRecord(root, needed(id, 'Task ID'));
      else if (action === 'start')
        result = startTask(
          root,
          needed(id, 'Task ID'),
          o.model as string | undefined,
          o['confirmed-model'] as string | undefined,
          o.invocation as string | undefined,
        );
      else if (action === 'resume')
        result = resumeTask(
          root,
          needed(id, 'Task ID'),
          o.model as string | undefined,
          o['confirmed-model'] as string | undefined,
          o.invocation as string | undefined,
        );
      else if (action === 'repair')
        result = requestRepair(root, needed(id, 'Task ID'), needed(o.summary, '--summary'));
      else if (action === 'submit')
        result = submitTask(
          root,
          needed(id, 'Task ID'),
          needed(o.summary, '--summary'),
          o['work-record'] ? readFileSync(resolve(String(o['work-record'])), 'utf8') : undefined,
        );
      else if (action === 'accept') result = acceptTask(root, needed(id, 'Task ID'));
      else if (action === 'block')
        result = updateRecord(root, needed(id, 'Task ID'), {
          status: 'blocked',
          data: { blocked_reason: needed(o.summary, '--summary') },
        });
      else throw new Error('Unknown task action.');
      break;
    }
    case 'review': {
      const target = needed(action, 'Target ID');
      const owner = needed(o.owner, '--owner');
      const decision = needed(o.decision, '--decision');
      if (!['pass', 'fail'].includes(decision))
        throw new Error('Review decision must be pass or fail.');
      const findings = o.findings ? JSON.parse(String(o.findings)) : [];
      if (!Array.isArray(findings) || findings.some((f) => typeof f !== 'string'))
        throw new Error('--findings must be a string array.');
      const record = getRecord(root, target);
      result =
        record.meta.type === 'task'
          ? reviewTask(
              root,
              target,
              owner,
              decision as 'pass' | 'fail',
              findings,
              o.invocation as string | undefined,
            )
          : reviewRecord(
              root,
              target,
              owner,
              decision as 'pass' | 'fail',
              findings,
              o.invocation as string | undefined,
              o['generalization-review'] === true,
              o['public-safe'] === true,
            );
      break;
    }
    case 'check':
      if (action === 'archive') result = archiveEvidence(root, needed(id, 'Evidence ID'));
      else if (action === 'inspect') {
        const input = data();
        result = inspectCheck(
          root,
          needed(id, 'Check ID'),
          needed(o.task, '--task'),
          { observations: input.observations, limitations: input.limitations } as InspectionInput,
          needed(o.invocation ?? input.invocation_id, '--invocation'),
        );
      } else if (action === 'run')
        result = runCheck(
          root,
          needed(id, 'Check ID'),
          needed(o.task, '--task'),
          o.invocation as string | undefined,
        );
      else
        throw new Error(
          'Use check run|inspect CHECK_ID --task TASK_ID or check archive EVIDENCE_ID.',
        );
      break;
    case 'context':
      result = contextPacket(
        root,
        needed(action, 'Task ID'),
        o['max-chars'] ? Number(o['max-chars']) : undefined,
      );
      break;
    case 'trace':
      result = traceRecord(root, needed(action, 'Record ID'), o.impact === true);
      break;
    case 'verify': {
      const gate = String(o.gate ?? 'accepted') as Gate;
      if (!['ready', 'design-ready', 'verified', 'accepted'].includes(gate))
        throw new Error('Invalid verification gate.');
      const report = verify(root, action, gate);
      result = report;
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'memory':
      if (action === 'search') result = searchMemory(root, parsed.positionals.slice(2).join(' '));
      else if (action === 'history')
        result = loadRecords(root).filter(
          (r) =>
            r.meta.type === 'knowledge' &&
            r.meta.data.kind === 'work-record' &&
            (!o.owner || r.meta.owner === o.owner),
        );
      else if (action === 'contribute')
        result = o.upstream
          ? submitContribution(root, needed(id, 'Knowledge ID'), String(o.upstream))
          : prepareContribution(root, needed(id, 'Knowledge ID'));
      else throw new Error('Unknown memory action.');
      break;
    case 'pack':
      if (action === 'list') result = listPacks(root);
      else if (action === 'install')
        result = installPack(
          root,
          needed(id, 'Pack name or directory'),
          o.decision as string | undefined,
        );
      else if (action === 'suggest') result = suggestPacks(root, parsed.positionals.slice(2));
      else if (action === 'show') {
        const list = listPacks(root) as {
          installed: { id: string }[];
          available: { id: string }[];
        };
        result = [...list.installed, ...list.available].filter((p) => p.id === id);
      } else throw new Error('Unknown pack action.');
      break;
    case 'index':
      if (action !== 'rebuild') throw new Error('Use index rebuild.');
      result = rebuildIndex(root);
      break;
    case 'hook': {
      const config = readConfig(root);
      const event = String(o.event ?? 'session-start');
      const platform = String(o.platform ?? 'codex');
      if (!['codex', 'claude', 'copilot'].includes(platform))
        throw new Error('Unknown hook platform.');
      const message = `WorkForce ${config.profile} project ${config.project_id}. Use WF.PM to submit the complete requirement once through workforce/request_submit or the WorkForce Request tool. WorkForce owns agent sessions, implementation, independent review/testing and recovery. Follow saved work through request_status; do not implement the same accepted request separately or use legacy assignment credentials. Project instructions live under .workforce. This hook is advisory.`;
      console.log(
        json(
          event !== 'session-start'
            ? {}
            : platform === 'copilot'
              ? { additionalContext: message }
              : {
                  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
                },
        ),
      );
      return;
    }
    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      await startMcp(root, { invocation_id: o.invocation as string | undefined });
      return;
    }
    case 'router': {
      if (action === 'configure') {
        result = configureRouter(root, { base_url: needed(o['base-url'], '--base-url'),
          ...(o['api-key-env'] ? { api_key_env: String(o['api-key-env']) } : {}),
          ...(o['catalog-provider'] ? { catalog_provider: String(o['catalog-provider']) } : {}),
        });
        break;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        if (action === 'health') result = await routerHealth(root, controller.signal);
        else if (action === 'models') result = await routerModels(root, controller.signal);
        else if (action === 'probe' && o.url) result = await probeRouter(needed(o.url, 'Router URL'), needed(o.alias, 'Router alias'), controller.signal);
        else if (action === 'probe') result = await routerProbe(root, needed(o.model, '--model'), controller.signal);
        else throw new Error('Use router configure|health|models|probe.');
      } finally {
        clearTimeout(timer);
      }
      break;
    }
    case 'native': {
      const input = data();
      if (action === 'status') result = nativeStatus(root, id);
      else if (action === 'wait')
        result = await waitNative(root, needed(id, 'Invocation ID'), Number(o['wait-ms'] ?? 60000));
      else if (action === 'interrupt')
        result = await interruptNative(root, needed(id, 'Invocation ID'));
      else if (action === 'resume')
        result = await resumeNative(root, needed(id, 'Invocation ID'), input);
      else if (action === 'run') {
        let invocation = await startNative(root, input as never);
        while (['starting', 'running'].includes(invocation.state))
          invocation = await waitNative(root, invocation.id, 60000);
        result = invocation;
        if (invocation.state === 'waiting-native-permission') await shutdownNative();
      } else throw new Error('Use native run|status|wait|interrupt|resume.');
      break;
    }
    case 'workspace': {
      if (action !== 'write') throw new Error('Use workspace write --data JSON.');
      const input = data();
      if (typeof input.content !== 'string') throw new Error('workspace content must be a string.');
      if (
        !Object.hasOwn(input, 'expected_hash') ||
        (input.expected_hash !== null && typeof input.expected_hash !== 'string')
      )
        throw new Error(
          'workspace expected_hash must be a SHA-256 string, or null for a new file.',
        );
      result = workspaceWrite(root, {
        task_id: needed(input.task_id, 'workspace task_id'),
        workflow_id: needed(input.workflow_id, 'workspace workflow_id'),
        invocation_id: needed(input.invocation_id ?? o.invocation, 'workspace invocation_id'),
        path: needed(input.path, 'workspace path'),
        content: input.content,
        expected_hash: input.expected_hash,
        ...(input.operation_id !== undefined
          ? { operation_id: needed(input.operation_id, 'workspace operation_id') }
          : {}),
      });
      break;
    }
    case 'archive':
      if (action === 'prepare')
        result = prepareArchive(root, needed(id, 'Workflow ID'), {
          disposition: (o.disposition ?? 'accepted') as never,
        });
      else if (action === 'publish') result = publishArchive(root, needed(id, 'Snapshot ID'));
      else if (action === 'status') result = archiveStatus(root, id);
      else if (action === 'restore')
        result = restoreArchive(
          root,
          needed(id, 'Snapshot ID'),
          needed(o.destination, '--destination'),
        );
      else if (action === 'reassess')
        result = reassessArchive(root, needed(id, 'Workflow ID'), data() as never);
      else throw new Error('Use archive prepare|publish|status|restore|reassess.');
      break;
    case 'migrate':
      result = migrateStorage(root, { activate_workforce: true });
      break;
    default:
      throw new Error(`Unknown command: ${command}. Use --help.`);
  }
  console.log(json(result));
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
