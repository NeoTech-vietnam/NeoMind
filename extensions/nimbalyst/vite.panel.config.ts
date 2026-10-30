import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The panel bundle: React and the host runtime are provided by Nimbalyst and must not be bundled.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // React Flow's store pulls in CommonJS use-sync-external-store, whose require('react') fails in the panel runtime.
  resolve: { alias: [
    { find: /^use-sync-external-store\/shim\/with-selector(\.js)?$/, replacement: fileURLToPath(new URL('src/shims/with-selector.js', import.meta.url)) },
    { find: /^use-sync-external-store\/shim(\/index\.js)?$/, replacement: fileURLToPath(new URL('src/shims/use-sync-external-store-shim.js', import.meta.url)) },
  ] },
  build: {
    outDir: 'dist', emptyOutDir: true, minify: false, sourcemap: true,
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', /^@nimbalyst\//] },
  },
});
