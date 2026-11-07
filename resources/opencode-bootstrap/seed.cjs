// Each engine owns a mutable copy. Keep preparation off the editor loop, bound
// filesystem work, and drain in-flight copies before acknowledging cancellation.
const { parentPort, workerData } = require('node:worker_threads');
const { constants } = require('node:fs');
const { copyFile, lstat, mkdir, readdir, realpath, stat } = require('node:fs/promises');
const { join, relative, isAbsolute, sep } = require('node:path');

const concurrency = 8;
let failure;
const cancel = message => {
  if (message?.type === 'cancel') failure ??= Object.assign(new Error(), { code: 'BOOTSTRAP_COPY_CANCELLED' });
};
parentPort.on('message', cancel);
const inside = (root, path) => {
  const target = relative(root, path);
  return target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target);
};
const identity = path => process.platform === 'win32' ? path.toLowerCase() : path;

(async () => {
  try {
    const { source, destination } = workerData;
    const sourceRoot = await realpath(source), destinationRoot = await realpath(destination);
    if (inside(sourceRoot, destinationRoot) || inside(destinationRoot, sourceRoot)) throw new Error();
    const targetInfo = await lstat(destination);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error();
    const queue = ['package.json', 'package-lock.json', 'node_modules'].map(entry => ({
      source: join(sourceRoot, entry), destination: join(destinationRoot, entry), ancestors: [identity(sourceRoot)],
    }));
    let cursor = 0, active = 0;
    async function copy(entry) {
      if (failure) return;
      let path = entry.source, info = await lstat(path);
      if (failure) return;
      if (info.isSymbolicLink()) {
        path = await realpath(path);
        if (!inside(sourceRoot, path)) throw Object.assign(new Error(), { code: 'BOOTSTRAP_LINK_OUTSIDE' });
        info = await stat(path);
      }
      if (failure) return;
      if (info.isDirectory()) {
        const key = identity(path);
        if (entry.ancestors.includes(key)) throw new Error();
        // Exclusive creation rejects existing directories and redirecting links.
        await mkdir(entry.destination);
        if (failure) return;
        const children = await readdir(path);
        if (failure) return;
        const ancestors = [...entry.ancestors, key];
        for (const name of children) queue.push({ source: join(path, name), destination: join(entry.destination, name), ancestors });
      } else if (info.isFile()) {
        await copyFile(path, entry.destination, constants.COPYFILE_EXCL);
      } else throw new Error();
    }
    await new Promise((fulfill, reject) => {
      function schedule() {
        while (!failure && active < concurrency && cursor < queue.length) {
          const entry = queue[cursor++]; active++;
          copy(entry).catch(error => { failure ??= error; }).finally(() => { active--; schedule(); });
        }
        if (active === 0) {
          if (failure) reject(failure);
          else if (cursor === queue.length) fulfill();
        }
      }
      schedule();
    });
    if (failure) throw failure;
    parentPort.postMessage({ copied: true });
  } catch (error) {
    const code = ['BOOTSTRAP_LINK_OUTSIDE', 'BOOTSTRAP_COPY_CANCELLED'].includes(error?.code) ? error.code : 'BOOTSTRAP_COPY_FAILED';
    parentPort.postMessage({ copied: false, code });
    process.exitCode = 1;
  } finally {
    parentPort.off('message', cancel);
    parentPort.close();
  }
})();
