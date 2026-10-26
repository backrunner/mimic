import { ensureBroker, stopBroker } from './dev-broker.mjs';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const command = process.argv[2] ?? 'up',
  name = 'mimic-dev',
  image = 'mimic:dev';
function run(args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('container', args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    if (capture) child.stdout.on('data', (b) => (out += b));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 || allowFailure
        ? resolve(out)
        : reject(new Error(`container_command_failed_${code}`)),
    );
  });
}
async function remove() {
  const raw = await run(['inspect', name], {
    capture: true,
    allowFailure: true,
  });
  if (!raw.trim()) return;
  const containers = JSON.parse(raw);
  if (containers[0]?.configuration?.labels?.['dev.mimic.owner'] !== 'mimic')
    throw new Error('container_name_owned_elsewhere');
  await run(['stop', name], { allowFailure: true });
  await run(['rm', name]);
}
if (command === 'down') {
  await remove();
  await stopBroker();
} else if (command === 'status') {
  const [container] = JSON.parse(
    await run(['inspect', name], { capture: true }),
  );
  console.log(
    JSON.stringify(
      {
        name,
        state: container.status?.state,
        image: container.configuration?.image?.reference,
      },
      null,
      2,
    ),
  );
} else if (command === 'up') {
  await run([
    'build',
    '--file',
    'Containerfile',
    '--tag',
    image,
    '--memory',
    '4g',
    '--cpus',
    '4',
    '.',
  ]);
  await remove();
  const network = JSON.parse(
    await run(['network', 'inspect', 'default'], { capture: true }),
  );
  const broker = await ensureBroker(network[0].status.ipv4Gateway);
  process.env.MIMIC_SANDBOX_TOKEN = broker.token;
  const data = 'mimic-dev-data';
  const existing = await run(['volume', 'inspect', data], {
    capture: true,
    allowFailure: true,
  });
  if (!existing.trim()) {
    await run([
      'volume',
      'create',
      '--label',
      'dev.mimic.owner=mimic',
      '-s',
      '8g',
      data,
    ]);
  } else if (
    JSON.parse(existing)[0]?.configuration?.labels?.['dev.mimic.owner'] !==
    'mimic'
  )
    throw new Error('volume_name_owned_elsewhere');
  await run([
    'run',
    '--rm',
    '--name',
    'mimic-dev-volume-init',
    '--network',
    'none',
    '--user',
    '0:0',
    '--volume',
    `${data}:/data`,
    image,
    'node',
    '-e',
    "const fs=require('node:fs');fs.chownSync('/data',1000,1000);fs.chmodSync('/data',448);",
  ]);
  await run([
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    'dev.mimic.owner=mimic',
    '--cpus',
    '2',
    '--memory',
    '1g',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    '/tmp:size=32m',
    '--publish',
    '127.0.0.1:3210:3210',
    '--publish',
    '127.0.0.1:3211:3211',
    '--publish',
    '127.0.0.1:3215:3215',
    '--volume',
    `${data}:/data`,
    '--env',
    'MIMIC_SANDBOX_URL=' + broker.url,
    '--env',
    'MIMIC_SANDBOX_TOKEN',
    image,
  ]);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3210/api/overview');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    await run(['logs', name], { allowFailure: true });
    throw new Error('mimic_startup_failed');
  }
  process.stdout.write('Mimic development dashboard: http://127.0.0.1:3210\n');
} else throw new Error('usage: apple-container.mjs up|down|status');
