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
import { cornellResearchSchema, compileCornellResearch, prepareCornellResearch, readCornellDestination,
  configureCornellDestination, prepareCornellExport, applyCornellExport } from './cornell-workflow.js';
import { prepareCornellPublication, publishCornellExport } from './cornell-publication.js';
import { validatePlatform } from './platform-validation.js';
import { modelControlStatus, setRoleModel, configureRouter, routerHealth, routerModels, routerProbe } from './model-control.js';
import { listUpstreams, discoverUpstreams, trackUpstream, checkUpstream, cloneUpstream, adoptUpstreamUpdate, readUpstreamInstructions, watchUpstreams } from './upstreams.js';
import { checkpointLightweight, type LightweightCheckpoint } from './lightweight.js';
import { recordTypes, type Gate, type Platform, type Profile, type RecordType } from './types.js';

const help = `NeoMind engineering workflow (Node.js 24+)

Usage: neomind <command> [action] [id] [options]
  init --name NAME --profile basic|software|embedded --platforms codex,claude,copilot [--local]
  doctor | update [--local] (persist separately ignorable Copilot integration)
  validate (read-only integration, activity, upstream and reusable-procedure inspection)
  upgrade --to VERSION_OR_TAG_OR_LOCAL_TGZ (uninstall old package, install new, refresh integration)
  workflow begin --requirement TEXT [--title TITLE] [--request-id ID]
  workflow run --requirement TEXT | --data '{"requirements":["..."],"execution_mode":"copilot-native"}'
  workflow checkpoint WORKFLOW_ID --data JSON (unsigned lightweight progress/results)
  workflow discuss|decide|finish WORKFLOW_ID --data JSON | workflow status [WORKFLOW_ID]
  assignment report --data JSON --body FILE (target_ids, invocation_id, role; seven-section report)
  record create TYPE --title TITLE --owner ROLE --data JSON [--body FILE]
  record update ID --data JSON [--body FILE] | record show ID | record list [--type TYPE]
  task create --title TITLE --owner ROLE --requires IDS --acceptance JSON --paths JSON
  task list | task show ID | task start ID [--model MODEL] [--confirmed-model MODEL]
  task submit ID --summary TEXT [--work-record FILE] | task accept ID | task block ID --summary TEXT
  task resume ID [--model MODEL] | task repair ID --summary FEEDBACK
  review ID --owner reviewer --decision pass|fail [--findings JSON] [--invocation ID]
  check run ID --task TASK_ID
  check inspect ID --task TASK_ID --invocation ID --data JSON
  check archive EVIDENCE_ID (preserve verification logs for review and sharing)
  context TASK_ID [--max-chars NUMBER]
  trace ID [--impact] | verify [TASK_ID] [--gate ready|design-ready|verified|accepted]
  memory search QUERY | memory history [--owner ROLE] | memory contribute KNOWLEDGE_ID
  memory contribute KNOWLEDGE_ID --upstream OWNER/REPO (explicit draft PR submission)
  pack list | pack install NAME_OR_PATH [--decision CHANGE_ID] | pack show ID | pack suggest TERMS
  index rebuild
  mcp
  native run --data JSON | native status [ID] | native wait|interrupt|resume ID
  router probe --url URL --alias MODEL (diagnostic only; no native receipt)
  map (bounded saved agent activity and communication snapshot)
  activity report --data JSON (unsigned native dispatch/progress/completion; never signed proof)
  activity hooks | activity hook --provider codex|copilot --event EVENT (hook JSON on stdin)
  codex status | codex configure --data '{"mode":"inherit|9router"}' (regenerate integration)
  rea status|configure|probe --data JSON (explicit pinned optional MCP integration)
  cornell compile|prepare --data-file FILE (validated research input and reusable recipe)
  cornell destination|configure|export-plan|export-apply|publish-plan|publish --data JSON
  models status | models set --role ROLE --model MODEL [--provider PROVIDER] [--effort low|medium|high]
  router configure --base-url URL [--api-key-env ENV] [--catalog-provider NAME]
  router health|models|probe [--model MODEL] (configured 9router; diagnostics only)
  upstream list|discover|track|check|clone|adopt|instructions [ID] --data JSON
  upstream watch [--wait-ms INTERVAL] (persistent checks, default 15 minutes; Ctrl+C stops)
  archive prepare WORKFLOW_ID | archive publish|status SNAPSHOT_ID | archive restore ID --destination DIRECTORY | archive reassess WORKFLOW_ID --data JSON
  migrate (move .taskforces or .verythinker storage to .neomind; never merges or overwrites)
  note create --data JSON | note revise ID --data JSON | note validate ID
  recipe list|resolve ID|prepare --data JSON|run ID|revise ID --data JSON
  capability describe ROLE|resolve --data JSON|invoke --data JSON
  workspace write --data JSON (actual Developer invocation and reviewed task scope required)
  codegraph enable --report FILE --executable FILE --args JSON
Options: --project DIRECTORY --json --help --version

Create a check record with command (executable/arguments), baseline_paths, method,
and a verifies link. Check execution collects real receipts and logs.
Use record creation --data '{...}' for additional task packet fields.
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
    case 'validate': result = validatePlatform(root); break;
    case 'codex': {
      if (action === 'status') result = readCodexRouting(root);
      else if (action === 'configure') {
        const mode = data().mode;
        if (mode !== 'inherit' && mode !== '9router') throw new Error('Codex mode must be inherit or 9router.');
        const routing = withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
          if (modelControlStatus(root).active_invocations.length) throw new Error('Stop active signed invocations before changing Codex routing.');
          const selected = readCodexRouting(root, mode), config = readConfig(root);
          atomicWrite(safePath(root, '.neomind/config.json'), JSON.stringify({ ...config, codex_routing: mode }, null, 2) + '\n');
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
      else throw new Error('Use models status|set.');
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
        name: String(o.name ?? 'NeoMind project'),
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
        if (!existsSync(safePath(root, '.neomind/config.json'))) {
          initialize(root, {
            name: String(o.name ?? 'NeoMind project'),
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
    case 'assignment': {
      if (action !== 'report') throw new Error('Unknown assignment action.');
      const input = data();
      if (!Array.isArray(input.target_ids) || input.target_ids.some((id) => typeof id !== 'string') ||
          (input.role !== undefined && typeof input.role !== 'string') ||
          (input.covered_invocation_ids !== undefined && (!Array.isArray(input.covered_invocation_ids) ||
            input.covered_invocation_ids.some((id) => typeof id !== 'string'))))
        throw new Error('Assignment report needs string target_ids, optional role and optional covered_invocation_ids.');
      result = assignmentReport(root, {
        target_ids: input.target_ids as string[],
        invocation_id: needed(input.invocation_id, 'Assignment invocation_id'),
        role: input.role as string | undefined,
        covered_invocation_ids: input.covered_invocation_ids as string[] | undefined,
        body: needed(body(), '--body'),
      });
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
      const message = `NeoMind ${config.profile} project ${config.project_id}. For a requirement, act as neomind-manager and read the installed guides/copilot-native.md for native mode or guides/manager.md for strict mode, under .neomind. Resume saved workflows with manager_status. Own internal discussion, documentation, review, acceptance, and configured draft PRs; ask only for missing product intent or a genuine blocker. This hook is advisory.`;
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
      result = migrateStorage(root);
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
