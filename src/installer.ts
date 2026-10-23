import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureLocalGitExclusions } from './local-git-excludes.js';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { ensureAutomationPolicy, nativeAutomationPolicy, readAutomationPolicy, type AutomationPolicy } from './manager.js';
import { ensureArchivePolicy, readArchivePolicy, type ArchivePolicy } from './archives.js';
import {
  ensureRoutingPolicy,
  readRoutingPolicy,
  readInvocation,
  routingProblems,
  strongRoles,
  workerRoles,
  type RoutingPolicy,
} from './routing.js';
import { ensureToolPolicy, toolObservations, roleCapabilities } from './tools.js';
import { loadRecords, updateRecord, withOperationLock, safePath as storagePath, resolveManagedRoot } from './storage.js';
import { strings, nativeWorkflowRecord } from './engineering.js';
import {
  adapterOutputs,
  codeGraphProvider,
  resourcesDirectory,
  platforms,
  loadCodeGraphConfiguration,
  validateCodeGraphReport,
  validateCodeGraphCommand,
  type CodeGraphConfiguration,
  type Platform,
  type AdapterConfig,
  type ManagedOutput,
} from './adapters.js';

export type { Platform } from './adapters.js';
export type { CodeGraphConfiguration } from './adapters.js';
interface ManifestEntry {
  path: string;
  kind: ManagedOutput['kind'];
  key?: string;
  hash: string;
  version: string;
}
interface Manifest {
  schema_version: 1;
  version: string;
  files: Record<string, ManifestEntry>;
}
export interface InstallReport {
  schema_version: 1;
  version: string;
  root: string;
  platforms: Platform[];
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: { path: string; candidate: string; reason: string }[];
  warnings: string[];
}
export interface InstallOptions {
  platforms?: Platform[];
  profile?: string;
  name?: string;
  force?: boolean;
  copilot_integration?: 'local';
}
type Status = 'supported' | 'configured' | 'restricted' | 'unverified';
export interface DoctorReport {
  schema_version: 1;
  root: string;
  version: string;
  runtime: { node: string; supported: boolean };
  platforms: {
    platform: Platform;
    client: { executable: string | null; version: string | null };
    capabilities: { capability: string; status: Status; detail: string }[];
    requested_models: AdapterConfig['models'];
  }[];
  codegraph: typeof codeGraphProvider | CodeGraphConfiguration;
  automation: AutomationPolicy;
  routing: {
    policy: RoutingPolicy | null;
    observations: { id: string; role: string; model: string | null; state: string }[];
    limitations: string[];
  };
  archives: ArchivePolicy | null;
  tools: unknown;
  warnings: string[];
}

