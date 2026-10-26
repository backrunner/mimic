import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const directory = resolve('data/dev-broker'),
  file = resolve(directory, 'connection.json');
async function call(connection, path) {
  return fetch(connection.url + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + connection.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ driver: 'apple' }),
    signal: AbortSignal.timeout(20000),
  });
}
export async function stopBroker() {
  try {
    const connection = JSON.parse(await readFile(file, 'utf8'));
    const response = await call(connection, '/shutdown');
    if (!response.ok) throw new Error('broker_shutdown_failed');
    await rm(file);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.cause?.code !== 'ECONNREFUSED') throw e;
  }
}
export async function ensureBroker(gateway) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const codeHash = createHash('sha256')
    .update(await readFile(resolve('scripts/sandbox-broker.mjs')))
    .digest('hex');
  let connection;
  try {
    connection = JSON.parse(await readFile(file, 'utf8'));
    if (connection.codeHash !== codeHash) {
      await call(connection, '/shutdown');
      connection = undefined;
    }
    if (
      connection?.url === 'http://' + gateway + ':3214' &&
      (await call(connection, '/preflight')).ok
    )
      return connection;
  } catch {}
  connection = {
    url: 'http://' + gateway + ':3214',
    token: randomBytes(32).toString('hex'),
    codeHash,
  };
  const log = await open(resolve(directory, 'broker.log'), 'a', 0o600);
  const child = spawn(
    process.execPath,
    [resolve('scripts/sandbox-broker.mjs')],
    {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        MIMIC_SANDBOX_HOST: gateway,
        MIMIC_SANDBOX_PORT: '3214',
        MIMIC_SANDBOX_TOKEN: connection.token,
      },
    },
  );
  child.unref();
  await log.close();
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(connection.url + '/health', {
        headers: { authorization: 'Bearer ' + connection.token },
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready)
    throw new Error('broker_startup_failed_check_data_dev_broker_log');
  await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
  const response = await call(connection, '/preflight');
  if (!response.ok) throw new Error('broker_preflight_failed');
  return connection;
}
