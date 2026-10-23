import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initialize } from '../dist/storage.js';

// Historical suites exercise unchanged legacy paths and signed identities.
// migration.test.mjs and native-workflow.test.mjs cover fresh NeoMind storage.
export function initializeLegacy(root, options = {}) {
  mkdirSync(join(root, '.verythinker'), { recursive: true });
  return initialize(root, options);
}
