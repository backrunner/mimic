import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, '../../..');
const server = resolve(
  process.env.MEMSTATION_ROOT ?? join(root, '../memstation'),
  'apps/server',
);
if (
  !process.env.MEMSTATION_TEST_DATABASE_URL ||
  !process.env.MEMSTATION_TEST_REDIS_URL
)
  throw new Error('dedicated test database and Redis URLs required');
const output = join(root, '.artifacts/memory-integration');
await mkdir(output, { recursive: true });
const overlay = join(output, 'joint-overlay.json');
await writeFile(
  overlay,
  JSON.stringify(
    {
      Replace: {
        [join(server, 'tests/integration/mimic_joint_test.go')]: join(
          here,
          'joint_test.go',
        ),
      },
    },
    null,
    2,
  ),
);
const child = spawn(
  'go',
  [
    'test',
    '-overlay',
    overlay,
    './tests/integration',
    '-run',
    '^TestMimicTypeScriptJoint$',
    '-count=1',
    '-v',
    '-timeout',
    '120s',
  ],
  {
    cwd: server,
    env: {
      ...process.env,
      MIMIC_JOINT_ROOT: root,
      MIMIC_JOINT_REPORT: join(output, 'joint-report.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const chunks = [];
child.stdout.on('data', (d) => {
  chunks.push(d);
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  chunks.push(d);
  process.stderr.write(d);
});
const code = await new Promise((r, j) => {
  child.on('exit', r);
  child.on('error', j);
});
await writeFile(join(output, 'joint.log'), Buffer.concat(chunks));
process.exitCode = code ?? 1;
