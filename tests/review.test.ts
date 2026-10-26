import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { fixture, fakeFetch, message } from './helpers.js';
import { createApp } from '../apps/daemon/src/app.js';
import {
  scheduleSchema,
  type Message,
  type Usage,
  type Run,
  type Workspace,
  type ProtocolAdapter,
} from '../packages/contracts/src/index.js';
import { type ScheduledJob } from '../packages/scheduler/src/index.js';
import { type MimicPlugin } from '../packages/plugin-sdk/src/host.js';
import { HookRegistry } from '../packages/plugin-sdk/src/index.js';
import { builtinModelProviders } from '../plugins/models/src/index.js';
import { refreshProfile } from '../packages/core/src/profiles.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const scope = () => ({
  workspaceId: 'test',
  runId: crypto.randomUUID(),
  pluginId: 'test',
  signal: AbortSignal.timeout(5000),
});

it('recovers every ambiguous send and usage before starting ingress, including timestamp ties', async () => {
  const app = await fixture();
  const writes = [];
  for (const kind of ['send', 'usage'])
    for (let i = 0; i < 1050; i++)
      writes.push({
        key: `recovery:${kind}:${i}`,
        kind,
        scope: 'test',
        at: 123,
        value: {
          status: kind === 'send' ? 'sending' : 'pending',
          runId: kind === 'send' && i === 0 ? 'unknown-run' : undefined,
        },
        expected: null,
      });
  for (const id of ['cancelled-run', 'unknown-run', 'sent-run'])
    writes.push({
      key: 'run:' + id,
      kind: 'run',
      scope: 'test',
      at: 123,
      value: {
        id,
        workspaceId: 'test',
        triggerId: 'm',
        revision: 1,
        configRevision: app.state.revision,
        status: 'generating',
        at: 123,
        stages: [],
      },
      expected: null,
    });
  writes.push({
    key: 'recovery:confirmed-send',
    kind: 'send',
    scope: 'test',
    at: 123,
    value: { status: 'sent', runId: 'sent-run' },
    expected: null,
  });
  await app.db.commit(writes);
  await app.close();
  let ingressObserved = false;
  const plugin: MimicPlugin = {
    manifest: {
      id: 'protocol-check',
      name: 'check',
      kind: 'protocol',
      version: '1',
      dependencies: [],
      permissions: ['protocol.send'],
      admin: '',
      trust: 'trustedInProcess',
    },
    setup(r) {
      r.protocol({
        id: 'check',
        async start() {
          for (const kind of ['send', 'usage'])
            for (let i = 0; i < 1050; i++)
              expect(
                (await nextStorage.get<{ status: string }>(
                  `recovery:${kind}:${i}`,
                ))!.value.status,
              ).toBe('unknown');
          ingressObserved = true;
        },
        async send() {
          return { status: 'failed', code: 'test' };
        },
      });
    },
  };
  const { SqliteStorage } =
    await import('../plugins/storage-sqlite/src/index.js');
  const nextStorage = new SqliteStorage(join(app.dir, 'mimic.sqlite'));
  const next = await createApp(app.dir, {
    storage: nextStorage,
    fetcher: fakeFetch,
    plugins: [plugin],
    internalToken: 'fixture',
  });
  cleanups.push(async () => {
    await next.close();
    await rm(app.dir, { recursive: true, force: true });
  });
  expect(ingressObserved).toBe(true);
  for (const status of ['cancelled', 'unknown', 'sent'])
    expect(
      (await next.db.get<Run>('run:' + status + '-run'))!.value,
    ).toMatchObject({ status, endedAt: expect.any(Number) });
});

it('rejects an empty persisted control token instead of authorizing empty credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimic-empty-token-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'control.token'), '\n');
  await expect(createApp(dir)).rejects.toThrow('internal_token_empty');
});

it('ticks all schedules beyond the old first-100 limit and honors plugin disable for manual runs', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const now = Date.now();
  const spec = scheduleSchema.parse({
    id: 'base',
    name: 'fixture',
    workspaceId: 'empty',
    kind: 'random',
    prompt: '观察',
    quietStart: '00:00',
    quietEnd: '00:00',
    enabled: true,
  });
  await app.db.commit(
    Array.from({ length: 205 }, (_, i) => ({
      key: 'schedule:' + i,
      kind: 'schedule',
      scope: 'empty',
      value: {
        spec: { ...spec, id: String(i) },
        nextAt: now,
        occurrence: String(i),
        leaseUntil: 0,
        fence: 0,
      } satisfies ScheduledJob,
      expected: null,
      at: now,
    })),
  );
  await app.scheduler.tick(now);
  let handled = 0;
  for await (const r of app.state.scan<ScheduledJob>('schedule'))
    if (r.value.lastStatus === 'skipped_no_context') handled++;
  expect(handled).toBe(205);
  await app.state.save(
    { ...app.state.config, disabledPlugins: ['behavior-scheduled'] },
    app.state.revision,
  );
  await expect(app.scheduler.execute('0', false)).rejects.toThrow(
    'plugin_disabled',
  );
});

