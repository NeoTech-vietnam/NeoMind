import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyAgentProfiles as agentProfiles } from './agent-profiles.js';
import { atomicWrite, readConfig, safePath, withOperationLock } from './storage.js';
import type { ManagedOutput, Platform } from './adapters.js';

export const hookTtlMs = 300_000;
export interface NativeHookObservation {
  schema_version: 1;
  project_id: string;
  id: string;
  session: string;
  parent_agent: string | null;
  client: 'copilot' | 'codex';
  profile_id: string;
  role: string;
  event: 'start' | 'tool' | 'stop';
  state: 'running' | 'idle';
  observed_at: string;
}
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{64}$/;
const directory = '.neomind/runs/native-hooks';
function bounded(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}
function profileFor(value: unknown) {
  const name = bounded(value)?.toLowerCase().replace(/^neomind[- ]/, '').replace(/ agent$/, '');
  return agentProfiles.find(profile => profile.id === name);
}
function inProject(root: string, cwd: unknown): boolean {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  try {
    const canonical = (path: string) => {
      const value = realpathSync.native(path);
      return process.platform === 'win32' ? value.toLowerCase() : value;
    };
    const path = relative(canonical(root), canonical(cwd));
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  } catch { return false; }
}
function validObservation(value: NativeHookObservation, project: string, id: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = agentProfiles.find(item => item.id === value.profile_id);
  return Object.keys(value).every(field => ['schema_version', 'project_id', 'id', 'session', 'parent_agent',
    'client', 'profile_id', 'role', 'event', 'state', 'observed_at'].includes(field)) &&
    value.schema_version === 1 && value.project_id === project && value.id === id && idPattern.test(value.id) &&
    idPattern.test(value.session) && (value.parent_agent === null || idPattern.test(value.parent_agent)) &&
    ['copilot', 'codex'].includes(value.client) && !!profile && profile.modelRole === value.role &&
    ['start', 'tool', 'stop'].includes(value.event) && value.state === (value.event === 'stop' ? 'idle' : 'running') &&
    typeof value.observed_at === 'string' && Number.isFinite(Date.parse(value.observed_at));
}
/** Record only lifecycle metadata. Payload prompts, results, transcript paths and credentials are discarded. */
export function observeNativeHook(root: string, client: 'copilot' | 'codex', value: unknown,
  eventName?: string): { status: 'recorded' | 'ignored'; reason?: string; observation?: NativeHookObservation } {
  if (!['copilot', 'codex'].includes(client)) throw new Error('Unknown native hook client.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'ignored', reason: 'Malformed hook payload.' };
  const data = value as Record<string, unknown>;
  const name = bounded(eventName ?? data.hook_event_name)?.toLowerCase();
  const event = name === 'subagentstart' ? 'start' : ['subagentstop', 'stop', 'sessionend'].includes(name ?? '') ? 'stop'
    : ['posttooluse', 'pretooluse', 'posttoolusefailure'].includes(name ?? '') ? 'tool' : null;
  const sessionId = bounded(data.session_id ?? data.sessionId), agentId = bounded(data.agent_id ?? data.agentId);
  if (!event || !sessionId || !agentId) return { status: 'ignored', reason: 'Event lacks an unambiguous session and agent identity.' };
  // Hook configuration supplies root explicitly. A payload cannot redirect writes to another project.
  if (data.cwd !== undefined && !inProject(root, data.cwd))
    return { status: 'ignored', reason: 'Hook belongs to another working directory.' };
  const project = readConfig(root).project_id, session = key(`${client}\0${sessionId}`), id = key(`${client}\0${sessionId}\0${agentId}`);
  return withOperationLock(root, 'native-hooks', () => {
    const path = safePath(root, `${directory}/${id}.json`);
    let previous: NativeHookObservation | undefined;
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Unsafe hook observation file.');
      previous = JSON.parse(readFileSync(path, 'utf8'));
      if (!previous || !validObservation(previous, project, id)) throw new Error('Invalid saved hook observation.');
    }
    const profile = profileFor(data.agent_type ?? data.agentType ?? data.agent_name ?? data.agentName) ??
      agentProfiles.find(item => item.id === previous?.profile_id);
    if (!profile) return { status: 'ignored' as const, reason: 'This is not an identified NeoMind profile.' };
    if (previous && (previous.project_id !== project || previous.id !== id || previous.profile_id !== profile.id))
      return { status: 'ignored' as const, reason: 'Hook identity conflicts with the saved observation.' };
    const parent = bounded(data.parent_agent_id ?? data.parentAgentId);
    const observation: NativeHookObservation = { schema_version: 1, project_id: project, id, session,
      parent_agent: parent ? key(`${client}\0${sessionId}\0${parent}`) : previous?.parent_agent ?? null,
      client, profile_id: profile.id, role: profile.modelRole, event,
      state: event === 'stop' ? 'idle' : 'running', observed_at: new Date().toISOString() };
    atomicWrite(path, JSON.stringify(observation) + '\n');
    return { status: 'recorded' as const, observation };
  }, 5000);
}

