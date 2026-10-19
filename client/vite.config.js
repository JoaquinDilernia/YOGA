import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // caché fuera de Dropbox
  cacheDir: path.join(os.tmpdir(), 'vite-turnos-yoga'),
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
