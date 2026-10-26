import { it, expect } from 'vitest';
import { sign, createPrivateKey } from 'node:crypto';
import {
  normalizeQQ,
  verifyQQ,
  qqChallenge,
} from '../plugins/protocol-qq/src/index.js';
import { publicAddress, assertPublicUrl } from '../plugins/tools/src/index.js';
import { fixture } from './helpers.js';
import {
  scopedServices,
  HookRegistry,
  validatePluginGraph,
} from '../packages/plugin-sdk/src/index.js';
import { disabledMemory } from '../plugins/memory-disabled/src/index.js';
import type { PluginManifest } from '../packages/contracts/src/index.js';
it('verifies the exact QQ body, rejects tampering and replay, and preserves quote indices', () => {
  const secret = '12345678901234567890123456789012';
  const raw = Buffer.from('{"a":1}'),
    ts = String(Math.floor(Date.now() / 1000));
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(secret),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = sign(null, Buffer.concat([Buffer.from(ts), raw]), key).toString(
    'hex',
  );
  expect(verifyQQ(secret, ts, raw, sig)).toBe(true);
  expect(verifyQQ(secret, ts, Buffer.from('{"a":2}'), sig)).toBe(false);
  expect(verifyQQ(secret, ts, raw, sig, Date.now() + 301000)).toBe(false);
  expect(qqChallenge(secret, 'hello', ts).signature).toHaveLength(128);
  const event = normalizeQQ(
    {
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'qq-msg',
        content: '这个怎么看',
        timestamp: new Date().toISOString(),
        group_openid: 'group',
        author: { member_openid: 'person', username: '小林' },
        message_scene: {
          ext: ['msg_idx=REFERENCE==', 'ref_msg_idx=PREVIOUS=='],
        },
      },
    },
    'app',
  )!;
  expect(event.mentions).toContain('bot');
  expect(event.protocol?.referenceId).toBe('REFERENCE==');
  expect(event.replyTo).toBe('PREVIOUS==');
});
it('blocks loopback, metadata and private IP literal targets', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
  ])
    expect(publicAddress(ip)).toBe(false);
  expect(publicAddress('1.1.1.1')).toBe(true);
  await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(
    'private_network_denied',
  );
  await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(
    'unsafe_url',
  );
});
it('encrypts credentials and confines plugin data and AI roles', async () => {
  const app = await fixture();
  try {
    const ref = await app.state.setSecret('test-secret', 'sensitive-value');
    expect(await app.state.secret(ref)).toBe('sensitive-value');
    expect(JSON.stringify((await app.db.get(ref))?.value)).not.toContain(
      'sensitive-value',
    );
    const manifest: PluginManifest = {
      id: 'test',
      name: 'test',
      kind: 'behavior',
      version: '1',
      dependencies: [],
      permissions: ['data.read', 'data.write'],
      admin: 'test',
      trust: 'isolated',
    };
    const scope = {
      workspaceId: 'a',
      runId: 'r',
      pluginId: 'test',
      signal: new AbortController().signal,
    };
    const svc = scopedServices(manifest, scope, app.db, app.ai, disabledMemory);
    await svc.data.put('config', { test: true }, null);
    expect(await app.db.get('plugin:test:a:config')).toBeDefined();
    expect((await app.db.get('config'))?.value).not.toEqual({ test: true });
    await expect(svc.data.get('../config')).rejects.toThrow();
    await expect(svc.ai.decide('safety', {}, [])).rejects.toThrow(
      'plugin_permission_denied',
    );
  } finally {
    await app.cleanup();
  }
});
it('required hooks time out and cannot be bypassed by later allow hooks', async () => {
  const registry = new HookRegistry();
  registry.register({
    id: 'block',
    stage: 'send.pre',
    priority: 0,
    timeoutMs: 20,
    required: true,
    async execute() {
      return new Promise(() => {});
    },
  });
  registry.register({
    id: 'allow',
    stage: 'send.pre',
    priority: 1,
    timeoutMs: 20,
    required: true,
    async execute() {
      return { allow: true };
    },
  });
  expect(
    await registry.run(
      'send.pre',
      {},
      {
        workspaceId: 'a',
        runId: 'r',
        pluginId: 't',
        signal: new AbortController().signal,
      },
    ),
  ).toEqual({ allow: false, reason: 'hook_failed' });
});
