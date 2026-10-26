import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3210';
async function api(path, data, method = data ? 'POST' : 'GET') {
  const r = await fetch(base + '/api/' + path, {
    method,
    headers: { origin: base, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const result = await r.json();
  assert.ok(r.ok, JSON.stringify(result));
  return result;
}
function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('container', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '',
      err = '';
    child.stdout.on('data', (b) => (text += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(text) : reject(new Error(err)),
    );
  });
}
const report = {
  at: new Date().toISOString(),
  runtime: 'apple-container',
  checks: [],
};
const original = await api('config'),
  marker = 'Mimic 持久化验证';
assert.equal(
  original.config.mode,
  'shadow',
  'Verification requires shadow mode',
);
try {
  const system = await api('system');
  assert.equal(system.platform, 'linux');
  assert.equal(system.driver, 'sqlite/drizzle');
  report.node = system.node;
  report.checks.push('linux-runtime');
  await api(
    'config',
    {
      config: { ...original.config, botName: marker },
      revision: original.revision,
    },
    'PUT',
  );
  const backup = await api('backup', {});
  const backupCheck = await command([
    'exec',
    'mimic-dev',
    'node',
    '--input-type=module',
    '-e',
    `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify('/data/' + backup.name)},{readOnly:true});const config=JSON.parse(db.prepare("SELECT value FROM records WHERE key='config'").get().value);if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||config.botName!==${JSON.stringify(marker)})process.exit(2);db.close();console.log('consistent');`,
  ]);
  assert.ok(backupCheck.includes('consistent'));
  report.checks.push('online-backup-consistent');
  await command(['stop', 'mimic-dev']);
  await command(['start', 'mimic-dev']);
  let restored;
  for (let i = 0; i < 100; i++) {
    try {
      restored = await api('config');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.equal(restored?.config.botName, marker);
  report.checks.push('restart-preserves-config');
  const preflight = await api('sandbox/preflight', {});
  assert.equal(preflight.ready, true);
  report.checks.push('app-to-broker-preflight');
  const execution = JSON.parse(
    await command([
      'exec',
      'mimic-dev',
      'node',
      '--input-type=module',
      '-e',
      "const r=await fetch(process.env.MIMIC_SANDBOX_URL+'/execute',{method:'POST',headers:{authorization:'Bearer '+process.env.MIMIC_SANDBOX_TOKEN,'content-type':'application/json'},body:JSON.stringify({driver:'apple',code:'console.log(input.a+input.b)',input:{a:20,b:22}})});console.log(JSON.stringify(await r.json()));",
    ]),
  );
  assert.equal(execution.code, 0);
  assert.equal(execution.stdout.trim(), '42');
  report.checks.push('app-to-isolated-node-execution');
  const container = JSON.parse(await command(['inspect', 'mimic-dev']))[0];
  assert.equal(container.configuration.readOnly, true);
  assert.ok(
    container.configuration.publishedPorts.every(
      (p) => p.hostAddress === '127.0.0.1',
    ),
  );
  report.checks.push('read-only-and-loopback-publishing');
  report.imageDigest = container.configuration.image.descriptor.digest;
  report.platform = container.configuration.platform;
} finally {
  const current = await api('config');
  if (current.config.botName === marker)
    await api(
      'config',
      {
        config: { ...current.config, botName: original.config.botName },
        revision: current.revision,
      },
      'PUT',
    );
}
report.status = 'passed';
await mkdir('.artifacts', { recursive: true });
await writeFile(
  '.artifacts/container-verification.json',
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