export function readNativeHooks(root: string): { observations: (NativeHookObservation & { expired: boolean })[]; invalid: number; omitted: number } {
  const result = { observations: [] as (NativeHookObservation & { expired: boolean })[], invalid: 0, omitted: 0 };
  const project = readConfig(root).project_id, base = safePath(root, directory);
  if (!existsSync(base)) return result;
  if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return { ...result, invalid: 1 };
  const files: { name: string; time: number }[] = [];
  for (const name of readdirSync(base).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const stat = lstatSync(safePath(root, `${directory}/${name}`));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe observation.');
      files.push({ name, time: stat.mtimeMs });
    } catch { result.invalid++; }
  }
  files.sort((a, b) => b.time - a.time);
  result.omitted = Math.max(0, files.length - 128);
  for (const { name } of files.slice(0, 128)) {
    try {
      const path = safePath(root, `${directory}/${name}`), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Unsafe observation.');
      const value = JSON.parse(readFileSync(path, 'utf8')) as NativeHookObservation;
      if (!validObservation(value, project, name.slice(0, -5))) throw new Error('Invalid observation.');
      const age = Date.now() - Date.parse(value.observed_at);
      result.observations.push({ ...value, expired: age >= hookTtlMs || age < -60000 });
    } catch { result.invalid++; }
  }
  return result;
}

/** Absolute, shell-quoted commands also work when the native client starts in a project subdirectory. */
export function nativeHookOutputs(root: string, platforms: Platform[]): ManagedOutput[] {
  const outputs: ManagedOutput[] = [], cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const events = ['SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop'];
  for (const client of ['copilot', 'codex'] as const) {
    if (!platforms.includes(client)) continue;
    const wrapper = `.neomind/hooks/${client}.cjs`;
    outputs.push({ path: wrapper, kind: 'file', content:
      `// NeoMind lifecycle observer. No transcript or tool content is persisted.\n` +
      `const {spawnSync}=require('node:child_process');\n` +
      `const chunks=[];let bytes=0;process.stdin.on('data',chunk=>{bytes+=chunk.length;if(bytes<=65536)chunks.push(chunk);});\n` +
      `process.stdin.on('end',()=>{if(bytes>65536)return;spawnSync(process.execPath,${JSON.stringify([cli, 'activity', 'hook', '--project', resolve(root), '--provider', client])}.concat(['--event',process.argv[2]||'']),{input:Buffer.concat(chunks),stdio:['pipe','ignore','ignore'],windowsHide:true,timeout:8000});});\n` });
    const hooks = Object.fromEntries(events.map(event => {
      const absolute = resolve(root, wrapper);
      const command = `node '${absolute.replaceAll("'", "'\\''")}' ${event}`;
      const windowsScript = `& node '${absolute.replaceAll("'", "''")}' ${event}`;
      const windows = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsScript, 'utf16le').toString('base64')}`;
      return [event, client === 'codex' ? [{ hooks: [{ type: 'command', command, commandWindows: windows, timeout: 10 }] }]
        : [{ type: 'command', command, bash: command, powershell: windowsScript,
          windows, linux: command, osx: command, timeout: 10, timeoutSec: 10 }]];
    }));
    outputs.push({ path: client === 'codex' ? '.codex/hooks.json' : '.github/hooks/neomind.json',
      kind: 'file', content: JSON.stringify(client === 'copilot' ? { version: 1, hooks } : { hooks }, null, 2) + '\n' });
  }
  return outputs;
}
