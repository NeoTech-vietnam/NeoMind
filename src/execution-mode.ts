/** Saved execution semantics. Keep this module dependency-free for storage and gate checks. */
export const executionModes = ['strict', 'lightweight', 'copilot-native', 'codex-native', 'neomind-controlled'] as const;
export type ExecutionMode = (typeof executionModes)[number];
export type NativeExecutionMode = 'copilot-native' | 'codex-native';
export type NativeClient = 'copilot' | 'codex';

export function isNativeExecutionMode(value: unknown): value is NativeExecutionMode {
  return value === 'copilot-native' || value === 'codex-native';
}

/** Legacy records without a recognized native marker retain strict assurance and gates. */
export function savedWorkflowExecutionMode(data: Record<string, unknown>): ExecutionMode {
  if (data.kind === 'lightweight-workflow') return 'lightweight';
  if (data.execution_mode === 'neomind-controlled') return 'neomind-controlled';
  return isNativeExecutionMode(data.execution_mode) ? data.execution_mode : 'strict';
}

export function nativeClientForMode(mode: NativeExecutionMode): NativeClient {
  return mode === 'codex-native' ? 'codex' : 'copilot';
}
