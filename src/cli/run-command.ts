import { readFile } from 'node:fs/promises';

export const runUsage = 'Usage: neomind run list <project> | preview <project> <flow> | start <project> <flow> "task"|--task-file <file> [--import-dirty HASH] [--workspace isolated|current|shared] | show|resume|pause|cancel|retry-git|include-imported|apply <project> <run-id> | plan <project> <run-id> [--out <file>] | clean <project> <run-id>|--all [--force] | approve <project> <run-id> --plan-hash HASH | changes <project> <run-id> --plan-hash HASH "feedback"|--feedback-file <file> | extend-time <project> <run-id> <seconds> [--tokens N] | extend-time <project> <run-id> --tokens N | stats <project> [--flow ID] [--json|--csv]';
type WorkspaceMode = 'isolated' | 'current' | 'shared';
type RunCommand =
  | { kind: 'list'; project: string }
  | { kind: 'stats'; project: string; flowId?: string; format: 'table' | 'json' | 'csv' }
  | { kind: 'show' | 'resume' | 'pause' | 'cancel' | 'retry-git' | 'include-imported' | 'apply'; project: string; runId: string }
  | { kind: 'plan'; project: string; runId: string; out?: string }
  | { kind: 'clean'; project: string; runId?: string; force: boolean }
  | { kind: 'preview'; project: string; flowId: string; workspaceMode?: WorkspaceMode }
  | ({ kind: 'start'; project: string; flowId: string; importDirty?: string; workspaceMode?: WorkspaceMode } & ({ task: string } | { taskFile: string }))
  | { kind: 'approve'; project: string; runId: string; planHash: string }
  | ({ kind: 'changes'; project: string; runId: string; planHash: string } & ({ feedback: string } | { feedbackFile: string }))
  | { kind: 'extend-time'; project: string; runId: string; seconds: number; tokens?: number };
type Resolved<T> = T extends { taskFile: string } ? Omit<T, 'taskFile'> & { task: string } : T extends { feedbackFile: string } ? Omit<T, 'feedbackFile'> & { feedback: string } : T;
export type ResolvedRunCommand = Resolved<RunCommand>;

const maxFeedbackLength = 10000;

/** Validate the whole command before any state is opened; undefined means a usage error. */
export function parseRunCommand(args: string[]): RunCommand | undefined {
  const [, kind, project, id, ...rest] = args;
  if (!kind || !project) return undefined;
  const planHash = (value: string | undefined) => value !== undefined && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  if (kind === 'list') return args.length === 3 ? { kind, project } : undefined;
  if (kind === 'stats') {
    let flowId: string | undefined, format: 'table' | 'json' | 'csv' = 'table';
    const flags = args.slice(3);
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--flow' && !flowId && flags[i + 1]?.trim()) flowId = flags[++i];
      else if ((flags[i] === '--json' || flags[i] === '--csv') && format === 'table') format = flags[i] === '--json' ? 'json' : 'csv';
      else return undefined;
    }
    return { kind, project, format, ...(flowId ? { flowId } : {}) };
  }
  if (!id) return undefined;
  if (kind === 'clean' && rest.length <= 1 && (!rest.length || rest[0] === '--force')) return { kind, project, ...(id === '--all' ? {} : { runId: id }), force: rest[0] === '--force' };
  if (['show', 'resume', 'pause', 'cancel', 'retry-git', 'include-imported', 'apply'].includes(kind) && !rest.length) return { kind: kind as 'show', project, runId: id };
  if (kind === 'plan' && (!rest.length || (rest.length === 2 && rest[0] === '--out' && rest[1]!.trim()))) return { kind, project, runId: id, ...(rest.length ? { out: rest[1]! } : {}) };
  if (kind === 'preview' || kind === 'start') {
    // A start task is either the first argument or --task-file, never both: the file exists because shells cut multi-line arguments.
    const task = kind === 'start' && !rest[0]?.startsWith('--') ? rest[0] : undefined;
    if (task !== undefined && !task.trim()) return undefined;
    const flags = task !== undefined ? rest.slice(1) : rest;
    let importDirty: string | undefined, workspaceMode: WorkspaceMode | undefined, taskFile: string | undefined;
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i], value = flags[i + 1];
      if (key === '--import-dirty' && kind === 'start' && !importDirty && planHash(value)) importDirty = value;
      else if (key === '--workspace' && !workspaceMode && ['isolated', 'current', 'shared'].includes(value ?? '')) workspaceMode = value as WorkspaceMode;
      else if (key === '--task-file' && kind === 'start' && task === undefined && taskFile === undefined && value?.trim()) taskFile = value;
      else return undefined;
    }
    const options = { ...(importDirty ? { importDirty } : {}), ...(workspaceMode ? { workspaceMode } : {}) };
    if (kind === 'preview') return { kind, project, flowId: id, ...(workspaceMode ? { workspaceMode } : {}) };
    if (task !== undefined) return { kind, project, flowId: id, task, ...options };
    return taskFile !== undefined ? { kind, project, flowId: id, taskFile, ...options } : undefined;
  }
  if (kind === 'approve' && rest.length === 2 && rest[0] === '--plan-hash' && planHash(rest[1])) return { kind, project, runId: id, planHash: rest[1]! };
  if (kind === 'changes' && rest.length === 3 && rest[0] === '--plan-hash' && planHash(rest[1]) && rest[2] !== '--feedback-file' && rest[2]!.trim() && rest[2]!.length <= maxFeedbackLength)
    return { kind, project, runId: id, planHash: rest[1]!, feedback: rest[2]! };
  if (kind === 'changes' && rest.length === 4 && rest[0] === '--plan-hash' && planHash(rest[1]) && rest[2] === '--feedback-file' && rest[3]!.trim())
    return { kind, project, runId: id, planHash: rest[1]!, feedbackFile: rest[3]! };
  if (kind === 'extend-time' && rest.length === 1 && /^\d+$/.test(rest[0]!)) {
    const seconds = Number(rest[0]);
    if (seconds >= 1 && seconds <= 86400) return { kind, project, runId: id, seconds };
  }
  // `--tokens N` adds to the token budget, alone (seconds 0) or with more time.
  if (kind === 'extend-time' && (rest.length === 2 || rest.length === 3) && rest.at(-2) === '--tokens' && /^\d+$/.test(rest.at(-1)!) && (rest.length === 2 || /^\d+$/.test(rest[0]!))) {
    const seconds = rest.length === 3 ? Number(rest[0]) : 0, tokens = Number(rest.at(-1));
    if (seconds <= 86400 && tokens >= 1 && tokens <= 1_000_000_000) return { kind, project, runId: id, seconds, tokens };
  }
  return undefined;
}

/** Read --task-file/--feedback-file as UTF-8, applying the same limits as inline text; undefined means a usage error. */
export async function readRunCommandInput(command: RunCommand): Promise<ResolvedRunCommand | undefined> {
  // Editors on Windows often save UTF-8 with a byte order mark; it is not part of the text.
  const read = async (file: string) => (await readFile(file, 'utf8')).replace(/^﻿/, '');
  if (command.kind === 'start' && 'taskFile' in command) {
    const { taskFile, ...rest } = command, task = await read(taskFile);
    return task.trim() ? { ...rest, task } : undefined;
  }
  if (command.kind === 'changes' && 'feedbackFile' in command) {
    const { feedbackFile, ...rest } = command, feedback = await read(feedbackFile);
    return feedback.trim() && feedback.length <= maxFeedbackLength ? { ...rest, feedback } : undefined;
  }
  return command as ResolvedRunCommand;
}
