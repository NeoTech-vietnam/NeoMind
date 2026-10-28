// Calls the already-running review driver. Never authorizes a model request itself.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(join(repository, 'artifacts/workforce-client-driver/config.json'), 'utf8'));
const control = JSON.parse(readFileSync(join(config.output_directory, 'control.json'), 'utf8'));
const action = process.argv[2] ?? 'status'; if (!['status', 'inspect', 'run-once', 'capture'].includes(action)) throw new Error('Use status|inspect|run-once|capture.');
const response = await fetch(`${control.url}/${action}`, { method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: control.authorization } });
console.log(JSON.stringify(await response.json(), null, 2)); if (!response.ok) process.exitCode = 1;
