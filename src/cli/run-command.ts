export const runUsage = 'Usage: neomind run list <project> | preview <project> <flow> | start <project> <flow> "task" [--import-dirty HASH] [--workspace isolated|current|shared] | show|resume|pause|cancel|retry-git|include-imported|apply <project> <run-id> | clean <project> <run-id>|--all [--force] | approve <project> <run-id> --plan-hash HASH | changes <project> <run-id> --plan-hash HASH "feedback" | extend-time <project> <run-id> <seconds>';
type RunCommand =
  | { kind: 'list'; project: string }
  | { kind: 'show' | 'resume' | 'pause' | 'cancel' | 'retry-git' | 'include-imported' | 'apply'; project: string; runId: string }
  | { kind: 'clean'; project: string; runId?: string; force: boolean }
  | { kind: 'preview'; project: string; flowId: string; workspaceMode?: 'isolated' | 'current' | 'shared' }
  | { kind: 'start'; project: string; flowId: string; task: string; importDirty?: string; workspaceMode?: 'isolated' | 'current' | 'shared' }
  | { kind: 'approve'; project: string; runId: string; planHash: string }
  | { kind: 'changes'; project: string; runId: string; planHash: string; feedback: string }
  | { kind: 'extend-time'; project: string; runId: string; seconds: number };

/** Validate the whole command before any state is opened; undefined means a usage error. */
export function parseRunCommand(args: string[]): RunCommand | undefined {
  const [, kind, project, id, ...rest] = args;
  if (!kind || !project) return undefined;
  const planHash = (value: string | undefined) => value !== undefined && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  if (kind === 'list') return args.length === 3 ? { kind, project } : undefined;
  if (!id) return undefined;
  if (kind === 'clean' && rest.length <= 1 && (!rest.length || rest[0] === '--force')) return { kind, project, ...(id === '--all' ? {} : { runId: id }), force: rest[0] === '--force' };
  if (['show', 'resume', 'pause', 'cancel', 'retry-git', 'include-imported', 'apply'].includes(kind) && !rest.length) return { kind: kind as 'show', project, runId: id };
  if (kind === 'preview' || kind === 'start') {
    const task = kind === 'start' ? rest[0] : undefined;
    if (kind === 'start' && !task?.trim()) return undefined;
    const flags = kind === 'start' ? rest.slice(1) : rest;
    let importDirty: string | undefined, workspaceMode: 'isolated' | 'current' | 'shared' | undefined;
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i], value = flags[i + 1];
      if (key === '--import-dirty' && kind === 'start' && !importDirty && planHash(value)) importDirty = value;
      else if (key === '--workspace' && !workspaceMode && ['isolated', 'current', 'shared'].includes(value ?? '')) workspaceMode = value as typeof workspaceMode;
      else return undefined;
    }
    return kind === 'preview' ? { kind, project, flowId: id, ...(workspaceMode ? { workspaceMode } : {}) }
      : { kind, project, flowId: id, task: task!, ...(importDirty ? { importDirty } : {}), ...(workspaceMode ? { workspaceMode } : {}) };
  }
  if (kind === 'approve' && rest.length === 2 && rest[0] === '--plan-hash' && planHash(rest[1])) return { kind, project, runId: id, planHash: rest[1]! };
  if (kind === 'changes' && rest.length === 3 && rest[0] === '--plan-hash' && planHash(rest[1]) && rest[2]!.trim() && rest[2]!.length <= 10000)
    return { kind, project, runId: id, planHash: rest[1]!, feedback: rest[2]! };
  if (kind === 'extend-time' && rest.length === 1 && /^\d+$/.test(rest[0]!)) {
    const seconds = Number(rest[0]);
    if (seconds >= 1 && seconds <= 86400) return { kind, project, runId: id, seconds };
  }
  return undefined;
}
