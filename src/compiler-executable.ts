import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

const standardDriver = /^(?:gcc|g\+\+|clang|clang\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i;
const environmentValue = (env: NodeJS.ProcessEnv, name: string) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? '';

export function isBareWindowsCompilerCommand(program: string): boolean {
  return process.platform === 'win32' && !isAbsolute(program) && program === basename(program) && standardDriver.test(program);
}

/** Existing conventional MSYS2 locations, never a download or a discovery shell. */
export function installedWindowsCompilerCandidates(programs: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredDrive = environmentValue(env, 'SYSTEMDRIVE');
  const drive = /^[a-z]:$/i.test(configuredDrive) ? configuredDrive : 'C:';
  return ['ucrt64', 'mingw64', 'clang64'].flatMap(distribution => programs.filter(program => standardDriver.test(program))
    .map(program => `${drive}/msys64/${distribution}/bin/${program.replace(/\.exe$/i, '')}.exe`));
}

/** Resolve only the requested bare native compiler driver. Explicit paths,
 * cross-compilers, unknown programs and every POSIX launch retain their argv. */
export function resolveWindowsCompilerExecutable(program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isBareWindowsCompilerCommand(program)) return;
  const filename = `${program.replace(/\.exe$/i, '')}.exe`;
  const candidates = [
    ...environmentValue(env, 'PATH').split(delimiter).filter(isAbsolute).map(directory => join(directory, filename)),
    ...installedWindowsCompilerCandidates([program], env),
  ];
  for (const candidate of candidates) try {
    if (!statSync(candidate).isFile()) continue;
    accessSync(candidate, constants.X_OK);
    // Retain a clang++ alias: its argv[0] selects the C++ driver even when the
    // underlying installed file is shared with clang.
    return resolve(candidate);
  } catch { /* An unavailable exact driver cannot select another compiler. */ }
  return;
}
