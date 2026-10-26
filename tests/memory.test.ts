import { afterEach, expect, it } from 'vitest';
import { fixture, fakeFetch, message } from './helpers.js';
import type { MemoryJob } from '../packages/core/src/memory.js';
import type { Usage } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/daemon/src/app.js';
import { uid } from '../packages/core/src/state.js';
import { scopedServices } from '../packages/plugin-sdk/src/index.js';
import { catalog } from '../packages/plugin-sdk/src/catalog.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function server() {
  const calls: { key: string; body: any }[] = [];
  const searches: any[] = [];
  let fail = false,
    revision = 1,
    content = '小林喜欢摄影';
  const fetcher: typeof fetch = async (url, init) => {
    if (!String(url).startsWith('http://memstation.test'))
      return fakeFetch(url, init);
    const path = new URL(String(url)).pathname,
      headers = new Headers(init?.headers),
      workspace = headers.get('X-MemStation-Workspace')!;
    if (headers.get('authorization') !== 'Bearer data-key')
      return Response.json({}, { status: 401 });
    if (path.endsWith('/capabilities'))
      return Response.json({
        contract_version: '1.0',
        runtime: { ai_backend: 'broker', usage_authority: 'broker' },
        status: 'ready',
        access: { workspace_id: workspace },
        capabilities: {
          server_isolation: true,
          multi_workspace: true,
          independent_ingestion: true,
          batch_idempotency: true,
          external_actor_mentions: true,
          broker: true,
        },
      });
    if (path.endsWith('/events/batch')) {
      const body = JSON.parse(String(init?.body));
      calls.push({ key: headers.get('Idempotency-Key')!, body });
      if (fail) {
        fail = false;
        throw new Error('network_result_unknown');
      }
      return Response.json({
        id: 'receipt-' + body.events[0].event_id,
        workspace_id: workspace,
        accepted_sequence: 1,
        indexed_sequence: 0,
        status: 'accepted',
        events: [
          {
            message_id: 'remote-source',
            conversation_id: 'window',
            sequence: 1,
          },
        ],
      });
    }
    if (path.includes('/ingestions/'))
      return Response.json({
        id: path.split('/').at(-1),
        workspace_id: workspace,
        accepted_sequence: 1,
        indexed_sequence: 1,
        status: 'complete',
      });
    if (path.endsWith('/search')) {
      searches.push(JSON.parse(String(init?.body)));
      return Response.json({
        memories: [
          {
            node_id: 'node',
            workspace_id: workspace,
            revision,
            content,
            source_refs: [
              {
                workspace_id: workspace,
                message_id: 'remote-source',
                revision: 1,
                part_index: 0,
              },
            ],
          },
        ],
        trace: { returned_count: 1, eligible_count: 1 },
      });
    }
    if (path.includes('/records/'))
      return Response.json({
        node_id: 'node',
        workspace_id: workspace,
        revision,
        content,
        source_refs: [
          {
            workspace_id: workspace,
            message_id: 'remote-source',
            revision: 1,
            part_index: 0,
          },
        ],
      });
    if (path.includes('/sources/'))
      return Response.json({
        id: 'remote-source',
        revision: 1,
        parts: [{ type: 'text', text: '你好😀摄影很好玩' }],
      });
    throw new Error('unexpected_memory_request');
  };
  return {
    fetcher,
    calls,
    searches,
    failNext() {
      fail = true;
    },
    change() {
      revision++;
      content = '当前事实已纠正';
    },
  };
}
async function enable(app: Pick<Awaited<ReturnType<typeof fixture>>, 'state'>) {
  const secretRef = await app.state.setSecret('memory-test', 'data-key');
  await app.state.save(
    {
      ...app.state.config,
      memory: {
        ...app.state.config.memory,
        baseUrl: 'http://memstation.test',
        secretRef,
        bindings: [
          {
            workspaceId: 'group-a',
            remoteWorkspaceId: 'remote-a',
            integrationId: 'i',
            externalSpaceId: 'room',
            partitionId: '',
            audienceActorIds: [],
          },
        ],
      },
    },
    app.state.revision,
  );
  expect(app.state.config.memory.enabled).toBe(true);
}
const scope = () => ({
  workspaceId: 'group-a',
  runId: uid(),
  pluginId: 'test',
  signal: AbortSignal.timeout(2000),
});
it('enables a newly configured integration and preserves an explicit pause across saves and restart', async () => {
  const app = await fixture();
  expect(app.state.config.memory.enabled).toBe(false);
  const secretRef = await app.state.setSecret('auto-memory', 'fixture-only');
  await app.state.save(
    { ...app.state.config, memory: { ...app.state.config.memory, secretRef } },
    app.state.revision,
  );
  expect(app.state.config.memory.enabled).toBe(false);
  await enable(app);
  await app.state.save(
    {
      ...app.state.config,
      memory: { ...app.state.config.memory, enabled: false },
    },
    app.state.revision,
  );
  await app.state.save(
    { ...app.state.config, botName: 'paused-memory' },
    app.state.revision,
  );
  expect(app.state.config.memory.enabled).toBe(false);
  await app.close();
  const next = await createApp(app.dir, {
    fetcher: fakeFetch,
    internalToken: 'fixture',
  });
  cleanup.push(async () => {
    await next.close();
    const { rm } = await import('node:fs/promises');
    await rm(app.dir, { recursive: true, force: true });
  });
  expect(next.state.config.memory.enabled).toBe(false);
  await next.state.save(
    {
      ...next.state.config,
      memory: { ...next.state.config.memory, bindings: [] },
    },
    next.state.revision,
  );
  expect(next.state.config.memory.enabled).toBe(false);
  await enable(next);
});
it('forwards explicit filters and blocks private partitions from group conversations', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  await app.memory.recall('摄影', scope(), {
    actorIds: ['actor-1'],
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T00:00:00Z',
  });
  expect(remote.searches[0]).toMatchObject({
    subject_actor_ids: ['actor-1'],
    date_from: '2026-01-01T00:00:00Z',
    date_to: '2026-12-31T00:00:00Z',
  });
  const config = structuredClone(app.state.config);
  config.memory.bindings[0]!.partitionId = 'private-a';
  config.memory.bindings[0]!.audienceActorIds = ['actor-1'];
  await app.state.save(config, app.state.revision);
  await app.engine.ingest(
    message({ id: 'private', sourceId: 'private', mentions: [] }),
    { schedule: false },
  );
  await app.memory.flush();
  expect(remote.calls).toHaveLength(0);
  expect(await app.memory.recall('摄影', scope())).toMatchObject({
    status: 'degraded',
    items: [],
    trace: { failure_code: 'memory_audience_mismatch' },
  });
  expect(remote.searches).toHaveLength(1);
});
it('queues references atomically and observes safe messages without a reply', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  let rows = await app.db.list<MemoryJob>('memory-outbox');
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain('数据库');
  expect(rows[0]!.value.status).toBe('pending_policy');
  await app.memory.flush();
  expect(remote.calls).toHaveLength(1);
  expect(remote.calls[0]!.body.events[0].parts[0].text).toContain('数据库');
  expect((await app.db.list<MemoryJob>('memory-outbox'))[0]!.value.status).toBe(
    'accepted',
  );
  expect(await app.db.list('run')).toHaveLength(0);
});
it('never delivers denied bodies, and retracts an already-ingested message when an edit is denied', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  app.engine.safety = {
    id: 'fixture',
    async check(_stage, subject) {
      return {
        allow: !JSON.stringify(subject).includes('DENY'),
        reason: 'fixture',
      };
    },
  };
  await app.engine.ingest(
    message({ id: 'denied', sourceId: 'denied', text: 'DENY', mentions: [] }),
    { schedule: false },
  );
  await app.memory.flush();
  expect(remote.calls).toHaveLength(0);
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  await app.memory.flush();
  await app.engine.ingest(
    message({ kind: 'edited', revision: 2, text: 'DENY', mentions: [] }),
    { schedule: false },
  );
  await app.memory.flush();
  expect(remote.calls.at(-1)!.body.events[0].type).toBe('message.deleted');
  expect(JSON.stringify(remote.calls)).not.toContain('DENY');
});
it('reuses an immutable idempotent payload after an unknown result and daemon restart', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  await enable(app);
  remote.failNext();
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  await app.memory.flush();
  const dir = app.dir;
  await app.close();
  const next = await createApp(dir, {
    fetcher: remote.fetcher,
    internalToken: 'fixture',
  });
  cleanup.push(async () => {
    await next.close();
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });
  const job = (await next.db.list<MemoryJob>('memory-outbox'))[0]!;
  await next.memory.retry(job.key);
  await next.memory.flush();
  expect(remote.calls).toHaveLength(2);
  expect(remote.calls[1]).toEqual(remote.calls[0]);
});
it('blocks stale evidence while deletion is queued, revalidates revisions, and preserves Unicode source spans', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  await app.memory.flush();
  const found = await app.memory.recall('摄影', scope());
  expect(found.items).toHaveLength(1);
  const repeated = scope();
  await app.memory.recall('摄影', repeated);
  await app.memory.recall('摄影', repeated);
  expect(await app.db.list('memory-recall')).toHaveLength(3);
  expect(JSON.stringify(await app.db.list('memory-recall'))).not.toContain(
    '小林喜欢摄影',
  );
  remote.change();
  expect(await app.memory.validate(found.items, scope())).toBe(false);
  await app.engine.ingest(
    message({
      id: 'quote',
      sourceId: 'quote',
      quote: { text: '😀摄影', sourceId: 'm1' },
      mentions: ['new-member'],
    }),
    { schedule: false },
  );
  await app.memory.flush();
  const body = remote.calls.at(-1)!.body;
  expect(body.events[0].parts[1].source.span).toEqual({ start: 2, end: 5 });
  expect(body.events[0].parts[2].author.external_id).toBe('new-member');
  await app.engine.ingest(
    message({ kind: 'deleted', revision: 2, text: '', mentions: [] }),
    { schedule: false },
  );
  expect((await app.memory.recall('摄影', scope())).items).toHaveLength(0);
});
it('stops old jobs after a binding changes and does not ingest shadow drafts', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  const m = message();
  await app.engine.ingest(m, { schedule: false });
  await app.engine.start(m);
  expect(await app.db.list('memory-outbox')).toHaveLength(1);
  await app.state.save(
    {
      ...app.state.config,
      memory: {
        ...app.state.config.memory,
        bindings: app.state.config.memory.bindings.map((b) => ({
          ...b,
          remoteWorkspaceId: 'other',
        })),
      },
    },
    app.state.revision,
  );
  await app.memory.flush();
  expect(remote.calls).toHaveLength(0);
  expect((await app.db.list<MemoryJob>('memory-outbox'))[0]!.value.code).toBe(
    'memory_binding_changed',
  );
});
it('uses the shared AI ledger behind authenticated, role-limited broker endpoints', async () => {
  let calls = 0;
  let incomplete: 'model' | 'usage' | undefined;
  const app = await fixture(async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.model === 'summary-v1') {
      calls++;
      return Response.json({
        id: 'upstream-request',
        model: incomplete === 'model' ? undefined : 'summary-v1',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"summary":"fixture"}' },
          },
        ],
        usage:
          incomplete === 'usage'
            ? undefined
            : { prompt_tokens: 12, completion_tokens: 8 },
      });
    }
    return fakeFetch(url, init);
  });
  cleanup.push(app.cleanup);
  await enable(app);
  const brokerRef = await app.state.setSecret('broker', 'broker-key');
  await app.state.save(
    {
      ...app.state.config,
      routes: {
        ...app.state.config.routes,
        'memory.summary': { connectionId: 'fixture', model: 'summary-v1' },
      },
      memory: {
        ...app.state.config.memory,
        broker: {
          ...app.state.config.memory.broker,
          enabled: true,
          secretRef: brokerRef,
        },
      },
    },
    app.state.revision,
  );
  await new Promise<void>((r) => app.broker.listen(0, '127.0.0.1', r));
  const address = app.broker.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/v1`,
    id = uid();
  const headers = {
    authorization: 'Bearer broker-key',
    'content-type': 'application/json',
    'X-MemStation-Internal-Call': 'memory-broker-v1',
    'X-MemStation-Broker-Version': '1',
    'X-MemStation-Role': 'summary',
    'X-MemStation-Workspace': 'remote-a',
    'X-MemStation-Call-Id': id,
    'X-MemStation-Job': 'job',
    'X-MemStation-Attempt': '1',
  };
  const body = JSON.stringify({
    model: 'memory.summary',
    stream: false,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: 'fixture' }],
  });
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body,
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('X-MemStation-Model-Version')).toBe('summary-v1');
  expect(r.headers.get('X-MemStation-Usage-Id')).toBe(id);
  expect((await r.json()).choices).toHaveLength(1);
  expect(
    (await fetch(base + '/chat/completions', { method: 'POST', headers, body }))
      .status,
  ).toBe(409);
  expect(
    (
      await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'X-MemStation-Workspace': 'remote-b' },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer wrong' },
        body,
      })
    ).status,
  ).toBe(401);
  expect(
    (await (await fetch(base + '/memory/calls/' + id, { headers })).json())
      .status,
  ).toBe('complete');
  expect(calls).toBe(1);
  const usage = (await app.db.get<Usage>('usage:' + id))!.value;
  expect(usage.inputTokens).toBe(12);
  expect(usage.workspaceId).toBe('group-a');
  for (const field of ['model', 'usage'] as const) {
    incomplete = field;
    const invalidId = uid(),
      invalidHeaders = { ...headers, 'X-MemStation-Call-Id': invalidId };
    expect(
      (
        await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: invalidHeaders,
          body,
        })
      ).status,
    ).toBe(502);
    const reconciliation = await (
      await fetch(base + '/memory/calls/' + invalidId, {
        headers: invalidHeaders,
      })
    ).json();
    expect(reconciliation.status).not.toBe('complete');
    if (field === 'usage')
      expect(
        (await app.db.get<Usage>('usage:' + invalidId))!.value.status,
      ).toBe('unknown');
  }
  expect(calls).toBe(3);
  await app.state.save(
    {
      ...app.state.config,
      memory: { ...app.state.config.memory, enabled: false },
    },
    app.state.revision,
  );
  expect(
    (
      await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'X-MemStation-Call-Id': uid() },
        body,
      })
    ).status,
  ).toBe(503);
  await app.state.save(
    {
      ...app.state.config,
      memory: { ...app.state.config.memory, enabled: true },
      disabledPlugins: ['memory-memstation'],
    },
    app.state.revision,
  );
  expect(
    (
      await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'X-MemStation-Call-Id': uid() },
        body,
      })
    ).status,
  ).toBe(503);
  expect(calls).toBe(3);
});

it('cannot send old message data to a replacement backend during pending safety evaluation', async () => {
  const remote = server();
  let requests = 0;
  const app = await fixture(async (input, init) => {
    if (String(input).startsWith('http://memstation.test')) requests++;
    return remote.fetcher(input, init);
  });
  cleanup.push(app.cleanup);
  await enable(app);
  let release!: () => void, began!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (began = r));
  app.engine.safety = {
    id: 'fixture',
    async check() {
      began();
      await waiting;
      return { allow: true, reason: 'fixture' };
    },
  };
  await app.engine.ingest(message(), { schedule: false });
  const flush = app.memory.flush();
  await started;
  await app.state.save(
    {
      ...app.state.config,
      memory: {
        ...app.state.config.memory,
        baseUrl: 'http://memstation.test/replacement',
      },
    },
    app.state.revision,
  );
  release();
  await flush;
  expect(requests).toBe(0);
});

it('propagates withdrawal of a confirmed bot message without requiring a second delivery receipt', async () => {
  const remote = server(),
    app = await fixture(remote.fetcher);
  cleanup.push(app.cleanup);
  await enable(app);
  const bot = message({
    id: 'bot:confirmed',
    sourceId: 'confirmed',
    actorId: 'bot',
    bot: true,
    mentions: [],
  });
  await app.engine.ingest(message({ mentions: [] }), { schedule: false });
  await app.db.commit([
    {
      key: 'message:group-a:' + bot.id,
      kind: 'message',
      scope: 'group-a',
      value: bot,
      expected: null,
    },
    ...app.memory.prepare(bot, 'confirmed'),
  ]);
  await app.memory.flush();
  await app.engine.ingest(
    { ...bot, kind: 'deleted', revision: 2, text: '' },
    { schedule: false },
  );
  await app.memory.flush();
  expect(
    remote.calls.some(
      (c) =>
        c.body.events[0].type === 'message.deleted' &&
        c.body.events[0].source_revision === 2,
    ),
  ).toBe(true);
});
it('scans beyond timestamp ties without dropping recovery records', async () => {
  const app = await fixture();
  cleanup.push(app.cleanup);
  await app.db.commit(
    Array.from({ length: 1050 }, (_, i) => ({
      key: 'scan:' + String(i).padStart(4, '0'),
      kind: 'scan-test',
      scope: 'test',
      value: i,
      at: 1,
      expected: null,
    })),
  );
  const values: number[] = [];
  let after = '';
  for (;;) {
    const rows = await app.db.scan<number>('scan-test', after, 200);
    values.push(...rows.map((r) => r.value));
    if (rows.length < 200) break;
    after = rows.at(-1)!.key;
  }
  expect(values).toEqual(Array.from({ length: 1050 }, (_, i) => i));
});
it('binds plugin memory proposals to its scope and requires a separate write permission', async () => {
  const remote = server();
  let proposed = 0;
  const app = await fixture(async (input, init) => {
    if (String(input).endsWith('/memory/candidates')) {
      expect(new Headers(init?.headers).get('X-MemStation-Workspace')).toBe(
        'remote-a',
      );
      proposed++;
      return Response.json({ id: 'candidate', status: 'pending' });
    }
    return remote.fetcher(input, init);
  });
  cleanup.push(app.cleanup);
  await enable(app);
  const manifest = {
    ...catalog.find((p) => p.id === 'tool-stickers')!,
    id: 'test-memory-tool',
    permissions: ['memory.read'],
  };
  const candidate = {
    kind: 'fact' as const,
    content: '待审核的观察',
    sources: [],
    actorIds: [],
  };
  await expect(
    scopedServices(
      manifest,
      scope(),
      app.db,
      app.ai,
      app.memory,
    ).memory.propose(candidate),
  ).rejects.toThrow('plugin_permission_denied');
  const result = await scopedServices(
    { ...manifest, permissions: ['memory.propose'] },
    scope(),
    app.db,
    app.ai,
    app.memory,
  ).memory.propose(candidate);
  expect(result.status).toBe('pending');
  expect(proposed).toBe(1);
});
