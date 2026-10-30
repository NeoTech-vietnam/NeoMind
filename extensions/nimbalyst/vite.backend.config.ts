import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The backend module runs in an Electron utility process: one ES module with NeoMind's core and zod bundled in, Node
// built-ins left to the runtime.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: 'dist', emptyOutDir: false, target: 'node22', minify: false, sourcemap: true,
    lib: { entry: 'src/backend.ts', formats: ['es'], fileName: () => 'backend.js' },
    rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'node:sqlite'] },
  },
});
