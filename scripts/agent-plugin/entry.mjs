import { runPlugin } from './server.mjs';

runPlugin().catch(() => {
  process.stderr.write('WorkForce Agent Plugin could not start. Use standalone Node.js 24+ and check the plugin installation.\n');
  process.exitCode = 1;
});
