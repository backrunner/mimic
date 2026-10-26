import { afterEach, expect, it } from 'vitest';
import { fixture, fakeFetch, message } from './helpers.js';
import { installPlugins } from '../packages/plugin-sdk/src/host.js';
import { catalog } from '../packages/plugin-sdk/src/catalog.js';
import { disabledMemory } from '../plugins/memory-disabled/src/index.js';
import { pruneHistory } from '../packages/core/src/maintenance.js';
import type { Run, Usage } from '../packages/contracts/src/index.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it('observing another bot does not discard a pending human turn', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  await app.state.save(
    {
      ...app.state.config,
      behavior: { ...app.state.config.behavior, debounceMs: 30 },
    },
    app.state.revision,
  );
  await app.engine.ingest(message());
  await app.engine.ingest(
    message({
      id: 'other-bot',
      bot: true,
      actorId: 'other-bot',
      mentions: [],
      text: '其他机器人的消息',
    }),
  );
  await app.engine.idle();
  expect(
    (await app.db.list<Run>('run', 'group-a')).some(
      (r) => r.value.status === 'shadow' && r.value.triggerId === 'm1',
    ),
  ).toBe(true);
});
it('concurrent starts for one workspace leave one active reply', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const messages = [1, 2, 3].map((i) =>
    message({ id: 'burst' + i, receivedAt: Date.now() + i }),
  );
  for (const item of messages)
    await app.engine.ingest(item, { schedule: false });
  await Promise.all(messages.map((item) => app.engine.start(item)));
  const runs = await app.db.list<Run>('run', 'group-a');
  expect(runs.filter((r) => r.value.status === 'shadow')).toHaveLength(1);
  expect(runs.find((r) => r.value.status === 'shadow')?.value.triggerId).toBe(
    'burst3',
  );
});
it('denied input cannot re-enter later decision or text contexts', async () => {
  const seen: string[] = [];
  const app = await fixture(async (input, init) => {
    const b = JSON.parse(String(init?.body));
    const response = await fakeFetch(input, init);
    if (
      b.questions?.harm &&
      JSON.stringify(b.state.subject).includes('ATTACK_MARKER')
    ) {
      const value = await response.json();
      value.answers.harm.noul = 1;
      return Response.json(value);
    }
    if (b.questions?.addressed || String(input).endsWith('/chat/completions'))
      seen.push(String(init?.body));
    return response;
  });
  cleanups.push(app.cleanup);
  const denied = message({ text: 'ATTACK_MARKER', id: 'bad' });
  await app.engine.ingest(denied, { schedule: false });
  await app.engine.start(denied);
  const good = message({
    id: 'good',
    text: '正常讨论',
    receivedAt: Date.now() + 1,
  });
  await app.engine.ingest(good, { schedule: false });
  await app.engine.start(good);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.join()).not.toContain('ATTACK_MARKER');
  expect(
    (await app.db.list<Run>('run', 'group-a')).map((r) => r.value.status),
  ).toContain('shadow');
});
it('scheduled proposals cannot borrow historical mentions to bypass calibration', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const m = message();
  await app.engine.ingest(m, { schedule: false });
  const ws = await app.db.get<any>('workspace:group-a');
  await app.db.commit([
    {
      ...ws!,
      value: { ...ws!.value, proactive: true },
      expected: ws!.revision,
    },
  ]);
  await app.engine.start(m, '主动分享点什么', false);
  const run = (await app.db.list<Run>('run', 'group-a'))[0]!.value;
  expect(run.status).toBe('silent');
  expect(run.reason).toBe('calibration_required');
});
it('custom model codecs use the shared transport and usage ledger', async () => {
  const app = await fixture(async (input, init) =>
    String(input).endsWith('/custom')
      ? Response.json({
          text: 'custom',
          usage: { input_tokens: 2, output_tokens: 1 },
        })
      : fakeFetch(input, init),
  );
  cleanups.push(app.cleanup);
  await installPlugins(
    [
      {
        manifest: {
          id: 'model-custom',
          name: 'Custom',
          kind: 'model',
          version: '1',
          admin: 'models',
          dependencies: [],
          permissions: [],
          trust: 'trustedInProcess',
        },
        setup(r) {
          r.model({
            id: 'custom',
            credentialsOptional: true,
            text: {
              encode: ({ model }, messages) => ({
                path: '/custom',
                body: { model, messages },
              }),
              decode: (data) => ({
                content: String(data.text),
                toolCalls: [],
                assistant: { role: 'assistant', content: String(data.text) },
              }),
            },
          });
        },
      },
    ],
    { ...app, memory: disabledMemory },
    catalog,
  );
  await app.state.save(
    {
      ...app.state.config,
      connections: [
        ...app.state.config.connections,
        {
          id: 'custom',
          name: 'Custom',
          provider: 'custom',
          baseUrl: 'https://fixture.example',
          protocol: 'chat',
          secretRef: '',
          enabled: true,
        },
      ],
      routes: {
        ...app.state.config.routes,
        chat: { connectionId: 'custom', model: 'custom' },
      },
    },
    app.state.revision,
  );
  const output = await app.ai.generate(
    [{ role: 'user', content: 'hello' }],
    [],
    {
      workspaceId: 'test',
      runId: 'custom',
      pluginId: 'test',
      signal: AbortSignal.timeout(1000),
    },
  );
  expect(output.content).toBe('custom');
  const usage = (await app.db.list<Usage>('usage', 'test'))[0]!.value;
  expect(usage.inputTokens).toBe(2);
  expect(usage.connectionId).toBe('custom');
});
it('per-run budget prevents an extra outbound call', async () => {
  let calls = 0;
  const app = await fixture(async (...args) => {
    calls++;
    return fakeFetch(...args);
  });
  cleanups.push(app.cleanup);
  await app.state.save(
    {
      ...app.state.config,
      budgets: { ...app.state.config.budgets, runCalls: 1 },
    },
    app.state.revision,
  );
  const scope = {
    workspaceId: 'test',
    runId: 'budget',
    pluginId: 'test',
    signal: AbortSignal.timeout(1000),
  };
  await app.ai.generate([], [], scope);
  await expect(app.ai.generate([], [], scope)).rejects.toThrow(
    'budget_exhausted',
  );
  expect(calls).toBe(1);
});
it('retention removes history while preserving secrets, assets and schedules', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const old = Date.now() - 40 * 86400000;
  await app.db.commit(
    ['message', 'usage', 'secret', 'asset', 'schedule'].map((kind) => ({
      key: 'retention:' + kind,
      kind,
      scope: 'test',
      value: { marker: true },
      at: old,
      expected: null,
    })),
  );
  await pruneHistory(app.state);
  expect(await app.db.get('retention:message')).toBeUndefined();
  expect(await app.db.get('retention:usage')).toBeUndefined();
  for (const kind of ['secret', 'asset', 'schedule'])
    expect(await app.db.get('retention:' + kind)).toBeDefined();
});
