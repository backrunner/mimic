import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/plugins/storage-sqlite/src', { recursive: true });
await cp(
  'plugins/storage-sqlite/src/worker.mjs',
  'dist/plugins/storage-sqlite/src/worker.mjs',
);
