import { homedir } from 'node:os';
import path from 'node:path';
import type { AvailableRunnerModel, RunnerAccess } from '../runners/agent-runner.js';

/**
 * Claude Code permissions for one NeoMind turn, built only from CLI flags and a `--settings` document; user, project and
 * local settings are ignored. Access is enforced by Claude Code's own permission engine (not an OS sandbox), so
 * `verifyClaudeCapabilities` must prove these rules on the host before any write is granted.
 *
 * Rule syntax verified with Claude Code 2.1.312 on Windows (`dontAsk`, absolute Windows paths from the Write tool):
 * - `Write(src/**)` is relative to the working directory, matches nested files, not siblings such as `src2/`, and does
 *   not follow `..` or junctions out of the root; `Write(**)` covers the whole working directory and nothing outside.
 * - `[` and `]` are glob classes (`app/[slug]/**` matched `app/s/`) and must be escaped as `\[` `\]`.
 * - Absolute rules are `//c/Users/...` (lower-case drive, no colon); `//C:/Users/...` silently never matches.
 * - Writes to the auto-memory directory under the Claude config dir are allowed without any rule, even with
 *   `autoMemoryEnabled: false`, so the config dir is denied explicitly.
 */
export const CLAUDE_PROVIDER = 'anthropic';
export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] as const;
export type ClaudeModel = typeof CLAUDE_MODELS[number];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];
const aliases: Record<string, ClaudeModel> = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' };

const readTools = ['Read', 'Glob', 'Grep'], writeTools = [...readTools, 'Write', 'Edit'];
/** Added by Claude Code when a turn passes `--json-schema`. */
export const CLAUDE_STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
export const CLAUDE_DENIED_TOOLS = ['WebFetch', 'WebSearch', 'Task', 'Agent'];
/** Delegation, shell and network tools; none may appear in a NeoMind session's init inventory. */
export const CLAUDE_FORBIDDEN_TOOLS = [...CLAUDE_DENIED_TOOLS, 'Bash', 'PowerShell', 'BashOutput', 'KillShell', 'NotebookEdit'];

export interface ClaudeSettings { autoMemoryEnabled: false; permissions: { allow: string[]; deny: string[] } }
export interface ClaudePolicyInput { workspace: string; access: RunnerAccess; model: string; effort: string; configDir?: string }

/** Resolve an allowlisted model or alias to the full id `system/init` must report. */
export function claudeModel(model: string): ClaudeModel {
  const resolved = aliases[model] ?? model;
  if (!(CLAUDE_MODELS as readonly string[]).includes(resolved)) throw new Error(`Claude model is not allowed: ${model}`);
  return resolved as ClaudeModel;
}

/** Binding reasoning maps one-to-one to `--effort`; anything else is refused rather than approximated. */
export function claudeEffort(reasoning: string): ClaudeEffort {
  if (!(CLAUDE_EFFORTS as readonly string[]).includes(reasoning)) throw new Error(`Claude effort is not supported: ${reasoning}`);
  return reasoning as ClaudeEffort;
}

export function claudeRunnerModels(): AvailableRunnerModel[] {
  return CLAUDE_MODELS.map(model => ({ runner: 'claude-code', provider: CLAUDE_PROVIDER, model, reasoning: [...CLAUDE_EFFORTS] }));
}

export function claudeTools(access: RunnerAccess): string[] { return access.kind === 'write' ? [...writeTools] : [...readTools]; }

/** The exact, sorted tool inventory `system/init` must report for a turn. */
export function claudeExpectedTools(access: RunnerAccess, structured: boolean): string[] {
  return [...claudeTools(access), ...structured ? [CLAUDE_STRUCTURED_OUTPUT_TOOL] : []].sort();
}

/** `CLAUDE_CONFIG_DIR` or `~/.claude`; `claude auth status` reports the same value as `configDirectory`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
}

/** Allow patterns (without the tool name) for writable roots, relative to the workspace (the turn's cwd). */
export function claudeWriteScopes(workspace: string, writableRoots: string[]): string[] {
  if (!writableRoots.length) throw new Error('Claude write access requires at least one writable root');
  const scopes = writableRoots.map(root => {
    const relative = path.relative(path.resolve(workspace), path.resolve(workspace, root));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Writable root escapes the workspace: ${root}`);
    if (!relative) return '**';
    const pattern = relative.split(path.sep).join('/');
    // Only bracket escaping is verified; other glob or rule syntax in a directory name is refused.
    if (/[*?{}()!\\\0-\x1f]/.test(pattern) || pattern.startsWith('~') || pattern.startsWith('#')) throw new Error(`Writable root cannot be expressed as a Claude rule: ${root}`);
    return `${pattern.replace(/[[\]]/g, '\\$&')}/**`;
  });
  return [...new Set(scopes)];
}

/** An absolute path as a Claude permission pattern: `//c/Users/...` on Windows, `//home/...` elsewhere. */
export function claudeAbsolutePattern(directory: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(path.win32.resolve(directory));
    if (!match) throw new Error(`Directory cannot be expressed as a Claude rule: ${directory}`);
    const rest = match[2]!.replaceAll('\\', '/').replace(/\/$/, '');
    if (/[*?{}()!\0-\x1f]/.test(rest)) throw new Error(`Directory cannot be expressed as a Claude rule: ${directory}`);
    return `//${match[1]!.toLowerCase()}/${rest.replace(/[[\]]/g, '\\$&')}`.replace(/\/$/, '');
  }
  const resolved = path.posix.resolve(directory);
  if (/[*?{}()!\\\0-\x1f]/.test(resolved)) throw new Error(`Directory cannot be expressed as a Claude rule: ${directory}`);
  return `/${resolved.replace(/[[\]]/g, '\\$&')}`.replace(/\/$/, '');
}

export function claudeSettings(workspace: string, access: RunnerAccess, configDir = claudeConfigDir()): ClaudeSettings {
  const config = `${claudeAbsolutePattern(configDir)}/**`;
  const allow = access.kind === 'write' ? claudeWriteScopes(workspace, access.writableRoots).flatMap(scope => [`Write(${scope})`, `Edit(${scope})`]) : [];
  return { autoMemoryEnabled: false, permissions: { allow, deny: [...CLAUDE_DENIED_TOOLS, `Write(${config})`, `Edit(${config})`] } };
}

/**
 * Permission, model and effort flags for one `claude -p` turn whose cwd is `workspace`. Transport flags (`-p`,
 * `--output-format`, `--session-id`/`--resume`, `--json-schema`) belong to the CLI adapter.
 */
export function claudePolicyArgs(input: ClaudePolicyInput): string[] {
  return ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk',
    '--tools', claudeTools(input.access).join(','), '--settings', JSON.stringify(claudeSettings(input.workspace, input.access, input.configDir)),
    '--model', claudeModel(input.model), '--effort', claudeEffort(input.effort)];
}

/**
 * The parent environment without Claude Code session variables: a NeoMind started from inside Claude Code would
 * otherwise pass its own session, effort (`CLAUDE_EFFORT`) and feature switches (tasks, agent teams) to the worker.
 * `CLAUDE_CONFIG_DIR` is kept because login and the denied config dir depend on it.
 */
export function claudeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/^CLAUDE/i.test(key) || key.toUpperCase() === 'CLAUDE_CONFIG_DIR'));
}
