import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
const token = randomBytes(32).toString('hex'),
  port = Number(process.env.MIMIC_VERIFY_PORT ?? 43214),
  base = `http://127.0.0.1:${port}`;
const broker = spawn(process.execPath, ['scripts/sandbox-broker.mjs'], {
  env: {
    ...process.env,
    MIMIC_SANDBOX_TOKEN: token,
    MIMIC_SANDBOX_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
broker.stderr.on('data', (b) => (logs += b));
const driver = process.env.MIMIC_VERIFY_DRIVER ?? 'apple';
async function request(path, value) {
  const r = await fetch(base + path, {
    method: value ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(value ? { body: JSON.stringify({ driver, ...value }) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
const report = { at: new Date().toISOString(), driver, tests: [] };
try {
  for (let i = 0; i < 50; i++) {
    try {
      await request('/health');
      break;
    } catch {
      if (broker.exitCode !== null) throw new Error(logs);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  report.preflight = await request('/preflight', {});
  const cases = [
    [
      'arithmetic',
      'console.log(JSON.stringify({result:input.a+input.b}))',
      { a: 2, b: 3 },
      (r) => r.code === 0 && r.stdout.includes('"result":5'),
    ],
    [
      'host-files',
      "import fs from 'node:fs';console.log(fs.readFileSync('/etc/passwd','utf8'));",
      null,
      (r) => r.code !== 0 && r.stderr.includes('ERR_ACCESS_DENIED'),
    ],
    [
      'child-process',
      "import {execSync} from 'node:child_process';execSync('id');",
      null,
      (r) => r.code !== 0 && r.stderr.includes('ERR_ACCESS_DENIED'),
    ],
    [
      'network',
      "import net from 'node:net';const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>console.log('CONNECTED'));s.on('error',()=>console.log('BLOCKED'));",
      null,
      (r) =>
        !r.stdout.includes('CONNECTED') &&
        (r.stdout.includes('BLOCKED') || r.killed),
    ],
    ['wall-time', 'while(true){}', null, (r) => r.killed === true],
    [
      'output-limit',
      "while(true)console.log('文字🙂'.repeat(20000));",
      null,
      (r) => r.killed === true && Buffer.byteLength(r.stdout) <= 65536,
    ],
  ];
  for (const [name, code, input, check] of cases) {
    const start = Date.now(),
      result = await request('/execute', { code, input });
    assert.ok(
      check(result),
      `${name}: ${JSON.stringify({ code: result.code, killed: result.killed, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), stderr: result.stderr.slice(0, 300) })}`,
    );
    report.tests.push({ name, passed: true, durationMs: Date.now() - start });
    process.stdout.write(`PASS ${name}\n`);
  }
  const payload = Buffer.from(
    JSON.stringify({
      driver,
      code: 'console.log(input.text)',
      input: { text: '文字🙂' },
    }),
  );
  const split = payload.indexOf(Buffer.from('🙂')) + 1;
  const unicodeResult = await new Promise((resolve, reject) => {
    const req = httpRequest(
      base + '/execute',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(25000, () =>
      req.destroy(new Error('unicode_request_timeout')),
    );
    req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 25);
  });
  assert.equal(unicodeResult.code, 0);
  assert.equal(unicodeResult.stdout.trim(), '文字🙂');
  report.tests.push({ name: 'chunked-unicode-input', passed: true });
  process.stdout.write('PASS chunked-unicode-input\n');
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/sandbox-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  if (broker.exitCode === null) {
    broker.kill('SIGTERM');
    await new Promise((r) => broker.once('exit', r));
  }
}