it('preserves class protocol lifecycle, this binding, and disabled ingress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimic-plugin-review-'));
  class Adapter implements ProtocolAdapter {
    id = 'custom';
    started = 0;
    stopped = 0;
    ingest?: (event: unknown) => Promise<unknown>;
    coverage() {
      return 'all_messages' as const;
    }
    async start(ingest: (event: unknown) => Promise<unknown>) {
      this.started++;
      this.ingest = ingest;
    }
    async stop() {
      this.stopped++;
    }
    async send() {
      return { status: 'failed' as const, code: 'test' };
    }
  }
  const adapter = new Adapter();
  const app = await createApp(dir, {
    fetcher: fakeFetch,
    internalToken: 'fixture',
    plugins: [
      {
        manifest: {
          id: 'protocol-custom',
          name: 'custom',
          kind: 'protocol',
          version: '1',
          dependencies: [],
          permissions: ['protocol.send'],
          admin: '',
          trust: 'trustedInProcess',
        },
        setup(r) {
          r.protocol(adapter);
        },
      },
    ],
  });
  cleanups.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  expect(adapter.started).toBe(1);
  await adapter.ingest!(message({ connectionId: 'custom' }));
  await app.engine.idle();
  expect(
    (await app.db.get<Workspace>('workspace:group-a'))!.value.receive,
  ).toBe('all_messages');
  await app.state.save(
    { ...app.state.config, disabledPlugins: ['protocol-custom'] },
    app.state.revision,
  );
  await adapter.ingest!(message({ connectionId: 'custom', id: 'disabled' }));
  expect(await app.db.get('message:group-a:disabled')).toBeUndefined();
  // Stop is a bound prototype method even after the plugin has been disabled.
  await app.engine.protocols.get('custom')!.stop!();
  expect(adapter.stopped).toBe(1);
});

it('rolls back started protocol resources when a later startup fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimic-startup-review-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let stopped = 0,
    signal: AbortSignal | undefined;
  const plugins: MimicPlugin[] = ['first', 'second'].map((id) => ({
    manifest: {
      id: 'protocol-' + id,
      name: id,
      kind: 'protocol',
      version: '1',
      dependencies: [],
      permissions: ['protocol.send'],
      admin: '',
      trust: 'trustedInProcess',
    },
    setup(r) {
      r.protocol({
        id,
        async start(_ingest, s) {
          signal = s;
          if (id === 'second') throw new Error('startup_failed');
        },
        async stop() {
          stopped++;
        },
        async send() {
          return { status: 'failed', code: 'test' };
        },
      });
    },
  }));
  await expect(
    createApp(dir, { plugins, internalToken: 'fixture' }),
  ).rejects.toThrow('startup_failed');
  expect(stopped).toBe(2);
  expect(signal?.aborted).toBe(true);
});

it('never resurrects tombstones or runs a stale trigger revision', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const m = message();
  await app.engine.ingest(m, { schedule: false });
  const edited = {
    ...m,
    kind: 'edited' as const,
    revision: 2,
    text: '当前版本',
  };
  await app.engine.ingest(edited, { schedule: false });
  await app.engine.start(m);
  expect((await app.db.list<Run>('run'))[0]!.value.reason).toBe(
    'trigger_changed',
  );
  await app.engine.ingest(
    { ...edited, kind: 'deleted', text: '' },
    { schedule: false },
  );
  for (const late of [m, edited, { ...edited, revision: 3 }])
    expect(await app.engine.ingest(late, { schedule: false })).toEqual({
      duplicate: true,
    });
  expect(
    (await app.db.get<Message>('message:group-a:m1'))!.value,
  ).toMatchObject({ kind: 'deleted', text: '' });
});

it('withdrawn bot context cancels a pending human reply and invalidates derived profiles', async () => {
  const began = deferred(),
    release = deferred();
  const app = await fixture(async (input, init) => {
    if (String(input).endsWith('/chat/completions')) {
      began.resolve();
      await release.promise;
    }
    return fakeFetch(input, init);
  });
  cleanups.push(app.cleanup);
  const bot = message({
    id: 'old-bot',
    actorId: 'bot',
    bot: true,
    mentions: [],
    text: '将被撤回的历史',
  });
  await app.engine.ingest(bot, { schedule: false });
  await app.engine.ingest(message());
  await began.promise;
  await app.db.commit([
    {
      key: 'derived-test',
      kind: 'group-profile',
      scope: 'group-a',
      value: {},
      expected: null,
    },
  ]);
  await app.engine.ingest(
    { ...bot, kind: 'deleted', revision: 2, text: '' },
    { schedule: false },
  );
  release.resolve();
  await app.engine.idle();
  expect((await app.db.list<Run>('run'))[0]!.value.status).toBe('cancelled');
  expect(await app.db.get('derived-test')).toBeUndefined();
  expect(await app.db.list('send')).toHaveLength(0);
});

