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
  { name: 'flows', description: 'NeoMind flows of this project (built-in: fast, dev, parallel, research, plus the project\'s own). Use the flowId with preview and start.', inputSchema: object() },
  { name: 'preview', description: 'What starting a flow would do, without starting it: the runner, model and reasoning of each step, blockers that prevent starting, exceptions the flow declares (Fast approves its own plan and leaves review to the user), and the checkout\'s uncommitted changes.',
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
  { name: 'extend_time', description: 'Give a run that used up its active-time limit more time, then continue it.',
    inputSchema: object({ ...runId, seconds: { type: 'number', description: '1-86400' } }, ['runId', 'seconds']) },
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
    runId: run.runId, flowId: flow?.flowId, flow: flow?.name, task: run.runtimeContext?.task, phase, reason: run.runtimeState?.reason ?? '',
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
export function sessionToolHandlers(runs: () => Promise<RunManager>, api: EditorApi, options: { onStart?(runId: string, call?: SessionToolCall): Promise<void> | void } = {}): Record<string, Handler> {
  const summary = async (id: string) => runSummary(await (await runs()).get(id));
  const act = async (args: Record<string, unknown>, action: Parameters<RunManager['action']>[1]) => {
    await (await runs()).action(text(args, 'runId'), action, 'session');
    return summary(text(args, 'runId'));
  };
  return {
    flows: async () => {
      const response = await api({ method: 'GET', path: '/api/bootstrap' });
      const body = response.body as { flows?: { flowId: string; name: string; archived?: boolean }[]; templates?: string[] };
      return { flows: (body.flows ?? []).filter(flow => !flow.archived).map(flow => ({ flowId: flow.flowId, name: flow.name })), builtIn: body.templates ?? [] };
    },
    preview: async args => {
      const preview = await (await runs()).preview(text(args, 'flowId'));
      return { flow: preview.snapshot.configuration.flow.name,
        steps: Object.fromEntries(Object.entries(preview.snapshot.configuration.bindings).map(([key, binding]) => [key, binding.values])),
        blockers: [...preview.runtimeDiagnostics, ...(preview.runnerPreflight?.blockers ?? [])], exceptions: preview.flowExceptions ?? [],
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
      return { ...current, changed: current.phase !== first.phase, ...(current.phase === first.phase && ['running', 'stopping'].includes(current.phase) ? { note: 'Still running; call wait again.' } : {}) };
    },
    approve: async args => {
      requireConfirmed(args, 'Approving the plan');
      const id = text(args, 'runId'), planHash = text(args, 'planHash');
      await (await runs()).action(id, 'approve', 'session', planHash, 'local-user (Nimbalyst session)');
      return summary(id);
    },
    request_changes: async args => { await (await runs()).revisePlan(text(args, 'runId'), text(args, 'feedback'), text(args, 'planHash')); return summary(text(args, 'runId')); },
    pause: args => act(args, 'pause'),
    resume: args => act(args, 'resume'),
    cancel: args => act(args, 'cancel'),
    extend_time: async args => {
      const seconds = Number(args.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('seconds must be an integer from 1 to 86400');
      await (await runs()).extendTime(text(args, 'runId'), seconds); return summary(text(args, 'runId'));
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
