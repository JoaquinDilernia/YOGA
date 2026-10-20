import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  // caché fuera de Dropbox
  cacheDir: path.join(os.tmpdir(), 'vitest-turnos-yoga'),
  test: { include: ['test/**/*.test.js'], testTimeout: 20000 },
});