it('does not mix old codecs with a new connection while AI requests await budget reservation', async () => {
  let calls = 0;
  const app = await fixture(async (...args) => {
    calls++;
    return fakeFetch(...args);
  });
  cleanups.push(app.cleanup);
  const originalGet = app.db.get.bind(app.db),
    entered = deferred(),
    release = deferred();
  app.db.get = async <T>(key: string) => {
    const result = await originalGet<T>(key);
    if (key.startsWith('budget:day:')) {
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  const first = app.ai.generate([], [], scope());
  await entered.promise;
  const second = app.ai.generate([], [], scope());
  const settled = Promise.allSettled([first, second]);
  await app.state.save(
    {
      ...app.state.config,
      connections: app.state.config.connections.map((c) => ({
        ...c,
        baseUrl: 'http://new-connection.test',
      })),
      routes: {
        ...app.state.config.routes,
        chat: { connectionId: 'fixture', model: 'new-model' },
      },
    },
    app.state.revision,
  );
  release.resolve();
  const results = await settled;
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(calls).toBe(0);
});

it('aborts a reserved AI request if configuration changes while resolving its credential', async () => {
  let calls = 0;
  const app = await fixture(async (...args) => {
    calls++;
    return fakeFetch(...args);
  });
  cleanups.push(app.cleanup);
  const original = app.state.secret.bind(app.state),
    entered = deferred(),
    release = deferred();
  app.state.secret = async (ref) => {
    entered.resolve();
    await release.promise;
    return original(ref);
  };
  const request = app.ai.generate([], [], scope());
  const result = Promise.allSettled([request]);
  await entered.promise;
  await app.state.save(
    { ...app.state.config, botName: '新的配置' },
    app.state.revision,
  );
  release.resolve();
  expect((await result)[0]!.status).toBe('rejected');
  expect(calls).toBe(0);
  expect((await app.db.list<Usage>('usage'))[0]!.value.status).toBe('failed');
});

it('marks partial text token usage as unknown rather than fully reported', async () => {
  const app = await fixture(async (...args) => {
    const data = await (await fakeFetch(...args)).json();
    delete data.usage.completion_tokens;
    return Response.json(data);
  });
  cleanups.push(app.cleanup);
  await app.ai.generate([], [], scope());
  const usage = (await app.db.list<Usage>('usage'))[0]!.value;
  expect(usage.status).toBe('unknown');
  expect(usage.inputTokens).toBe(100);
  expect(usage.outputTokens).toBeUndefined();
});

it('QQ coverage changes apply to existing workspaces before the next decision', async () => {
  const seen: string[] = [];
  const app = await fixture(async (input, init) => {
    const b = JSON.parse(String(init?.body));
    if (b.questions?.addressed) seen.push(b.state.coverage);
    return fakeFetch(input, init);
  });
  cleanups.push(app.cleanup);
  const m = message({ connectionId: 'qq' });
  await app.engine.ingest(m, { schedule: false });
  expect(
    (await app.db.get<Workspace>('workspace:group-a'))!.value.receive,
  ).toBe('mentions_only');
  await app.state.save(
    {
      ...app.state.config,
      qq: { ...app.state.config.qq, receive: 'all_messages' },
    },
    app.state.revision,
  );
  await app.engine.start(m);
  expect(seen.at(-1)).toBe('all_messages');
  await app.engine.ingest(message({ connectionId: 'qq', id: 'next' }), {
    schedule: false,
  });
  expect(
    (await app.db.get<Workspace>('workspace:group-a'))!.value.receive,
  ).toBe('all_messages');
  await expect(
    app.engine.ingest(message({ id: 'wrong', connectionId: 'replay' }), {
      schedule: false,
    }),
  ).rejects.toThrow('workspace_identity_conflict');
});

it('removes completed hook abort listeners and rejects prototype names as choices', async () => {
  let signal: AbortSignal | undefined;
  const registry = new HookRegistry();
  registry.register({
    id: 'once',
    stage: 'send.pre',
    priority: 0,
    timeoutMs: 10000,
    required: true,
    async execute(_subject, scope) {
      signal = scope.signal;
      return { allow: true };
    },
  });
  expect(await registry.run('send.pre', {}, scope())).toEqual({ allow: true });
  expect(getEventListeners(signal!, 'abort')).toHaveLength(0);
  const provider = builtinModelProviders.find((p) => p.id === 'local')!;
  expect(() =>
    provider.decision!.decode(
      { choices: [{ message: { content: '{"choice":"toString"}' } }] },
      [
        {
          name: 'choice',
          type: 'choice',
          instructions: 'choose',
          choices: { yes: 'yes', no: 'no' },
        },
      ],
      { model: 'test', protocol: 'chat' },
    ),
  ).toThrow('decision_out_of_range');
});

it('paginates every record when timestamps tie, without duplicates or gaps', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  await app.db.commit(
    Array.from({ length: 451 }, (_, i) => ({
      key: 'page:' + String(i).padStart(4, '0'),
      kind: 'usage',
      scope: 'paging',
      value: { n: i },
      at: 1000,
      expected: null,
    })),
  );
  await new Promise<void>((r) => app.api.listen(0, '127.0.0.1', r));
  const address = app.api.address() as { port: number };
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const url = new URL(
      `http://127.0.0.1:${address.port}/api/usage?scope=paging&limit=200`,
    );
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: { authorization: 'Bearer test-internal-token' },
    });
    expect(response.status).toBe(200);
    const page = await response.json();
    for (const row of page.items) {
      expect(seen.has(row.key)).toBe(false);
      seen.add(row.key);
    }
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(451);
});

