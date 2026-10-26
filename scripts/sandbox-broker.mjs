import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
const token = process.env.MIMIC_SANDBOX_TOKEN;
if (!token || token.length < 32)
  throw new Error('Set MIMIC_SANDBOX_TOKEN to at least 32 random characters.');
const image =
  process.env.MIMIC_SANDBOX_IMAGE ??
  'node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';
let busy = false;
const passed = new Set();
function exec(binary, args, input, timeout = 12000) {
  return new Promise((resolve) => {
    const p = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let out = Buffer.alloc(0),
      err = Buffer.alloc(0),
      killed = false;
    const stop = () => {
      killed = true;
      p.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeout);
    p.stdout.on('data', (b) => {
      if (out.length + b.length >= 65536) stop();
      out = Buffer.concat([out, b]).subarray(0, 65536);
    });
    p.stderr.on('data', (b) => {
      if (err.length + b.length >= 65536) stop();
      err = Buffer.concat([err, b]).subarray(0, 65536);
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: 'runtime_unavailable' });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: new TextDecoder().decode(
          Buffer.from(out.toString()).subarray(0, 65536),
          { stream: true },
        ),
        stderr: new TextDecoder().decode(
          Buffer.from(err.toString()).subarray(0, 65536),
          { stream: true },
        ),
        killed,
      });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}
async function run(driver, code, input, probe = false) {
  if (!['apple', 'docker'].includes(driver)) throw new Error('invalid_driver');
  const binary = driver === 'apple' ? 'container' : 'docker',
    name = `mimic-sandbox-${randomUUID()}`;
  const common = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--user',
    '65534:65534',
    '--cpus',
    '1',
    '--memory',
    '256m',
    '--tmpfs',
    '/tmp:size=16m',
    '--ulimit',
    'nofile=64:64',
    '--ulimit',
    'nproc=16:16',
    '-i',
  ];
  if (driver === 'docker')
    common.push('--pids-limit', '16', '--security-opt', 'no-new-privileges');
  const program = `const input = ${JSON.stringify(input ?? null)};\n${code}`;
  const args = [
    ...common,
    image,
    'node',
    ...(probe ? [] : ['--permission']),
    '--input-type=module',
    '-',
  ];
  try {
    return await exec(binary, args, program, probe ? 12000 : 6000);
  } finally {
    await exec(binary, ['rm', '-f', name], '', 4000);
  }
}
async function preflight(driver) {
  const result = await run(
    driver,
    `import os from 'node:os'; import net from 'node:net'; const interfaces=Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal); if(interfaces.length)process.exit(2); const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(3));s.on('error',()=>{console.log('isolated');process.exit(0)});setTimeout(()=>process.exit(4),1500);`,
    null,
    true,
  );
  if (result.code !== 0 || !result.stdout.includes('isolated'))
    throw new Error('isolation_preflight_failed');
  passed.add(driver);
  return { ready: true, driver, image, network: 'none' };
}
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (
    Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  ) {
    res.writeHead(401);
    return res.end('{"error":"unauthorized"}');
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 300000) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const data = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && req.url === '/preflight') {
      const result = await preflight(data.driver ?? 'apple');
      return res.end(JSON.stringify(result));
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      if (busy) throw new Error('sandbox_busy');
      res.end(JSON.stringify({ stopped: true }));
      server.close();
      return;
    }
    if (req.method === 'GET' && req.url === '/health')
      return res.end(JSON.stringify({ ready: [...passed], busy }));
    if (req.method !== 'POST' || req.url !== '/execute') {
      res.writeHead(404);
      return res.end('{}');
    }
    if (busy) throw new Error('sandbox_busy');
    if (!passed.has(data.driver)) throw new Error('preflight_required');
    if (typeof data.code !== 'string' || data.code.length > 32768)
      throw new Error('invalid_code');
    busy = true;
    try {
      const result = await run(data.driver, data.code, data.input);
      res.end(JSON.stringify(result));
    } finally {
      busy = false;
    }
  } catch (e) {
    res.writeHead(422);
    res.end(
      JSON.stringify({
        error: /^[a-z_]+$/.test(e.message) ? e.message : 'sandbox_error',
      }),
    );
  }
});
const host = process.env.MIMIC_SANDBOX_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && !isIP(host))
  throw new Error('sandbox_bind_ip_required');
server.listen(Number(process.env.MIMIC_SANDBOX_PORT ?? 3214), host, () =>
  process.stdout.write(
    `Sandbox broker: ${host}:${process.env.MIMIC_SANDBOX_PORT ?? 3214}\n`,
  ),
);
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
