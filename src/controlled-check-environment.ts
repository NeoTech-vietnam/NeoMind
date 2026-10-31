import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import { legalProgram } from './controlled-runtime-context.js';

interface FrozenCheck { command: readonly string[]; negative_controls?: readonly { command: readonly string[] }[] }
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Derive a child-only DLL search path from the frozen compiler/output pipeline.
 * Other checks retain their inherited environment; no toolchain is guessed. */
export function controlledCheckEnvironment(root: string, command: readonly string[], checks: readonly FrozenCheck[],
  inherited: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> | undefined {
  if (platform !== 'win32' || !command.length) return undefined;
  const frozen = checks.flatMap(check => [check.command, ...(check.negative_controls ?? []).map(control => control.command)]);
  const positions = frozen.flatMap((candidate, index) => same(candidate, command) ? [index] : []);
  if (!positions.length) return undefined;
  const normalize = (path: string) => win32.resolve(root, path).toLowerCase();
  const compile = (argv: readonly string[]) => {
    const executable = argv[0];
    if (!executable || !win32.isAbsolute(executable) || !(legalProgram('c11', executable) || legalProgram('cpp17', executable))) return undefined;
    try { const file = lstatSync(executable); if (!file.isFile() || file.isSymbolicLink()) return undefined; } catch { return undefined; }
    const directory = win32.dirname(executable), outputs: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!;
      if (arg === '-o') { const output = argv[++index]; if (!output || output.startsWith('-')) return { directory }; outputs.push(output); }
      else if (arg.startsWith('-o') && arg.length > 2) outputs.push(arg.slice(2));
    }
    if (outputs.length !== 1) return { directory };
    const output = normalize(outputs[0]!), relative = win32.relative(normalize(root), output);
    if (!relative || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) return { directory };
    return { output, directory };
  };
  const ownCompiler = compile(command);
  const contexts = ownCompiler ? [[ownCompiler.directory]] : positions.map(current => frozen.slice(0, current).flatMap(argv => {
    const producer = compile(argv);
    return producer?.output === normalize(command[0]!) ? [producer.directory] : [];
  }));
  if (contexts.some(directories => !directories.length)) return undefined;
  const directories = contexts.flat();
  // An ambiguous output cannot select an arbitrary compiler installation.
  const unique = [...new Map(directories.map(directory => [normalize(directory), directory])).values()];
  if (unique.length !== 1) return undefined;
  const path = Object.entries(inherited).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return { PATH: `${unique[0]}${path ? `;${path}` : ''}` };
}
