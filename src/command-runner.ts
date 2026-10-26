import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface CommandInput {
  command: string[];
  cwd: string;
  signal?: AbortSignal;
  timeout_ms?: number;
  max_output_bytes?: number;
  /** Explicit approved variables, added to a minimal inherited toolchain environment. */
  env?: Record<string, string>;
  onStart?: (pid: number) => void;
  /** Bounded structured procedure input; never interpreted by a shell. */
  stdin?: string;
}
export interface CommandResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timed_out: boolean;
  output_limited: boolean;
  error: string | null;
  duration_ms: number;
}

export function commandEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const inherited = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ']);
  for (const [key, value] of Object.entries(process.env))
    if (inherited.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
        /^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GIT_.*)$/i.test(key))
      throw new Error('Command environment contains an invalid or executable-loader override.');
    const prior = Object.keys(environment).find(existing => existing.toUpperCase() === key.toUpperCase());
    if (prior) delete environment[prior];
    environment[key] = value;
  }
  return environment;
}

/** A mediated local process, not an operating-system filesystem or network sandbox. */
export async function runCommand(input: CommandInput): Promise<CommandResult> {
  if (!Array.isArray(input.command) || !input.command.length || !input.command[0]?.trim() ||
      input.command.some(argument => typeof argument !== 'string' || argument.includes('\0')))
    throw new Error('Command must be a non-empty executable and argument array.');
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) throw new Error('Command cwd must be absolute.');
  const timeout = input.timeout_ms ?? 60000, cap = input.max_output_bytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000)
    throw new Error('Command timeout must be between 1 and 600000 milliseconds.');
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 10 * 1024 * 1024)
    throw new Error('Command output limit must be between 1 byte and 10 MiB.');
  const env = commandEnvironment(input.env), started = Date.now();
  if (input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > 1024 * 1024))
    throw new Error('Command input exceeds one MiB.');
  const result: CommandResult = { exit_code: null, signal: null, stdout: '', stderr: '', cancelled: false,
    timed_out: false, output_limited: false, error: null, duration_ms: 0 };
  if (input.signal?.aborted) return { ...result, cancelled: true, error: 'Command cancelled before start.' };
  return await new Promise(resolveResult => {
    const child = spawn(input.command[0]!, input.command.slice(1), { cwd: input.cwd, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input.stdin);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, settled = false, stopping = false, killJob = Promise.resolve();
    let forceFinish: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => stop('timeout'), timeout);
    const finish = async (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(forceFinish); input.signal?.removeEventListener('abort', abort);
      await killJob;
      child.stdout.destroy(); child.stderr.destroy();
      const text = (chunks: Buffer[]) => {
        const bytes = Buffer.concat(chunks), decoder = new StringDecoder('utf8');
        // Invalid or truncated UTF-8 must not expand replacement characters beyond the byte cap.
        return decoder.write(Buffer.from(bytes.toString('utf8')).subarray(0, bytes.length));
      };
      resolveResult({ ...result, exit_code: code, signal, stdout: text(stdout),
        stderr: text(stderr), duration_ms: Date.now() - started });
    };
    function stop(reason: 'cancel' | 'timeout' | 'output' | 'callback'): void {
      if (settled || stopping) return; stopping = true;
      result.cancelled = reason === 'cancel'; result.timed_out = reason === 'timeout';
      result.output_limited = reason === 'output';
      result.error = { cancel: 'Command cancelled.', timeout: 'Command timeout exceeded.',
        output: 'Command output limit exceeded.', callback: 'Command ownership callback failed.' }[reason];
      if (child.pid && process.platform === 'win32') {
        killJob = new Promise<void>(done => {
          const killer = spawn(resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          let finished = false;
          const complete = () => { if (finished) return; finished = true; clearTimeout(deadline); done(); };
          const deadline = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); complete(); }, 1500);
          killer.on('error', () => { child.kill('SIGKILL'); complete(); });
          killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); complete(); });
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      // A descendant retaining inherited pipe handles cannot hold the owner forever.
      forceFinish = setTimeout(() => { void finish(null); }, 2000);
    }
    const abort = () => stop('cancel');
    function collect(chunk: Buffer, target: Buffer[]): void {
      if (settled) return;
      const available = Math.max(0, cap - bytes), kept = chunk.subarray(0, available);
      target.push(kept); bytes += kept.length;
      if (chunk.length > available) stop('output');
    }
    child.stdout.on('data', chunk => collect(Buffer.from(chunk), stdout));
    child.stderr.on('data', chunk => collect(Buffer.from(chunk), stderr));
    child.on('error', error => {
      result.error = `Command could not start (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`;
      void finish(null);
    });
    child.on('close', (code, signal) => { void finish(code, signal); });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    else if (child.pid && input.onStart) { try { input.onStart(child.pid); } catch { stop('callback'); } }
  });
}
