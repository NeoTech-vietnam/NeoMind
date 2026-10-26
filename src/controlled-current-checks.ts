/** Keep the last receipt for each unique frozen title in one selected attempt.
 * Select before validating: a newer failure or wrong identity must never expose
 * an older pass. Journal order is authoritative; timestamps are not reordered. */
export function latestControlledChecks<T extends { attempt_id: string; title: string }>(checks: readonly T[], attemptId: string): T[] {
  const selected = new Map<string, T>();
  for (const check of checks) if (check.attempt_id === attemptId) selected.set(check.title, check);
  return [...selected.values()];
}
export function controlledCheckMatches(check: { negative: boolean; command: string[]; planned_command?: string[]; expected_exit_code: number },
  expected: { negative: boolean; command: string[]; expected_exit_code?: number }): boolean {
  return check.negative === expected.negative && check.expected_exit_code === (expected.expected_exit_code ?? 0) &&
    JSON.stringify(check.planned_command ?? check.command) === JSON.stringify(expected.command);
}
