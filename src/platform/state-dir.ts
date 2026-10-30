import { homedir } from 'node:os';
import path from 'node:path';

/** Per-user state base: XDG_STATE_HOME when set, otherwise the platform's local (non-roaming) state location. */
export function stateBase(): string {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(homedir(), '.local/state');
}