function version(): string {
  return (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
}
function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function text(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
function configFor(root: string): AdapterConfig {
  const path = storagePath(root, '.neomind/config.json');
  if (!existsSync(path)) throw new Error('Project is not initialized. Run neomind init first.');
  const config = JSON.parse(readFileSync(path, 'utf8')) as AdapterConfig;
  if (
    !Array.isArray(config.platforms) ||
    config.platforms.some((platform) => !platforms.includes(platform))
  ) {
    throw new Error('Project configuration has an unsupported platform.');
  }
  return config;
}

function safePath(root: string, path: string): string {
  const result = storagePath(root, path);
  const rel = relative(root, result).replaceAll('\\', '/');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Managed path escapes the project: ${path}`);
  }
  // Existing symlinks can redirect a relative managed path outside the project.
  let parent = result;
  while (parent !== root) {
    let link = false;
    try {
      link = lstatSync(parent).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (link) throw new Error(`Managed path uses a symbolic link: ${path}`);
    parent = dirname(parent);
  }
  return result;
}

function save(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
function manifestFor(root: string): Manifest {
  const source = text(safePath(root, '.neomind/install-manifest.json'));
  if (!source) return { schema_version: 1, version: version(), files: {} };
  const manifest = JSON.parse(source) as Manifest;
  if (manifest.schema_version !== 1 || !manifest.files || typeof manifest.files !== 'object')
    throw new Error('Unsupported installation manifest.');
  // Normalize inventory paths only; authored content and historical signed bytes stay intact.
  manifest.files = Object.fromEntries(Object.entries(manifest.files).map(([id, entry]) => [
    id.replace(/^\.(?:verythinker|taskforces)(?=\/|#|$)/, '.neomind'),
    { ...entry, path: entry.path.replace(/^\.(?:verythinker|taskforces)(?=\/|$)/, '.neomind') },
  ]));
  return manifest;
}
function migratePendingRouting(
  root: string,
  report: InstallReport,
): {
  migrated: string[];
  preserved: string[];
  blocked: boolean;
} {
  let records;
  try {
    records = loadRecords(root);
  } catch {
    const base = '.neomind/migrations/alpha3-records-review.json';
    const body =
      JSON.stringify(
        {
          schema_version: 1,
          status: 'blocked-invalid-record-storage',
          reason:
            'Existing records have invalid metadata or duplicate identities. No original records were modified.',
          recovery:
            'Validate and repair the authoritative records, then rerun the project update. Pending work cannot use legacy model observations for new execution.',
        },
        null,
        2,
      ) + '\n';
    let candidate = base;
    let suffix = 1;
    while (existsSync(safePath(root, candidate)) && text(safePath(root, candidate)) !== body)
      candidate = `${base}.${suffix++}`;
    save(safePath(root, candidate), body);
    report.conflicts.push({
      path: '.neomind/records#alpha3-pending-routing',
      candidate,
      reason:
        'Existing record validation prevents safe pending-work migration; records were preserved for review.',
    });
    report.warnings.push(
      'Pending-work migration requires valid authoritative records; inspect the migration review candidate.',
    );
    return { migrated: [], preserved: [], blocked: true };
  }
  const closedWorkflowIds = new Set<string>();
  const closedTaskIds = new Set<string>();
  for (const record of records) {
    const tasks = strings(record.meta.data.task_ids);
    if (
      record.meta.data.kind !== 'manager-workflow' ||
      !['completed', 'completed-with-blockers'].includes(String(record.meta.data.phase)) ||
      typeof record.meta.data.final_report_id !== 'string' ||
      !tasks.length
    )
      continue;
    const reportRecord = records.find((item) => item.meta.id === record.meta.data.final_report_id);
    if (
      reportRecord?.meta.data.kind !== 'work-record' ||
      !reportRecord.meta.links.some(
        (link) => link.type === 'documents' && link.target === record.meta.id,
      )
    )
      continue;
    closedWorkflowIds.add(record.meta.id);
    for (const id of tasks)
      if (
        records.some(
          (item) =>
            item.meta.id === id &&
            item.meta.type === 'task' &&
            ['submitted', 'verified', 'accepted', 'superseded'].includes(item.meta.status),
        )
      )
        closedTaskIds.add(id);
  }
  const migrated: string[] = [];
  const preserved: string[] = [];
  for (const record of records) {
    if (record.meta.type !== 'task' && record.meta.data.kind !== 'manager-workflow') continue;
    if (nativeWorkflowRecord(root, record)) continue;
    if (
      ['accepted', 'superseded'].includes(record.meta.status) ||
      closedWorkflowIds.has(record.meta.id) ||
      closedTaskIds.has(record.meta.id)
    ) {
      preserved.push(record.meta.id);
      continue;
    }
    const missingIncrement =
      record.meta.data.kind === 'manager-workflow' &&
      (record.meta.data.increment_id === undefined || record.meta.data.increment_id === null);
    if (record.meta.data.routing_required === true && !missingIncrement) continue;
    updateRecord(root, record.meta.id, {
      data: {
        routing_required: true,
        ...(missingIncrement ? { increment_id: randomUUID() } : {}),
        ...(record.meta.data.routing_required === true
          ? {}
          : {
              routing_migration: {
                version: 'alpha.3',
                prior_observations: 'legacy',
                reassessment:
                  'Confirmed Sol planning and native worker invocation are required before resuming pending work.',
              },
            }),
      },
    });
    migrated.push(record.meta.id);
    report.updated.push(`${record.path}#pending-routing`);
  }
  return { migrated, preserved, blocked: false };
}
function outputID(output: ManagedOutput): string {
  return `${output.path}${output.key ? `#${output.key}` : ''}`;
}
function markers(output: ManagedOutput): { begin: string; end: string } {
  const key = output.key ?? 'instructions';
  return output.path.endsWith('.toml') || output.path.endsWith('.gitignore')
    ? { begin: `# BEGIN NEOMIND ${key}`, end: `# END NEOMIND ${key}` }
    : { begin: `<!-- BEGIN NEOMIND ${key} -->`, end: `<!-- END NEOMIND ${key} -->` };
}
function blockState(
  source: string | undefined,
  output: ManagedOutput,
): { value?: string; start?: number; end?: number; malformed?: boolean } {
  if (source === undefined) return {};
  let mark = markers(output);
  const candidates = [mark, ...['TASKFORCES', 'VERYTHINKER'].map((name) => ({
    begin: mark.begin.replace('NEOMIND', name), end: mark.end.replace('NEOMIND', name),
  }))].filter((candidate) => source.includes(candidate.begin) || source.includes(candidate.end));
  if (candidates.length > 1) return { malformed: true };
  mark = candidates[0] ?? mark;
  const start = source.indexOf(mark.begin);
  const finish = source.indexOf(mark.end);
  if (start < 0 && finish < 0) return {};
  if (
    start < 0 ||
    finish < start ||
    source.indexOf(mark.begin, start + mark.begin.length) >= 0 ||
    source.indexOf(mark.end, finish + mark.end.length) >= 0
  )
    return { malformed: true };
  return {
    value: source
      .slice(start + mark.begin.length, finish)
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, ''),
    start,
    end: finish + mark.end.length,
  };
}
function parseJSON(source: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Existing JSON configuration is not a valid object.');
  return result;
}
function jsonValue(object: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object'
        ? (value as Record<string | number, unknown>)[key]
        : undefined,
    object,
  );
}

