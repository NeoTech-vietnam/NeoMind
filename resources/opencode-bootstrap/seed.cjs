// Each engine owns a mutable copy. Run the synchronous filesystem traversal in
// a worker so the editor can process MCP traffic and cancel preparation.
const { parentPort, workerData } = require('node:worker_threads');
const { cpSync, lstatSync, realpathSync } = require('node:fs');
const { join, relative, isAbsolute, sep } = require('node:path');

try {
  const { source, destination } = workerData;
  for (const entry of ['package.json', 'package-lock.json', 'node_modules']) {
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true, dereference: true, errorOnExist: true, force: false,
      filter(path) {
        if (lstatSync(path).isSymbolicLink()) {
          const target = relative(source, realpathSync(path));
          if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target))
            throw Object.assign(new Error(), { code: 'BOOTSTRAP_LINK_OUTSIDE' });
        }
        return true;
      },
    });
  }
  parentPort.postMessage({ copied: true });
} catch (error) {
  parentPort.postMessage({ copied: false, code: error?.code === 'BOOTSTRAP_LINK_OUTSIDE' ? error.code : 'BOOTSTRAP_COPY_FAILED' });
  process.exitCode = 1;
}