it('a rejected config save cannot replace the live credential through a reused secret name', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  await new Promise<void>((r) => app.api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.api.address() as { port: number }).port}`;
  const headers = {
    authorization: 'Bearer test-internal-token',
    'content-type': 'application/json',
  };
  const store = async (value: string) =>
    (
      await (
        await fetch(base + '/api/secrets', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'same-name', value }),
        })
      ).json()
    ).ref as string;
  const old = await store('old-fixture');
  await app.state.save(
    {
      ...app.state.config,
      connections: app.state.config.connections.map((c) => ({
        ...c,
        secretRef: old,
      })),
    },
    app.state.revision,
  );
  const stale = structuredClone(app.state.config),
    revision = app.state.revision;
  await app.state.save(
    { ...app.state.config, botName: 'concurrent-save' },
    revision,
  );
  const replacement = await store('replacement-fixture');
  stale.connections[0]!.secretRef = replacement;
  expect(
    (
      await fetch(base + '/api/config', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ config: stale, revision }),
      })
    ).status,
  ).toBe(409);
  expect(replacement).not.toBe(old);
  expect(await app.state.secret(old)).toBe('old-fixture');
  expect(app.state.config.connections[0]!.secretRef).toBe(old);
});

it('keeps the config revision, runtime and soul file aligned across queued saves', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const start = app.state.revision,
    config = structuredClone(app.state.config);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      app.state.save({ ...config, soul: 'soul-' + i }, start + i),
    ),
  );
  expect(app.state.revision).toBe(start + 12);
  expect(app.state.config.soul).toBe('soul-11');
  expect(await readFile(join(app.dir, 'soul.md'), 'utf8')).toBe('soul-11');
  expect((await app.db.get<{ soul: string }>('config'))!.value.soul).toBe(
    'soul-11',
  );
});

it('refreshes a profile invalidated by configuration and rejects a source deleted during manual refresh', async () => {
  const entered = deferred(),
    release = deferred();
  let block = false,
    calls = 0;
  const app = await fixture(async (input, init) => {
    const b = JSON.parse(String(init?.body));
    if (b.questions?.style) {
      calls++;
      if (block) {
        entered.resolve();
        await release.promise;
      }
    }
    return fakeFetch(input, init);
  });
  cleanups.push(app.cleanup);
  const samples = Array.from({ length: 10 }, (_, i) =>
    message({
      id: 'profile-' + i,
      actorId: i % 2 ? 'one' : 'two',
      occurredAt: Date.now() - i * 3600000,
      mentions: [],
    }),
  );
  for (const m of samples) await app.engine.ingest(m, { schedule: false });
  await app.db.commit([
    {
      key: 'profile:group-a',
      kind: 'group-profile',
      scope: 'group-a',
      value: {
        at: Date.now(),
        expiresAt: Date.now() + 86400000,
        configRevision: app.state.revision,
      },
      expected: null,
    },
  ]);
  await app.state.save(
    { ...app.state.config, botName: 'changed' },
    app.state.revision,
  );
  await refreshProfile(app.state, app.ai, samples, {
    ...scope(),
    workspaceId: 'group-a',
  });
  expect(calls).toBe(1);
  block = true;
  const refresh = refreshProfile(
    app.state,
    app.ai,
    samples,
    { ...scope(), workspaceId: 'group-a' },
    true,
  );
  const settled = Promise.allSettled([refresh]);
  await entered.promise;
  await app.engine.ingest(
    { ...samples[0]!, kind: 'deleted', revision: 2, text: '' },
    { schedule: false },
  );
  release.resolve();
  expect((await settled)[0]!.status).toBe('rejected');
  expect(await app.db.list('group-profile', 'group-a')).toHaveLength(0);
});
