/**
 * NeoMind backend module for Nimbalyst. Nimbalyst runs it in an Electron utility process, once per open workspace. It
 * owns one RunManager for that workspace (the same core, runners and state as the CLI and the standalone editor) and
 * registers the tools agent sessions call (`neomind_start`, ...) and the panel-only tools of the NeoMind panel.
 *
 * The activate contract (`ctx.services.registerMcpTools`, returned `methods`, `ctx.call` on each call) is the one the
 * built-in Crew extension uses; it is not in the public SDK types of @nimbalyst/extension-sdk 0.7.1.
 */
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { allocateProcessScope } from '../../../src/adapters/worker-scope.js';
import { resolveWindowsCodex } from '../../../src/adapters/worker-environment.js';
import { RunManager } from '../../../src/runtime/run-manager.js';
import { SESSION_TOOLS, sessionToolHandlers, type SessionToolCall } from '../../../src/runtime/session-tools.js';
import { createEditorApi } from '../../../src/ui-server/server.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; scope: 'global'; panelOnly?: boolean }
interface ActivateContext {
  services: {
    workspacePath: string;
    dataDir: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    registerMcpTools: (tools: ToolDefinition[]) => Promise<{ registered: string[] }>;
  };
}

/** Which version of a command answers, or why it does not. */
function version(command: string, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, shell: false, windowsHide: true });
  return result.error ? { ok: false, error: result.error.message } : { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim().split('\n')[0] };
}

/** What this utility process can run: agents, Git, Job Object confinement with confirmed stop, node:sqlite. */
async function probe(workspacePath: string) {
  const report: Record<string, unknown> = { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, workspacePath };
  try { await import('node:sqlite'); report.sqlite = { ok: true }; } catch (error) { report.sqlite = { ok: false, error: String(error) }; }
  report.git = version('git');
  report.claude = version(process.platform === 'win32' ? path.join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe') : 'claude');
  try { const codex = process.platform === 'win32' ? resolveWindowsCodex() : { command: 'codex', args: [] }; report.codex = { ...version(codex.command, [...codex.args, '--version']), command: codex.command }; }
  catch (error) { report.codex = { ok: false, error: String(error) }; }
  try {
    const scope = await allocateProcessScope();
    // A process that outlives the start check, stopped through the scope: proves confinement and confirmed stop.
    const launch = process.platform === 'win32' ? { command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), args: ['-n', '30', '127.0.0.1'] } : { command: '/bin/sleep', args: ['30'] };
    const child = await scope.start({ ...launch, cwd: workspacePath, env: process.env });
    const closed = new Promise(resolve => child.once('close', resolve));
    const stopped = await scope.stop();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    report.processScope = { ok: stopped && (child.exitCode !== null || child.signalCode !== null), stopConfirmed: stopped };
  } catch (error) { report.processScope = { ok: false, error: String(error) }; }
  return report;
}

export async function activate(ctx: ActivateContext) {
  const { workspacePath, dataDir, log, registerMcpTools } = ctx.services;
  await mkdir(dataDir, { recursive: true });
  let manager: Promise<RunManager> | undefined;
  const runs = () => manager ??= RunManager.open(workspacePath).catch(error => { manager = undefined; throw error; });
  // Which session started which run, so a run can later be traced back to the conversation that asked for it.
  const links = path.join(dataDir, 'session-runs.jsonl');
  const handlers = {
    ...sessionToolHandlers(runs, createEditorApi(workspacePath, runs), {
      onStart: async (runId, call) => {
        await appendFile(links, `${JSON.stringify({ runId, sessionId: call?.sessionId ?? null, caller: call?.caller ?? null, at: new Date().toISOString() })}\n`);
        log('info', `[neomind] started ${runId} for session ${call?.sessionId ?? 'none'}`);
      },
    }),
    probe: async () => probe(workspacePath),
  };
  const tools: ToolDefinition[] = [...SESSION_TOOLS, { name: 'probe', panelOnly: true, description: 'NeoMind panel: check what this backend can run on this machine.', inputSchema: { type: 'object', properties: {} } }]
    .map(tool => ({ ...tool, scope: 'global' as const }));
  await registerMcpTools(tools);

  const panelOnly = new Set(tools.filter(tool => tool.panelOnly).map(tool => tool.name));
  const methods: Record<string, (params: unknown, methodCtx: unknown) => Promise<unknown>> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = async (params, methodCtx) => {
      const call = methodCtx && typeof methodCtx === 'object' ? (methodCtx as { call?: SessionToolCall }).call : undefined;
      // The host already hides panel-only tools from agents; this keeps it true if that ever regresses.
      if (panelOnly.has(name) && call?.caller === 'agent') throw new Error(`${name} is only available to the NeoMind panel`);
      try { return await handler(params && typeof params === 'object' ? params as Record<string, unknown> : {}, call); }
      catch (error) { if (name !== 'api') log('warn', `[neomind] ${name} failed: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    };
  }
  return {
    methods,
    // Closing the workspace pauses the runs this process owns; their journals let the next start reconcile them.
    deactivate: async () => { if (manager) await (await manager).close(); },
  };
}