function installOutput(
  root: string,
  output: ManagedOutput,
  manifest: Manifest,
  report: InstallReport,
): void {
  const path = safePath(root, output.path);
  const current = text(path);
  const id = outputID(output);
  const previous = manifest.files[id];
  let currentValue = current;
  let proposed = output.content;
  let targetHash = hash(proposed);
  let reason: string | undefined;
  try {
    if (output.kind === 'block') {
      const mark = markers(output);
      const block = `${mark.begin}\n${output.content.trimEnd()}\n${mark.end}`;
      proposed = `${block}\n`;
      const state = blockState(current, output);
      if (state.malformed) throw new Error('Managed markers are malformed.');
      currentValue = state.value;
      targetHash = hash(output.content.trimEnd());
      proposed =
        state.start === undefined
          ? output.placement === 'preamble' ? `${current?.startsWith('\uFEFF') ? '\uFEFF' : ''}${block}\n\n${current?.replace(/^\uFEFF/, '') ?? ''}`
            : `${current?.trimEnd() ?? ''}${current ? '\n\n' : ''}${block}\n`
          : `${current!.slice(0, state.start)}${block}${current!.slice(state.end)}`;
      const outside = state.start === undefined ? current ?? ''
        : current!.slice(0, state.start) + current!.slice(state.end);
      if (output.placement === 'preamble' && state.start !== undefined && /^\s*\[/m.test(current!.slice(0, state.start)))
        reason = 'A root TOML setting cannot be installed below an existing table.';
      for (const key of output.rootKeys ?? [])
        if (new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`, 'm').test(outside))
          reason = `An authored ${key} setting already exists; review the parent provider selection.`;
      if (output.key === 'codex-routing-provider' && state.start === undefined &&
          (/^\s*(?:\[\s*model_providers\s*\.\s*(?:neomind_9router|"neomind_9router"|'neomind_9router')\s*(?:\.|\])|model_providers\s*\.\s*(?:neomind_9router|"neomind_9router"|'neomind_9router')\s*(?:\.|=))/m.test(outside) ||
           /^\s*(?:neomind_9router|"neomind_9router"|'neomind_9router')\s*(?:\.|=)/m.test(
             /^\s*\[\s*model_providers\s*\]([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(outside)?.[1] ?? '')))
        reason = 'A user-owned neomind_9router provider table already exists.';
      const serverName = output.key === 'codegraph' ? 'codegraph' : output.key === 'rea' ? 'rea' : 'neomind';
      const serverKey = `(?:${serverName}|"${serverName}"|'${serverName}')`;
      const table = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*(?:\\.|\\])`,
        'm',
      );
      const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*(?:\\.|=)`, 'm');
      const parent = /^\s*\[\s*mcp_servers\s*\]([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(
        current ?? '',
      )?.[1];
      const child = new RegExp(`^\\s*${serverKey}\\s*(?:\\.|=)`, 'm');
      if (
        output.path.endsWith('.toml') &&
        ['mcp', 'codegraph', 'rea'].includes(output.key ?? '') &&
        state.start === undefined &&
        current &&
        (table.test(current) || dotted.test(current) || (parent && child.test(parent)))
      ) {
        reason = `A user-owned ${serverName} MCP table already exists.`;
      }
    } else if (output.kind === 'json') {
      proposed = applyEdits(
        '{}\n',
        modify('{}\n', output.jsonPath!, output.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
        }),
      );
      const object = current === undefined ? {} : parseJSON(current);
      const value = jsonValue(object, output.jsonPath!);
      currentValue = value === undefined ? undefined : JSON.stringify(value);
      // Refuse replacing an existing primitive parent with a new object.
      for (let depth = 1; depth < output.jsonPath!.length; depth++) {
        const parent = jsonValue(object, output.jsonPath!.slice(0, depth));
        if (
          parent !== undefined &&
          (!parent || typeof parent !== 'object' || Array.isArray(parent))
        )
          throw new Error('A parent JSON setting has an incompatible value.');
      }
      proposed = applyEdits(
        current ?? '{}\n',
        modify(current ?? '{}\n', output.jsonPath!, output.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
        }),
      );
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const currentHash = currentValue === undefined ? undefined : hash(currentValue);
  if (
    !reason &&
    currentHash !== undefined &&
    (currentHash === targetHash ||
      (output.kind === 'file' &&
        current !== undefined &&
        current.replaceAll('\r\n', '\n') === proposed.replaceAll('\r\n', '\n')))
  ) {
    // A hash-owned block may need only its historical boundary markers renamed.
    if (previous && output.kind === 'block' && current !== proposed) {
      save(path, proposed);
      report.updated.push(id);
    } else report.unchanged.push(id);
    // Only retain ownership acquired by this installer; identical user files remain user owned.
    // Retain the actual bytes' hash when only whole-file CRLF line endings differ.
    if (previous) manifest.files[id] = { ...previous, hash: currentHash, version: report.version };
    return;
  }
  if (!reason && previous && currentHash !== previous.hash)
    reason =
      currentValue === undefined
        ? 'A managed file or entry was deleted by the user.'
        : 'A managed file or entry was modified by the user.';
  if (!reason && !previous && currentValue !== undefined)
    reason = 'Existing content is owned by the user.';
  if (reason) {
    const candidate = `${output.path}.neomind-update${output.key ? `-${output.key.replace(/[^a-z0-9-]/gi, '-')}` : ''}`;
    const candidatePath = safePath(root, candidate);
    // Keep conflicting candidate edits too; choose a fresh numbered filename.
    let available = candidatePath;
    let suffix = 1;
    while (existsSync(available) && text(available) !== proposed)
      available = `${candidatePath}.${suffix++}`;
    save(available, proposed);
    report.conflicts.push({
      path: id,
      candidate: relative(root, available).replaceAll('\\', '/'),
      reason,
    });
    return;
  }
  save(path, proposed);
  manifest.files[id] = {
    path: output.path,
    kind: output.kind,
    ...(output.key ? { key: output.key } : {}),
    hash: targetHash,
    version: report.version,
  };
  (previous ? report.updated : report.installed).push(id);
}

function resourceOutputs(): ManagedOutput[] {
  const outputs: ManagedOutput[] = [];
  function visit(directory: string, prefix: string): void {
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const path = join(directory, item.name);
      const target = `${prefix}/${item.name}`;
      if (item.isDirectory()) visit(path, target);
      else if (item.isFile())
        outputs.push({ path: target, kind: 'file', content: readFileSync(path, 'utf8') });
    }
  }
  for (const directory of ['roles', 'guides', 'templates', 'skills'])
    visit(join(resourcesDirectory, directory), `.neomind/${directory}`);
  return outputs;
}

export function installProject(root: string, options: InstallOptions = {}): InstallReport {
  root = realpathSync(resolve(root));
  configFor(root);
  return withOperationLock(root, 'project-install', () => installProjectClaimed(root, options));
}
function installProjectClaimed(root: string, options: InstallOptions): InstallReport {
  const config = configFor(root);
  if (options.copilot_integration !== undefined && options.copilot_integration !== 'local')
    throw new Error('Unsupported Copilot integration mode.');
  if (config.copilot_integration !== undefined && config.copilot_integration !== 'local')
    throw new Error('Unsupported Copilot integration mode in project configuration.');
  const policyExists = existsSync(safePath(root, '.neomind/automation.json'));
  const selectedPlatforms = options.platforms ?? config.platforms;
  if (!policyExists && resolveManagedRoot(root) === '.neomind')
    save(safePath(root, '.neomind/automation.json'), JSON.stringify(nativeAutomationPolicy(
      selectedPlatforms.includes('codex') && !selectedPlatforms.includes('copilot') ? 'codex' : 'copilot',
    ), null, 2) + '\n');
  ensureAutomationPolicy(root);
  const policyPaths = [
    '.neomind/routing.json',
    '.neomind/archive.json',
    '.neomind/tools.json',
  ];
  const newPolicyPaths = policyPaths.filter((path) => !existsSync(safePath(root, path)));
  if (options.platforms) config.platforms = options.platforms;
  if (options.profile) config.profile = options.profile;
  if (options.name) config.name = options.name;
  if (options.copilot_integration) config.copilot_integration = options.copilot_integration;
  if (config.platforms.some((platform) => !platforms.includes(platform)))
    throw new Error('Unsupported platform requested.');
  if (!['basic', 'software', 'embedded'].includes(config.profile))
    throw new Error('Unsupported project profile requested.');
  if (options.platforms || options.profile || options.name || options.copilot_integration)
    save(safePath(root, '.neomind/config.json'), JSON.stringify(config, null, 2) + '\n');
  const manifest = manifestFor(root);
  const report: InstallReport = {
    schema_version: 1,
    version: version(),
    root,
    platforms: config.platforms,
    installed: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    warnings: [],
  };
  const localCopilot = config.platforms.includes('copilot') && config.copilot_integration === 'local';
  if (localCopilot) {
    const exclusions = ensureLocalGitExclusions(root);
    if (exclusions.changed && exclusions.path) report.updated.push(exclusions.path);
    if (exclusions.warning) report.warnings.push(exclusions.warning);
    report.warnings.push('Local Copilot mode does not register an MCP server. Review .neomind/mcp-server.json and register its server in VS Code user-profile MCP configuration.');
    if (['.github/copilot-instructions.md', '.vscode/mcp.json', '.mcp.json'].some(path => existsSync(safePath(root, path))))
      report.warnings.push('Local Copilot integration preserves existing shared instructions and workspace MCP configuration. Review any previously configured NeoMind, TaskForces or VeryThinker integration before enabling the user-profile server.');
  }
  if (!policyExists) report.installed.push('.neomind/automation.json');
  ensureRoutingPolicy(root);
  ensureArchivePolicy(root);
  ensureToolPolicy(root);
  report.installed.push(...newPolicyPaths);
  const pendingMigration = migratePendingRouting(root, report);
  const migrationPath = '.neomind/migrations/alpha3.json';
  if (!existsSync(safePath(root, migrationPath))) {
    save(
      safePath(root, migrationPath),
      JSON.stringify(
        {
          schema_version: 1,
          installed_version: report.version,
          historical_routing:
            'Historical accepted/superseded records and recorded closed workflow history retain their original bytes and evidence. Pending tasks and workflows require strict native routing and strategic reassessment; old model strings are legacy observations.',
          new_work:
            'Model choices are configured in routing.json. New NeoMind projects use visible Copilot subagents with unsigned assurance; signed VS Code Bridge execution remains opt-in.',
          authored_overrides: 'preserved-legacy-mappings; routing.json controls strict model selection',
          pending_work: pendingMigration,
        },
        null,
        2,
      ) + '\n',
    );
    report.installed.push(migrationPath);
  }
  if (options.force)
    report.warnings.push(
      'Force does not overwrite user edits. Review and apply update candidates explicitly.',
    );
  const outputs = [
    ...resourceOutputs(),
    ...adapterOutputs(root, config),
    ...[...strongRoles, ...workerRoles].map((role) => ({
      path: `.neomind/roles/${role}.capabilities.json`,
      kind: 'file' as const,
      content:
        JSON.stringify(
          {
            schema_version: 1,
            ...roleCapabilities(role),
            native_enforcement:
              'generated declarations require observed client conformance; invocation-bound MCP gateway enforces its operations',
          },
          null,
          2,
        ) + '\n',
    })),
    {
      path: '.neomind/providers/codegraph.json',
      kind: 'file' as const,
      content: JSON.stringify(codeGraphProvider, null, 2) + '\n',
    },
    ...(!localCopilot ? [{
      path: '.neomind/.gitignore',
      kind: 'block' as const,
      key: 'local-data',
      content:
        'index.sqlite*\ncache/\nraw/\nsessions/\ntools/\narchives/\noperations/\ncapabilities/\n',
    }] : []),
  ];
  for (const output of outputs) installOutput(root, output, manifest, report);
  {
    const currentIds = new Set(outputs.map(outputID));
    for (const [id, entry] of Object.entries(manifest.files)) {
      // Shared files may be tracked on another branch. Local mode never edits
      // or retires their historical entries; any stale integration needs review.
      if (localCopilot && ['.github/copilot-instructions.md', '.vscode/mcp.json', '.mcp.json'].includes(entry.path))
        continue;
      const renamed = entry.kind === 'file' && (
        /^\.neomind\/skills\/(?:verythinker|taskforces)-[^/]+\/SKILL\.md$/.test(entry.path) ||
        /^\.(?:github|claude|agents)\/(?:agents\/(?:verythinker|taskforces)-[^/]+\.(?:agent\.md|md)|hooks\/(?:verythinker|taskforces)\.json|skills\/(?:verythinker|taskforces)-[^/]+\/SKILL\.md)$/.test(entry.path) ||
        /^\.codex\/agents\/(?:verythinker|taskforces)-[^/]+\.toml$/.test(entry.path));
      const oldServer = entry.kind === 'json' && ['servers.verythinker', 'servers.taskforces'].includes(entry.key ?? '') && entry.path === '.vscode/mcp.json';
      const duplicateServer = entry.kind === 'json' && entry.path === '.mcp.json' &&
        (['mcpServers.verythinker', 'mcpServers.taskforces'].includes(entry.key ?? '') || (entry.key === 'mcpServers.neomind' && !config.platforms.includes('claude')));
      const retiredSquadAgent = entry.kind === 'file' && (
        /^\.github\/agents\/neomind-[^/]+\.agent\.md$/.test(entry.path) ||
        /^\.codex\/agents\/neomind-[^/]+\.toml$/.test(entry.path));
      const retiredCodexProvider = entry.kind === 'block' && entry.path === '.codex/config.toml' &&
        ['codex-routing-root', 'codex-routing-provider'].includes(entry.key ?? '');
      const retiredCodexHook = entry.kind === 'json' && entry.path === '.codex/hooks.json' &&
        entry.key === 'hooks.SessionStart';
      const retiredRea = (entry.kind === 'block' && entry.path === '.codex/config.toml' && entry.key === 'rea') ||
        (entry.kind === 'json' && ((entry.path === '.vscode/mcp.json' && entry.key === 'servers.rea') ||
          (entry.path === '.mcp.json' && entry.key === 'mcpServers.rea'))) ||
        (entry.kind === 'file' && /^\.(?:agents|claude|github)\/skills\/reverse-engineer-anything\//.test(entry.path));
      if (currentIds.has(id) || (!renamed && !oldServer && !duplicateServer && !retiredSquadAgent && !retiredCodexProvider && !retiredCodexHook && !retiredRea)) continue;
      const path = safePath(root, entry.path);
      const source = text(path);
      if (source === undefined) { delete manifest.files[id]; continue; }
      // An edited root block remains user-owned. Keep its provider usable until
      // that selection is reviewed instead of leaving a dangling reference.
      if (retiredCodexProvider && entry.key === 'codex-routing-provider' &&
          /^\s*(?:model_provider|"model_provider"|'model_provider')\s*=\s*["']neomind_9router["']/m.test(source)) {
        report.warnings.push('The NeoMind 9router provider is still referenced by a preserved parent selection; review both Codex provider blocks manually.');
        continue;
      }
      let owned = false;
      let updated: string | undefined;
      try {
        if (entry.kind === 'file') owned = hash(source) === entry.hash;
        else if (entry.kind === 'block') {
          const state = blockState(source, { path: entry.path, key: entry.key, kind: 'block', content: '' });
          owned = !state.malformed && state.value !== undefined && hash(state.value) === entry.hash;
          if (owned) updated = source.slice(0, state.start) + source.slice(state.end);
        } else {
          const keys = entry.key!.split('.');
          const value = jsonValue(parseJSON(source), keys);
          owned = value !== undefined && hash(JSON.stringify(value)) === entry.hash;
          if (owned) updated = applyEdits(source, modify(source, keys, undefined, {}));
        }
      } catch { /* Invalid or edited settings stay user-owned. */ }
      if (!owned) {
        report.warnings.push(`Obsolete managed artifact has user edits; remove or migrate manually: ${entry.path}`);
        continue;
      }
      if (updated !== undefined) save(path, updated); else unlinkSync(path);
      delete manifest.files[id];
      report.updated.push(`${id} (retired)`);
    }
  }
  manifest.version = report.version;
  save(
    safePath(root, '.neomind/install-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return report;
}

export function updateProject(root: string, options: Pick<InstallOptions, 'copilot_integration'> = {}): InstallReport {
  return installProject(root, options);
}

export function configureCodeGraph(
  root: string,
  reportPath: string,
  executablePath: string,
  args: string[],
): CodeGraphConfiguration {
  root = realpathSync(resolve(root));
  configFor(root);
  const source = readFileSync(resolve(reportPath), 'utf8');
  const report = validateCodeGraphReport(source);
  validateCodeGraphCommand(root, executablePath, args);
  const config: CodeGraphConfiguration = {
    schema_version: 1,
    package: codeGraphProvider.package,
    version: codeGraphProvider.version,
    enabled: true,
    status: 'supported-for-fixture',
    command: realpathSync(executablePath),
    args: [...args],
    report_path: '.neomind/optional/codegraph-conformance.json',
    report_hash: hash(source),
    platform: process.platform,
    architecture: process.arch,
    limitations: [
      ...report.limitations,
      'Native agent discovery and invocation of this configured command remain unverified.',
    ],
  };
  save(safePath(root, config.report_path), source);
  save(
    safePath(root, '.neomind/optional/codegraph.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
  return config;
}

function executable(name: string): string | null {
  const extensions =
    process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory.replace(/^"|"$/g, ''), name + extension.toLowerCase());
      if (existsSync(path) && lstatSync(path).isFile()) return path;
    }
  }
  return null;
}
function observeClient(name: string): { executable: string | null; version: string | null } {
  const path = executable(name);
  if (!path) return { executable: null, version: null };
  // Batch shims require a shell; report availability without launching user shell code.
  if (/\.(cmd|bat)$/i.test(path)) return { executable: path, version: null };
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return {
    executable: path,
    version: result.status === 0 ? result.stdout.trim().slice(0, 300) : null,
  };
}

export function doctor(root: string): DoctorReport {
  root = realpathSync(resolve(root));
  const config = configFor(root);
  const warnings: string[] = [];
  if (config.platforms.includes('copilot') && config.copilot_integration === 'local')
    warnings.push('Local Copilot mode requires VS Code user-profile MCP registration. .neomind/mcp-server.json is example metadata only; no registered connection or successful tool call is inferred.');
  let codegraph: typeof codeGraphProvider | CodeGraphConfiguration = codeGraphProvider;
  try {
    codegraph = loadCodeGraphConfiguration(root) ?? codeGraphProvider;
  } catch (error) {
    warnings.push(
      `CodeGraph configuration is restricted: ${error instanceof Error ? error.message : String(error)} Review existing native MCP entries before use.`,
    );
  }
  const manifest = manifestFor(root);
  const damaged = Object.values(manifest.files).filter(
    (entry) => !existsSync(safePath(root, entry.path)),
  );
  if (damaged.length)
    warnings.push(
      `${damaged.length} managed files are missing. Run update to generate review candidates.`,
    );
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const routingPolicy = readRoutingPolicy(root);
  const observations: DoctorReport['routing']['observations'] = [];
  const receiptDirectory = safePath(root, '.neomind/native/receipts');
  for (const file of existsSync(receiptDirectory) ? readdirSync(receiptDirectory) : []) {
    if (!file.endsWith('.json')) continue;
    try {
      const receipt = readInvocation(root, file.slice(0, -5));
      if (!routingProblems(root, receipt.role, receipt.id, { require_completed: true }).length)
        observations.push({
          id: receipt.id,
          role: receipt.role,
          model: receipt.confirmed_model,
          state: receipt.state,
        });
    } catch {
      /* Invalid receipts remain unusable engineering evidence. */
    }
  }
  const capabilityDirectory = safePath(root, '.neomind/capabilities');
  const capabilityObservations: unknown[] = [];
  for (const file of existsSync(capabilityDirectory) ? readdirSync(capabilityDirectory) : []) {
    if (!file.endsWith('.json')) continue;
    try {
      capabilityObservations.push(
        JSON.parse(readFileSync(safePath(root, `.neomind/capabilities/${file}`), 'utf8')),
      );
    } catch {
      warnings.push(`Tool observation cannot be read: ${file}`);
    }
  }
  return {
    schema_version: 1,
    root,
    version: version(),
    runtime: { node: process.version, supported: nodeMajor === 24 || nodeMajor >= 26 },
    automation: readAutomationPolicy(root),
    routing: {
      policy: routingPolicy,
      observations,
      limitations: [
        'Catalog/configuration entries do not establish authenticated inference.',
        'Only completed, currently valid signed native receipts count as routing observations.',
        'Exact model routing on native Claude/Copilot clients remains restricted.',
      ],
    },
    archives: readArchivePolicy(root),
    tools: {
      ...(toolObservations(root) as Record<string, unknown>),
      observations: capabilityObservations,
      observation_scope:
        'Persisted discovery/call observations apply to their recorded provider, role, time, and invocation. They do not establish unrestricted native tool enforcement.',
    },
    platforms: config.platforms.map((platform) => {
      const client = observeClient(platform === 'copilot' ? 'code' : platform);
      let expected: ManagedOutput[] = [];
      let validOptional = true;
      try {
        expected = adapterOutputs(root, { ...config, platforms: [platform] });
      } catch {
        validOptional = false;
      }
      const configured =
        validOptional &&
        expected.every((output) => {
          const source = text(safePath(root, output.path));
          if (source === undefined) return false;
          try {
            if (output.kind === 'json')
              return (
                JSON.stringify(jsonValue(parseJSON(source), output.jsonPath!)) === output.content
              );
            if (output.kind === 'block')
              return blockState(source, output).value === output.content.trimEnd();
            return source === output.content;
          } catch {
            return false;
          }
        });
      return {
        platform,
        client,
        requested_models: config.models,
        capabilities: [
          ...(platform === 'copilot' && config.copilot_integration === 'local' ? [{
            capability: 'user-profile-mcp', status: 'unverified' as const,
            detail: 'Register the reviewed server in VS Code user-profile MCP configuration and verify a real tool call. Local metadata is not an active connection.',
          }] : []),
          {
            capability: 'adapter-files',
            status: configured ? 'configured' : 'restricted',
            detail: configured
              ? 'Expected adapter content is present. This is a structural observation.'
              : 'One or more adapter files or managed entries are absent or differ from the generated configuration.',
          },
          {
            capability: 'client-executable',
            status: client.executable ? 'configured' : 'unverified',
            detail: client.executable
              ? 'Executable found on PATH; authentication and client behavior are unverified.'
              : 'Client executable was not found on PATH.',
          },
          {
            capability: 'skill-discovery',
            status: 'unverified',
            detail: 'Confirm discovery in a native client session.',
          },
          {
            capability: 'model-routing',
            status:
              platform === 'copilot'
                ? observations.length
                  ? 'supported'
                  : 'unverified'
                : 'restricted',
            detail:
              platform === 'copilot'
                ? observations.length
                  ? `${observations.length} completed invocations have currently valid signed model-selection receipts; support is limited to those observed roles/models.`
                  : 'Strict Copilot routing is configured; authenticated access and execution require successful native receipt evidence.'
                : 'Portable role/tool declarations are generated; exact Copilot native execution is verified for Copilot first.',
          },
          {
            capability: 'role-tools',
            status: configured ? 'configured' : 'restricted',
            detail: `${roleCapabilities('manager').required.join(', ')} and role-specific operation/provider contracts are configured. The MCP gateway enforces bound roles; native file/tool restrictions remain unverified until observed in the client.`,
          },
          {
            capability: 'mcp',
            status: 'unverified',
            detail:
              'Configuration is generated. Verify tool discovery and invocation in a native client.',
          },
          {
            capability: 'hooks',
            status: 'unverified',
            detail:
              'Advisory hooks are generated. Native trust, settings, and version may restrict execution. CLI verify remains authoritative.',
          },
          {
            capability: 'cloud-client',
            status: 'restricted',
            detail:
              'This adapter targets local project clients. Absolute launch paths require reinstalling on another machine.',
          },
        ],
      };
    }),
    codegraph,
    warnings,
  };
}
