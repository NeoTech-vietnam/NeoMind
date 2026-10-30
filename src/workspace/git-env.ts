/**
 * Git settings for every command NeoMind runs, passed through the environment so the user's repository config is never
 * changed. Run worktrees live under the state directory (a longer path than the checkout), so on Windows files deep in
 * the repository exceed MAX_PATH unless Git uses long paths.
 */
export const gitConfigEnv: Record<string, string> = process.platform === 'win32'
  ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' } : {};
