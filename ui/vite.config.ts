import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** Web build for `langflow web`: relative asset paths, output into the Python package (served from src/langflow/webui/). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('src', import.meta.url)) } },
  build: { outDir: '../src/langflow/webui', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  // `npm run dev` talks to a running `langflow web --port 8765` (token: add ?token=… to the page URL), or to the mock with ?mock.
  server: { port: 5178, proxy: { '/api': 'http://127.0.0.1:8765' } },
});
