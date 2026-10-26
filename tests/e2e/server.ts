import { spawn } from 'node:child_process';
import { fixture, message } from '../helpers.js';
const app = await fixture();
const token = 'test-internal-token';
for (const [i, actor, text] of [
  [1, '小林', 'SQLite 的写锁怎么排查？'],
  [2, '阿澈', '先看看有没有长事务。'],
  [3, '小林', '小弥，你怎么看？'],
] as const) {
  const m = message({
    id: `demo${i}`,
    sourceId: `demo${i}`,
    workspaceId: 'replay:技术闲聊',
    actorId: actor,
    actorName: actor,
    text,
    receivedAt: Date.now() + i,
  });
  await app.engine.ingest(m, { schedule: false });
  if (i === 3) await app.engine.start(m);
}
app.api.listen(43212, '127.0.0.1');
const dashboard = spawn(process.execPath, ['scripts/dashboard.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '43210',
    ORIGIN: 'http://127.0.0.1:43210',
    MIMIC_API_URL: 'http://127.0.0.1:43212',
    MIMIC_INTERNAL_TOKEN: token,
    BODY_SIZE_LIMIT: '2M',
  },
});
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  dashboard.kill('SIGTERM');
  await app.cleanup();
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
dashboard.on('exit', () => void stop());
