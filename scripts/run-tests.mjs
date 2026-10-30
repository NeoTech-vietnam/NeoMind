// Run the compiled test suite with a private temporary root and remove it afterwards: tests create their fixtures with
// mkdtemp(os.tmpdir()), so pointing TEMP/TMP/TMPDIR at one directory lets a single removal clean them all up.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'neomind-test-'));
const patterns = process.argv.slice(2).length ? process.argv.slice(2) : ['dist/test/*.test.js'];
const result = spawnSync(process.execPath, ['--test', ...patterns], { stdio: 'inherit', env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
// Worker processes can hold files for a moment after the run on Windows; retry, and keep the directory rather than fail.
try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
catch (error) { console.error(`Test temp directory not removed: ${root} (${error instanceof Error ? error.message : String(error)})`); }
process.exitCode = result.status ?? 1;
