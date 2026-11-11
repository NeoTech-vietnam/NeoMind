import type { EditorApi } from '../ui-server/server.js';
import type { RunManager } from './run-manager.js';

/**
 * Tools an agent session of a host (Nimbalyst) uses to drive NeoMind runs, one per CLI command. They act through the
 * same RunManager as the CLI and the editor; nothing here bypasses the journal or the run's own checks.
 *
 * Approving a plan, applying changes to the checkout, committing the user's own changes and discarding unsaved run
 * changes are the user's decisions: those tools take `confirmed: true`, and their descriptions tell the agent to ask
 * the user first. The host cannot prove that the agent asked; the journal records such approvals with source `session`.
 */
export interface SessionToolCall { caller?: string; sessionId?: string | null }
export interface SessionTool { name: string; description: string; inputSchema: Record<string, unknown>; panelOnly?: boolean }
type Handler = (args: Record<string, unknown>, call?: SessionToolCall) => Promise<unknown>;

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const runId = { runId: { type: 'string', description: 'Run id returned by start or listed by status' } };
const confirmed = { confirmed: { type: 'boolean', description: 'true only after the user explicitly agreed in this session' } };

export const SESSION_TOOLS: SessionTool[] = [
  { name: 'skills', description: 'List project skill catalog and optionally check pinned references for changed or missing files.', inputSchema: object({ refs: { type: 'array', items: object({ id: { type: 'string' }, path: { type: 'string' }, sha256: { type: 'string' } }, ['id', 'path', 'sha256']) } }) },
  { name: 'profile_get', description: 'Read a profile draft and immutable versions with their authors.', inputSchema: object({ profileId: { type: 'string' } }, ['profileId']) },
  { name: 'profile_draft', description: 'Create or update an AI profile draft from a profile or full draft. Updates require the observed revision.', inputSchema: object({ profileId: { type: 'string' }, name: { type: 'string' }, from: object({ profileId: { type: 'string' } }, ['profileId']), draft: { type: 'object' }, expectedRevision: { type: 'string' } }, ['profileId']) },
  { name: 'profile_publish', description: 'Publish an AI profile as a new version under project policy. Present the proposed changes to the user before publishing.', inputSchema: object({ profileId: { type: 'string' }, expectedRevision: { type: 'string' }, reason: { type: 'string' } }, ['profileId', 'expectedRevision', 'reason']) },
  { name: 'profile_archive', description: 'Archive (or restore with archived: false) a project profile. Archived profiles keep their versions for replay but are hidden from new steps.', inputSchema: object({ profileId: { type: 'string' }, archived: { type: 'boolean' } }, ['profileId']) },
  { name: 'profile_delete', description: 'Permanently delete a project profile that no flow uses. Refused with the flows that use it (archive instead). Ask the user first.',
    inputSchema: object({ profileId: { type: 'string' }, ...confirmed }, ['profileId', 'confirmed']) },
  { name: 'skill_get', description: 'Read a skill: SKILL.md (name, description, Markdown body), its sha256, companion files and the exact text a run adds to the prompt. source "claude" reads .claude/skills (read-only).',
    inputSchema: object({ skillId: { type: 'string' }, source: { type: 'string', enum: ['neomind', 'claude'] }, file: { type: 'string', description: 'Companion file to read, relative to the skill folder' } }, ['skillId']) },
  { name: 'skill_create', description: 'Create neomind/skills/<skillId>/SKILL.md (Claude skill format). Pin it in a profile or step afterwards; creating does not change any run.',
    inputSchema: object({ skillId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string', description: 'When the skill applies; shown in the catalog' }, body: { type: 'string', description: 'Markdown instructions' }, template: { type: 'string', enum: ['empty', 'review-checklist'] } }, ['skillId', 'name']) },
  { name: 'skill_update', description: 'Edit a neomind skill if it still has the sha256 you read (skill_get). Give name/description/body or the full content, and/or companion files (content null deletes). repin: true updates the pins in profile and flow drafts (not published versions); show the usage to the user before.',
    inputSchema: object({ skillId: { type: 'string' }, expectedSha256: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, content: { type: 'string' },
      files: { type: 'array', items: object({ path: { type: 'string' }, content: { type: ['string', 'null'] }, expectedSha256: { type: ['string', 'null'], description: 'null for a new file' } }, ['path', 'content']) }, repin: { type: 'boolean' } }, ['skillId', 'expectedSha256']) },
  { name: 'skill_delete', description: 'Delete a neomind skill. Refused while profiles or flows pin it (the reply lists them); force deletes anyway. Ask the user first, listing where it is used.',
    inputSchema: object({ skillId: { type: 'string' }, force: { type: 'boolean' }, ...confirmed }, ['skillId', 'confirmed']) },
  { name: 'skill_usage', description: 'Profiles and flow steps that pin a skill, and whether each pin is older than the current file.',
    inputSchema: object({ skillId: { type: 'string' }, source: { type: 'string', enum: ['neomind', 'claude'] } }, ['skillId']) },
  { name: 'flow_blocks', description: 'List available node types, templates, profiles, bindings and project policy for authoring a flow.', inputSchema: object() },
  { name: 'flow_get', description: 'Read a flow draft, revision and published versions with their authors.', inputSchema: object({ flowId: { type: 'string' } }, ['flowId']) },
  { name: 'flow_draft', description: 'Create or update an AI flow draft from a template, another flow or a full draft. Updates require the revision previously read. Returns policy diagnostics.', inputSchema: object({ flowId: { type: 'string' }, name: { type: 'string' }, from: { oneOf: [object({ template: { type: 'string', enum: ['fast', 'dev', 'parallel', 'research'] } }, ['template']), object({ flowId: { type: 'string' } }, ['flowId'])] }, draft: { type: 'object', description: 'Full flow draft; compiler returns diagnostics for incomplete drafts' }, expectedRevision: { type: 'string', description: 'Required for updates, from flow_get or flow_draft' } }, ['flowId']) },
  { name: 'flow_validate', description: 'Validate an AI flow draft against project policy and return its diff from the latest published version.', inputSchema: object({ flowId: { type: 'string' } }, ['flowId']) },
  { name: 'flow_publish', description: 'Publish the validated AI draft as a new version. Present the flow_validate diff to the user before publishing, even when policy allows publication.', inputSchema: object({ flowId: { type: 'string' }, expectedRevision: { type: 'string' }, reason: { type: 'string' } }, ['flowId', 'expectedRevision', 'reason']) },
  { name: 'assess', description: 'Recommend an existing flow for a task using deterministic rules. available=false means the named flow is unavailable; this does not start a run.', inputSchema: object({ task: { type: 'string' } }, ['task']) },
  { name: 'stats', description: 'Run statistics of this project by flow, profile, runner/model and flow + runners: runs, completion and delivery rate, median tokens and active time, repair rounds, first-pass review rate, cost when neomind/pricing.json exists.',
    inputSchema: object({ flowId: { type: 'string' } }) },
  { name: 'program_create', description: 'Create a multi-phase program in neomind/programs from a spec: { schemaVersion: 1, programId, name, goal, phases: [{ id, title, task, flowId, dependsOn: [] }] }. Every flowId must be published. Show the phases to the user first.',
    inputSchema: object({ program: { type: 'object' } }, ['program']) },
  { name: 'program_list', description: 'Programs of this project with progress and the current phase.', inputSchema: object() },
  { name: 'program_status', description: 'Status of each phase: blocked_by_dependency, ready, running, waiting_user (merge or apply the result), delivered or failed, with its runs and commits.',
    inputSchema: object({ programId: { type: 'string' } }, ['programId']) },
  { name: 'program_next', description: 'Start the first ready phase; the task includes lessons from earlier phases. Never starts on its own: call only after the user confirmed the previous phase result is in their branch.',
    inputSchema: object({ programId: { type: 'string' }, importDirty: { type: 'string' } }, ['programId']) },
  { name: 'program_deliver', description: 'Mark a completed phase as delivered when Git cannot see it (squash, rebase, manual copy), with the user note for later phases. Ask the user first.',
    inputSchema: object({ programId: { type: 'string' }, phaseId: { type: 'string' }, note: { type: 'string' }, ...confirmed }, ['programId', 'phaseId', 'confirmed']) },
  { name: 'flows', description: 'NeoMind flows of this project (built-in: fast, dev, parallel, research, plus the project\'s own). Use the flowId with preview and start.', inputSchema: object() },
  { name: 'preview', description: 'What starting a flow would do, without starting it: the runner, model and reasoning of each step, blockers that prevent starting, exceptions the flow declares (Fast approves its own plan and leaves review to the user), the checkout\'s uncommitted changes, and the project rules (neomind/rules.md) every agent must follow and every review judges.',
    inputSchema: object({ flowId: { type: 'string' } }, ['flowId']) },
  { name: 'start', description: 'Start a NeoMind flow for a task in this project. "fast": quick plan approved by NeoMind, then implement; the user reviews and applies the changes. "dev": plan, user approval, implement, checks, independent review, local commit. "parallel": two implementers in parallel. "research": read-only report. A preview with blockers does not start. Agents run in an isolated Git worktree, never in the user\'s checkout. Returns the run id; follow it with wait.',
    inputSchema: object({ flowId: { type: 'string' }, task: { type: 'string', description: 'What the flow should accomplish, in the user\'s words' },
      importDirty: { type: 'string', description: 'dirtyImport.baselineHash from preview, to bring the checkout\'s uncommitted changes into the run as input (only if the user asked for it)' } }, ['flowId', 'task']) },
  { name: 'status', description: 'Without runId: this project\'s runs, newest first. With runId: phase and reason, the plan and its planHash, checks and review verdicts, and the result (commit or changed files). Phases: running, waiting_approval (the user decides on the plan), completed, blocked (see reason), paused, recovering (press resume), cancelled.',
    inputSchema: object(runId) },
  { name: 'wait', description: 'Wait until the run leaves its current phase or the timeout passes, then return its status. Use this instead of calling status repeatedly.',
    inputSchema: object({ ...runId, timeoutSeconds: { type: 'number', description: '5-240, default 120' } }, ['runId']) },
  { name: 'approve', description: 'Approve the run\'s proposed plan so implementation starts. The user decides: first show them the plan from status (goal, approach, acceptance criteria, scope, checks) and ask with your interactive question tool; call this only after they say yes, with the planHash you showed.',
    inputSchema: object({ ...runId, planHash: { type: 'string' }, ...confirmed }, ['runId', 'planHash', 'confirmed']) },
  { name: 'request_changes', description: 'Ask the planner to revise the proposed plan with the user\'s feedback (their words, not yours).',
    inputSchema: object({ ...runId, planHash: { type: 'string' }, feedback: { type: 'string' } }, ['runId', 'planHash', 'feedback']) },
  { name: 'pause', description: 'Pause the run: stop dispatching and stop the running agents. Resume continues it.', inputSchema: object(runId, ['runId']) },
  { name: 'resume', description: 'Continue a paused, blocked or recovering run after NeoMind reconciles its state.', inputSchema: object(runId, ['runId']) },
  { name: 'cancel', description: 'Cancel the run (only when the user asks). Its worktree and history are kept.', inputSchema: object(runId, ['runId']) },
  { name: 'extend_time', description: 'Give a run that used up its active-time limit more time, or its token budget (maxTokens) more tokens, then continue it.',
    inputSchema: object({ ...runId, seconds: { type: 'number', description: '1-86400' }, tokens: { type: 'number', description: 'Tokens to add to the budget' } }, ['runId']) },
  { name: 'apply', description: 'Copy a finished Fast run\'s changes into the user\'s checkout (not staged, not committed). Ask the user first, listing the changed files from status; call only after they agree.',
    inputSchema: object({ ...runId, ...confirmed }, ['runId', 'confirmed']) },
  { name: 'retry_commit', description: 'Retry the local commit of a run blocked at its commit step.', inputSchema: object(runId, ['runId']) },
  { name: 'include_imported', description: 'When a run is blocked because its change cannot be separated from the user\'s own uncommitted change, commit both together. Ask the user first.',
    inputSchema: object({ ...runId, ...confirmed }, ['runId', 'confirmed']) },
  { name: 'clean', description: 'Remove a finished run\'s worktrees (its commits stay reachable under refs/neomind). Refuses while changes exist only in the worktree; force discards them, only after the user agreed.',
    inputSchema: object({ ...runId, force: { type: 'boolean' }, ...confirmed }, ['runId']) },
  { name: 'session', description: 'What the run\'s agents did. Without attemptId: one line per agent turn (step, runner, files changed, commands, tokens). With attemptId: that turn\'s events (messages, reads, edits, commands) from event number `after`.',
    inputSchema: object({ ...runId, attemptId: { type: 'string' }, after: { type: 'number' } }, ['runId']) },
  // The NeoMind panel reaches the editor API through this tool; agents never see it.
  { name: 'api', panelOnly: true, description: 'NeoMind panel: one editor API request.', inputSchema: object({ method: { type: 'string' }, path: { type: 'string' }, body: {} }, ['method', 'path']) },
];

const text = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
};
const optional = (args: Record<string, unknown>, key: string) => typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
function requireConfirmed(args: Record<string, unknown>, what: string) {
  if (args.confirmed !== true) throw new Error(`${what} is the user's decision: ask them in this session first, then call again with confirmed: true.`);
}
const clip = (value: string | undefined, max = 1500) => value && value.length > max ? `${value.slice(0, max)}…` : value;

type Run = Awaited<ReturnType<RunManager['get']>>;
/** The run fields a session needs, without the full journal report. */
export function runSummary(run: Run) {
  const plan = run.plans.at(-1)?.plan, phase = run.runtimeState?.phase ?? 'recovering';
  const handoff = (run as { handoff?: { files: string[]; applied: boolean } }).handoff;
  const flow = (run.snapshot as { configuration?: { flow?: { flowId: string; name: string } } } | undefined)?.configuration?.flow;
  return {
    runId: run.runId, flowId: flow?.flowId, flow: flow?.name, task: run.runtimeContext?.task, codexSandbox: run.runtimeContext?.codexSandbox ?? 'enabled', phase, reason: run.runtimeState?.reason ?? '',
    activeSeconds: Math.round((run.runtimeState?.activeMs ?? 0) / 1000), tokens: run.usage.totalTokens,
    ...(plan ? { plan: { goal: plan.goal, approach: plan.approach, acceptanceCriteria: plan.acceptanceCriteria, scope: plan.scope, checks: plan.checks, riskChanges: plan.riskChanges },
      ...(run.proposedPlanHash ? { planHash: run.proposedPlanHash } : {}) } : {}),
    ...(phase === 'waiting_approval' ? { waitsFor: 'The user approves the plan or asks for changes (approve / request_changes here after asking them, or in the NeoMind panel).' } : {}),
    ...(run.checks.length ? { checks: run.checks.map(check => ({ command: check.command, status: check.status })) } : {}),
    ...(run.reviewerOutputs.length ? { reviews: run.reviewerOutputs.map(output => ({ reviewer: output.result.reviewerId, verdict: output.result.verdict, summary: clip(output.summary, 600) })) } : {}),
    ...(run.delivery?.length ? { commits: run.delivery.map(item => ({ commit: item.commit, files: item.files, cherryPick: `git cherry-pick ${item.commit}` })) } : {}),
    ...(handoff ? { changedFiles: handoff.files, applied: handoff.applied } : {}),
    ...(run.workspaceCleanup?.cleaned ? { worktreeCleaned: true } : {}),
  };
}

/** Handlers for every tool in SESSION_TOOLS over one project. */
export function sessionToolHandlers(runs: () => Promise<RunManager>, api: EditorApi, options: { onStart?(runId: string, call?: SessionToolCall): Promise<void> | void; approvalActor?: string } = {}): Record<string, Handler> {
  const summary = async (id: string) => runSummary(await (await runs()).get(id));
  const act = async (args: Record<string, unknown>, action: Parameters<RunManager['action']>[1]) => {
    await (await runs()).action(text(args, 'runId'), action, 'session');
    return summary(text(args, 'runId'));
  };
  const authoringApi = async (method: string, path: string, body?: unknown) => {
    const response = await api({ method, path, ...(body === undefined ? {} : { body }) });
    if (response.status >= 400) throw new Error(String((response.body as { error?: string }).error ?? `HTTP ${response.status}`));
    return response.body;
  };
  const flowPath = (args: Record<string, unknown>) => `/api/flows/${encodeURIComponent(text(args, 'flowId'))}`;
  const programPath = (args: Record<string, unknown>) => `/api/programs/${encodeURIComponent(text(args, 'programId'))}`;
  const profilePath = (args: Record<string, unknown>) => `/api/profiles/${encodeURIComponent(text(args, 'profileId'))}`;
  const skillPath = (args: Record<string, unknown>) => `/api/skills/${encodeURIComponent(text(args, 'skillId'))}`;
  const aiAuthor = (call?: SessionToolCall) => ({ kind: 'ai' as const, ...(call?.sessionId ? { sessionId: call.sessionId } : {}) });
  return {
    skills: async args => ({ catalog: await authoringApi('GET', '/api/skills'), ...(args.refs ? { status: await authoringApi('POST', '/api/skills/status', { refs: args.refs }) } : {}) }),
    profile_get: async args => authoringApi('GET', `${profilePath(args)}/authoring`),
    profile_draft: async args => authoringApi('POST', '/api/profile-draft', args),
    profile_publish: async (args, call) => authoringApi('POST', `${profilePath(args)}/publish`, { expectedRevision: text(args, 'expectedRevision'), author: { kind: 'ai', ...(call?.sessionId ? { sessionId: call.sessionId } : {}), reason: text(args, 'reason') } }),
    profile_archive: async (args, call) => authoringApi('POST', `${profilePath(args)}/set-archived`, { archived: args.archived !== false, author: aiAuthor(call) }),
    profile_delete: async (args, call) => {
      requireConfirmed(args, 'Deleting a profile');
      const response = await api({ method: 'POST', path: `${profilePath(args)}/remove`, body: { author: aiAuthor(call) } });
      if (response.status >= 400 && response.status !== 409) throw new Error(String((response.body as { error?: string }).error ?? `HTTP ${response.status}`));
      return response.body;
    },
    skill_get: async args => {
      const file = optional(args, 'file'), query = optional(args, 'source') === 'claude' ? '?source=claude' : '';
      return authoringApi('GET', `${skillPath(args)}${file ? `/files/${file.split(/[\\/]/).map(encodeURIComponent).join('/')}` : ''}${query}`);
    },
    skill_create: async (args, call) => authoringApi('POST', '/api/skills', { id: text(args, 'skillId'), name: text(args, 'name'),
      ...(typeof args.description === 'string' ? { description: args.description } : {}), ...(typeof args.body === 'string' ? { body: args.body } : {}),
      ...(optional(args, 'template') ? { template: optional(args, 'template') } : {}), author: aiAuthor(call) }),
    skill_update: async (args, call) => {
      const expected = text(args, 'expectedSha256'), change = Object.fromEntries(['name', 'description', 'body', 'content'].filter(key => typeof args[key] === 'string').map(key => [key, args[key]]));
      const files = Array.isArray(args.files) ? args.files as { path?: unknown; content?: unknown; expectedSha256?: unknown }[] : [];
      let result: unknown;
      if (Object.keys(change).length) result = await authoringApi('PUT', skillPath(args), { ...change, expectedSha256: expected, author: aiAuthor(call) });
      else if ((await authoringApi('GET', skillPath(args)) as { sha256: string }).sha256 !== expected) throw new Error('The skill changed since you read it; call skill_get again');
      const written = [];
      for (const file of files) {
        if (typeof file.path !== 'string' || !file.path.trim()) throw new Error('Each file needs a path');
        const filePath = `${skillPath(args)}/files/${file.path.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
        written.push(file.content === null ? { path: file.path, ...await authoringApi('DELETE', filePath, { author: aiAuthor(call) }) as object }
          : await authoringApi('PUT', filePath, { content: String(file.content ?? ''), expectedSha256: typeof file.expectedSha256 === 'string' ? file.expectedSha256 : null, author: aiAuthor(call) }));
      }
      const skill = result ?? { skill: await authoringApi('GET', skillPath(args)), usage: await authoringApi('GET', `${skillPath(args)}/usage`) };
      return { ...skill as object, ...(written.length ? { files: written } : {}), ...(args.repin === true ? { repinned: await authoringApi('POST', `${skillPath(args)}/repin`, {}) } : {}) };
    },
    skill_delete: async (args, call) => {
      requireConfirmed(args, 'Deleting a skill');
      const response = await api({ method: 'POST', path: `${skillPath(args)}/delete`, body: { force: args.force === true, author: aiAuthor(call) } });
      if (response.status >= 400 && response.status !== 409) throw new Error(String((response.body as { error?: string }).error ?? `HTTP ${response.status}`));
      return response.status === 409 ? { deleted: false, ...response.body as object } : response.body;
    },
    skill_usage: async args => authoringApi('GET', `${skillPath(args)}/usage${optional(args, 'source') === 'claude' ? '?source=claude' : ''}`),
    flow_blocks: async () => authoringApi('GET', '/api/flow-blocks'),
    flow_get: async args => authoringApi('GET', `${flowPath(args)}/authoring`),
    flow_draft: async args => authoringApi('POST', '/api/flow-draft', args),
    flow_validate: async args => authoringApi('POST', `${flowPath(args)}/author-validate`, {}),
    flow_publish: async (args, call) => authoringApi('POST', `${flowPath(args)}/publish`, { expectedRevision: text(args, 'expectedRevision'), author: { kind: 'ai', ...(call?.sessionId ? { sessionId: call.sessionId } : {}), reason: text(args, 'reason') } }),
    assess: async args => authoringApi('POST', '/api/assess', { task: text(args, 'task') }),
    stats: async args => { const stats = await authoringApi('GET', `/api/stats${optional(args, 'flowId') ? `?flow=${encodeURIComponent(optional(args, 'flowId')!)}` : ''}`) as { runs: unknown[] }; const { runs: _runs, ...rest } = stats; return rest; },
    program_create: async args => authoringApi('POST', '/api/programs', { program: args.program }),
    program_list: async () => authoringApi('GET', '/api/programs'),
    program_status: async args => authoringApi('GET', programPath(args)),
    program_next: async (args, call) => {
      const result = await authoringApi('POST', `${programPath(args)}/next`, optional(args, 'importDirty') ? { importDirty: optional(args, 'importDirty') } : {}) as { started: boolean; runId?: string };
      if (result.started && result.runId) await options.onStart?.(result.runId, call);
      return result;
    },
    program_deliver: async args => { requireConfirmed(args, 'Marking a phase delivered'); return authoringApi('POST', `${programPath(args)}/phases/${encodeURIComponent(text(args, 'phaseId'))}/deliver`, { note: optional(args, 'note') ?? '' }); },
    flows: async () => {
      const response = await api({ method: 'GET', path: '/api/bootstrap' });
      const body = response.body as { flows?: { flowId: string; name: string; archived?: boolean }[]; templates?: string[] };
      return { flows: (body.flows ?? []).filter(flow => !flow.archived).map(flow => ({ flowId: flow.flowId, name: flow.name })), builtIn: body.templates ?? [] };
    },
    preview: async args => {
      const preview = await (await runs()).preview(text(args, 'flowId'));
      return { flow: preview.snapshot.configuration.flow.name, codexSandbox: preview.codexSandbox,
        steps: Object.fromEntries(Object.entries(preview.snapshot.configuration.bindings).map(([key, binding]) => [key, binding.values])),
        blockers: [...preview.runtimeDiagnostics, ...(preview.runnerPreflight?.blockers ?? [])], exceptions: preview.flowExceptions ?? [],
        rules: preview.rules.rules.map(rule => `[${rule.id}] ${rule.text}`), ...(preview.rules.warnings.length ? { ruleWarnings: preview.rules.warnings } : {}),
        ...(Object.values(preview.snapshot.configuration.bindings).some(binding => binding.values.runner === 'opencode' || binding.fallback.some(item => item.runner === 'opencode')) ? { openCodeWarning: 'OpenCode runs with the account permissions; write scope is not enforced. Process stop must still be verified.' } : {}),
        uncommittedChanges: preview.dirtyImport.changes.length ? { count: preview.dirtyImport.changes.length, files: preview.dirtyImport.changes.slice(0, 30).map(change => `${change.change} ${change.path}`), importDirty: preview.dirtyImport.baselineHash } : null };
    },
    start: async (args, call) => {
      const manager = await runs(), flowId = text(args, 'flowId'), task = text(args, 'task'), importDirty = optional(args, 'importDirty');
      const preview = await manager.preview(flowId);
      const blockers = [...preview.runtimeDiagnostics, ...(preview.runnerPreflight?.blockers ?? [])];
      if (blockers.length) return { started: false, blockers };
      const run = await manager.create(flowId, task, undefined, {}, preview.configurationHash, {}, importDirty);
      await options.onStart?.(run.runId, call);
      return { started: true, ...await summary(run.runId),
        ...(preview.dirtyPaths.length && !importDirty ? { note: `The checkout has ${preview.dirtyPaths.length} uncommitted changes; the run starts from HEAD without them.` } : {}) };
    },
    status: async args => {
      const id = optional(args, 'runId');
      if (id) return summary(id);
      return { runs: (await (await runs()).list()).reverse().map(run => ({ runId: run.runId, flow: run.flowName, task: run.task, phase: run.phase, reason: run.reason })) };
    },
    wait: async args => {
      const id = text(args, 'runId'), timeout = Math.min(240, Math.max(5, Number(args.timeoutSeconds ?? 120))) * 1000;
      const first = await summary(id), deadline = Date.now() + timeout;
      let current = first;
      while (Date.now() < deadline && current.phase === first.phase && ['running', 'stopping'].includes(current.phase)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        current = await summary(id);
      }
      // The phase is journaled before post-run work (worktree cleanup) finishes, and actions refuse a busy run.
      if (!['running', 'stopping'].includes(current.phase)) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([(await runs()).settle(id).catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
        clearTimeout(timer); current = await summary(id);
      }
      return { ...current, changed: current.phase !== first.phase, ...(current.phase === first.phase && ['running', 'stopping'].includes(current.phase) ? { note: 'Still running; call wait again.' } : {}) };
    },
    approve: async args => {
      requireConfirmed(args, 'Approving the plan');
      const id = text(args, 'runId'), planHash = text(args, 'planHash');
      await (await runs()).action(id, 'approve', 'session', planHash, options.approvalActor ?? 'local-user (Nimbalyst session)');
      return summary(id);
    },
    request_changes: async args => { await (await runs()).revisePlan(text(args, 'runId'), text(args, 'feedback'), text(args, 'planHash')); return summary(text(args, 'runId')); },
    pause: args => act(args, 'pause'),
    resume: args => act(args, 'resume'),
    cancel: args => act(args, 'cancel'),
    extend_time: async args => {
      const seconds = args.seconds === undefined ? 0 : Number(args.seconds), tokens = args.tokens === undefined ? 0 : Number(args.tokens);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) throw new Error('seconds must be an integer from 1 to 86400');
      if (!Number.isInteger(tokens) || tokens < 0 || tokens > 1_000_000_000) throw new Error('tokens must be a positive integer');
      if (!seconds && !tokens) throw new Error('Give seconds, tokens or both');
      await (await runs()).extendTime(text(args, 'runId'), seconds, tokens); return summary(text(args, 'runId'));
    },
    apply: async args => { requireConfirmed(args, 'Applying changes to the checkout'); return act(args, 'apply'); },
    retry_commit: args => act(args, 'retry_git'),
    include_imported: async args => { requireConfirmed(args, 'Committing the user\'s own changes'); return act(args, 'include_imported'); },
    clean: async args => {
      const force = args.force === true;
      if (force) requireConfirmed(args, 'Discarding the run\'s unsaved changes');
      const run = await (await runs()).clean(text(args, 'runId'), force);
      return { ...runSummary(run), cleanup: run.workspaceCleanup };
    },
    session: async args => {
      const manager = await runs(), id = text(args, 'runId'), attemptId = optional(args, 'attemptId');
      if (!attemptId) {
        const { transcripts, history } = await manager.transcripts(id);
        return { turns: transcripts.map(item => ({ attemptId: item.meta.attemptId, step: item.meta.key, role: item.meta.role, runner: item.meta.runner, model: item.meta.model,
          status: item.status ?? 'running', files: item.files, reads: item.reads, commands: item.commands, tokens: item.usage?.totalTokens ?? null })),
          olderTurns: history.map(item => ({ attemptId: item.attemptId, step: item.key, note: 'recorded before transcripts; read with attemptId (runner history)' })) };
      }
      const after = Math.max(0, Number(args.after ?? 0) || 0);
      let page = await manager.transcript(id, attemptId, after, 'neomind');
      if (!page.recorded) page = await manager.transcript(id, attemptId, after, 'runner');
      const events = page.events.slice(0, 100).map(event => ({ i: event.i, kind: event.kind, ...(event.path ? { path: event.path } : {}), ...(event.command ? { command: event.command } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}), ...(event.added !== undefined ? { added: event.added, removed: event.removed } : {}),
        ...(event.status ? { status: event.status } : {}), ...(event.text ? { text: clip(event.text) } : {}) }));
      return { source: page.source, events, ...(page.events.length > 100 ? { more: `call again with after: ${events.at(-1)!.i! + 1}` } : {}), ...('note' in page && page.note ? { note: page.note } : {}) };
    },
    api: async args => api({ method: text(args, 'method').toUpperCase(), path: text(args, 'path'), body: args.body ?? {} }),
  };
}
