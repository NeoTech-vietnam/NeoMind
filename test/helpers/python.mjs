import { spawnSync } from 'node:child_process';

// Windows can expose a Microsoft Store python.exe shortcut before an installed
// interpreter. Resolve the launcher's actual executable, without changing PATH
// or downloading anything. An explicit PYTHON setting remains authoritative.
export function pythonExecutable() {
  const candidates = process.env.PYTHON ? [[process.env.PYTHON, []]] : process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-I', '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('Cornell validator tests require Python 3. Install Python or set PYTHON to its executable path.');
}
