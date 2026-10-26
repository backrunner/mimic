import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const dataDir = resolve(process.env.MIMIC_DATA_DIR ?? 'data');
const env = { ...process.env, MIMIC_DATA_DIR: dataDir };
const daemon = spawn(process.execPath, ['dist/apps/daemon/src/index.js'], {
  stdio: 'inherit',
  env,
});
let dashboard,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  daemon.kill('SIGTERM');
  dashboard?.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
daemon.on('exit', () => {
  if (!stopping) {
    void stop();
    process.exitCode = 1;
  }
});
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(
      `http://127.0.0.1:${env.MIMIC_PORT ?? 3212}/health/live`,
    );
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const token =
  env.MIMIC_INTERNAL_TOKEN ??
  (await readFile(resolve(dataDir, 'control.token'), 'utf8')).trim();
dashboard = spawn(process.execPath, ['scripts/dashboard.mjs'], {
  stdio: 'inherit',
  env: {
    ...env,
    MIMIC_INTERNAL_TOKEN: token,
    BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? '2M',
    HOST: process.env.HOST ?? '127.0.0.1',
    PORT: process.env.PORT ?? '3210',
    ORIGIN:
      process.env.ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3210}`,
  },
});
dashboard.on('exit', () => {
  if (!stopping) {
    void stop();
    process.exitCode = 1;
  }
});
