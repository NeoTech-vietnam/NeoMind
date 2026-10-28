import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { initialize, retryWindowsFileOperation } from '../../dist/storage.js';

/** Explicit historical fixture, before records exist. No dual roots or fake aliases. */
export function initializeLegacy(root, options = {}) {
  const config = initialize(root, { ...options, execution_engine: 'vscode-lm' });
  if (existsSync(join(root, '.workforce'))) retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  return config;
}
