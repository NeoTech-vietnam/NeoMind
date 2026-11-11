import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AvailableRunnerModel } from './agent-runner.js';

/** Remove JSONC comments and trailing commas without changing quoted strings. */
function parseConfig(text: string): Record<string, unknown> {
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!, next = text[i + 1];
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; clean += char; continue; }
    if (char === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; continue; }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Invalid OpenCode configuration');
      i = end + 1; clean += ' '; continue;
    }
    if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    clean += char;
  }
  try {
    const result = JSON.parse(clean) as unknown;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new Error('Invalid OpenCode configuration'); }
}

/** Copy only provider configuration, never project agents, MCP servers or plugins. */
export async function readOpenCodeProviderConfig(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const configRoot = path.join(env.XDG_CONFIG_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.config'), 'opencode');
  const result: Record<string, unknown> = {};
  const merge = (input: Record<string, unknown>) => {
    for (const key of ['provider', 'enabled_providers', 'disabled_providers']) {
      if (!(key in input)) continue;
      const value = input[key];
      if (key === 'provider' && value && typeof value === 'object' && !Array.isArray(value)) result.provider = { ...(result.provider as Record<string, unknown> ?? {}), ...value };
      else result[key] = value;
    }
  };
  for (const file of [path.join(configRoot, 'opencode.json'), path.join(configRoot, 'opencode.jsonc'), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])]) {
    try { merge(parseConfig(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read OpenCode provider configuration'); }
  }
  if (env.OPENCODE_CONFIG_CONTENT) merge(parseConfig(env.OPENCODE_CONFIG_CONTENT));
  return result;
}

/** Only connected providers returned by OpenCode are eligible for selection. */
export function openCodeModels(response: unknown): AvailableRunnerModel[] {
  if (!response || typeof response !== 'object') throw new Error('Invalid OpenCode provider response');
  const { all, connected } = response as { all?: unknown; connected?: unknown };
  if (!Array.isArray(all) || !Array.isArray(connected) || !connected.every(id => typeof id === 'string')) throw new Error('Invalid OpenCode provider response');
  const models: AvailableRunnerModel[] = [];
  for (const provider of all) {
    if (!provider || typeof provider !== 'object') continue;
    const { id, models: entries } = provider as { id?: unknown; models?: unknown };
    if (typeof id !== 'string' || !connected.includes(id) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [model, info] of Object.entries(entries)) {
      if (!model || !info || typeof info !== 'object') continue;
      const variants = (info as { variants?: unknown }).variants;
      const reasoning = variants && typeof variants === 'object' && !Array.isArray(variants) ? Object.keys(variants) : [];
      models.push({ runner: 'opencode', provider: id, model, reasoning: reasoning.length ? reasoning : ['medium'] });
    }
  }
  return models;
}
