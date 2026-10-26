import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { build } from 'esbuild';

const entry = 'apps/client/src/main.ts';
const outfile = 'dist/client/main.js';
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'browser', format: 'esm' });
