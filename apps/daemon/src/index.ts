import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MimicPlugin } from '../../../packages/plugin-sdk/src/host.js';
import { createApp } from './app.js';
const plugins: MimicPlugin[] = [];
for (const path of (process.env.MIMIC_PLUGINS ?? '')
  .split(',')
  .filter(Boolean)) {
  const module = await import(pathToFileURL(resolve(path)).href);
  plugins.push(module.default);
}
const app = await createApp(resolve(process.env.MIMIC_DATA_DIR ?? 'data'), {
  plugins,
});
app.api.listen(
  Number(process.env.MIMIC_PORT ?? 3212),
  process.env.MIMIC_HOST ?? '127.0.0.1',
  () =>
    process.stdout.write(
      `Mimic daemon: ${process.env.MIMIC_HOST ?? '127.0.0.1'}:${process.env.MIMIC_PORT ?? 3212} (${app.state.config.mode})\n`,
    ),
);
app.ingress.listen(
  Number(process.env.MIMIC_QQ_PORT ?? 3211),
  process.env.MIMIC_INGRESS_HOST ?? '127.0.0.1',
);
app.scheduler.start();
app.broker.listen(
  Number(process.env.MIMIC_BROKER_PORT ?? 3215),
  process.env.MIMIC_BROKER_HOST ?? '127.0.0.1',
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
