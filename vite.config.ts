import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['mupdf'] },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true,
    // Build outputs: watching them makes Vite crawl thousands of files at startup.
    watch: { ignored: ['**/src-tauri/**', '**/crates/*/target/**', '**/graphify-out/**', '**/test-results/**', '**/dist/**'] },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
