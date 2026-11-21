import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
// The langflow UI (../../ui/src) when it exists, else a plain stand-in on the same API.
const uiSrc = here('../../ui/src/');
const entry = existsSync(`${uiSrc}App.tsx`) ? here('src/ui-entry.ts') : here('src/placeholder/entry.tsx');

// The panel bundle: React and the host runtime are provided by Nimbalyst and must not be bundled.
export default defineConfig({
  root: here('.'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: [
    { find: /^langflow-ui-entry$/, replacement: entry },
    { find: /^@\//, replacement: uiSrc },
    // React Flow's store pulls in CommonJS use-sync-external-store, whose require('react') fails in the panel runtime.
    { find: /^use-sync-external-store\/shim\/with-selector(\.js)?$/, replacement: here('src/shims/with-selector.js') },
    { find: /^use-sync-external-store\/shim(\/index\.js)?$/, replacement: here('src/shims/use-sync-external-store-shim.js') },
  ] },
  build: {
    outDir: 'dist', emptyOutDir: true, minify: false, sourcemap: true,
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', /^@nimbalyst\//] },
  },
});
