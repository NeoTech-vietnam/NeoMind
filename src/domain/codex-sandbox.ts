export type CodexSandboxMode = 'enabled' | 'disabled';

export function codexThreadSandbox(mode: CodexSandboxMode, write: boolean): 'read-only' | 'workspace-write' | 'danger-full-access' {
  return mode === 'disabled' ? 'danger-full-access' : write ? 'workspace-write' : 'read-only';
}

export function codexSandboxPolicy(mode: CodexSandboxMode, writableRoots: string[]) {
  return mode === 'disabled' ? { type: 'dangerFullAccess' as const }
    : { type: 'workspaceWrite' as const, writableRoots, networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
}
