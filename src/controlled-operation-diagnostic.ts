import { lstatSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './storage.js';

export type ControlledDiagnosticPhase = 'assert-active' | 'request-encoding' | 'operation' | 'result-encoding' | 'host-dispatch';
const phases = new Set<string>(['assert-active', 'request-encoding', 'operation', 'result-encoding', 'host-dispatch']);
const operations = new Set(['runtime_context', 'project_read', 'project_list', 'project_search', 'task_file_write',
  'workflow_plan', 'work_prepare', 'check_run', 'check_evidence', 'task_run', 'procedure_run',
  'cornell_research_compile', 'assignment_report', 'open', 'run', 'poll', 'result', 'cancel', 'close']);
const classes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'AssertionError', 'ControlledToolError', 'ControlledPayloadError', 'ZodError']);
const filesystemCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EROFS',
  'EBUSY', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'ELOOP', 'EXDEV', 'EINVAL', 'ENOTEMPTY', 'EIO', 'EBADF', 'EFBIG']);
const diagnosticFile = fileURLToPath(import.meta.url), moduleDirectory = dirname(diagnosticFile);
const sourceDirectories = [resolve(moduleDirectory, '../src'), resolve(moduleDirectory, '../dist')];
const boundedText = 64000;
const comparablePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

function field(error: unknown, key: string): unknown {
  try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
function ownedFrames(stack: unknown): { module: string; line: number; column: number }[] {
  if (typeof stack !== 'string') return [];
  const frames: { module: string; line: number; column: number }[] = [];
  for (const line of stack.slice(0, boundedText).split(/\r?\n/).slice(0, 64)) {
    const match = line.match(/((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^()\r\n]*):(\d{1,9}):(\d{1,9})\)?\s*$/);
    if (!match) continue;
    try {
      const path = resolve(match[1]!.startsWith('file:') ? fileURLToPath(match[1]!) : match[1]!);
      const module = basename(path), folder = comparablePath(dirname(path));
      if (!/^[a-z0-9-]+\.(?:js|ts)$/.test(module) ||
          !sourceDirectories.some(directory => comparablePath(directory) === folder)) continue;
      // A stack string alone cannot declare a provider module to be first-party.
      const owned = join(moduleDirectory, module.replace(/\.(?:js|ts)$/, extname(diagnosticFile)));
      const stat = lstatSync(owned);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const lineNumber = Number(match[2]), column = Number(match[3]);
      if (lineNumber < 1 || column < 1) continue;
      frames.push({ module, line: lineNumber, column });
      if (frames.length === 8) break;
    } catch { /* Malformed locations and unavailable modules are omitted. */ }
  }
  return frames;
}
function summary(error: unknown) {
  const name = field(error, 'name'), code = field(error, 'code'), message = typeof error === 'string' ? error : field(error, 'message');
  return { error_class: typeof name === 'string' && classes.has(name) ? name : 'Error',
    fs_error_code: typeof code === 'string' && filesystemCodes.has(code) ? code : null,
    message_sha256: hash(typeof message === 'string' ? message.slice(0, boundedText) : 'Unclassified controlled operation failure'),
    frames: ownedFrames(field(error, 'stack')) };
}

/** Backend-only fixed metadata. Never retain exception messages, raw stacks, paths or provider payloads. */
export function controlledOperationDiagnostic(phase: ControlledDiagnosticPhase, tool: string, error: unknown) {
  const causes: ReturnType<typeof summary>[] = [], seen = new Set<unknown>([error]);
  let current = field(error, 'cause');
  while (current !== undefined && current !== null && causes.length < 3 && !seen.has(current)) {
    seen.add(current); causes.push(summary(current)); current = field(current, 'cause');
  }
  return { phase: phases.has(phase) ? phase : 'unclassified', tool: operations.has(tool) ? tool : 'unclassified',
    ...summary(error), causes };
}
