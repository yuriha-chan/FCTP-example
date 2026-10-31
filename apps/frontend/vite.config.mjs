import { URL, fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../../dist/frontend', import.meta.url));

export default defineConfig({
  root,
  build: { target: 'es2022', outDir, emptyOutDir: true }
});
