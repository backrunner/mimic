/** Called by the Go joint harness. Every model response is a deterministic fixture. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/daemon/src/app.js';
import { message } from './helpers.js';
import { uid } from '../packages/core/src/state.js';
import type { MemoryJob } from '../packages/core/src/memory.js';
import type { Usage } from '../packages/contracts/src/index.js';
const seedPath = process.env.MIMIC_JOINT_SEED!;
const seed = JSON.parse(await readFile(seedPath, 'utf8'));
const dir = await mkdtemp(join(tmpdir(), 'mimic-joint-'));
const fixtureCalls: string[] = [];
const fetcher: typeof fetch = async (input, init) => {
  if (!String(input).startsWith('http://fixture-upstream')) {
    const response = await fetch(input, init);
    return response;
  }
  const body = JSON.parse(String(init?.body));
  const path = new URL(String(input)).pathname;
  const role = path.endsWith('/embeddings')
    ? 'embedding'
    : path.endsWith('/rerank')
      ? 'rerank'
      : body.model === 'summary-fixture'
        ? 'summary'
        : 'analysis';
  fixtureCalls.push(role);
  const docs = body.documents?.map((text: string, i: number) => ({
    id: String(i),
    text,
  }));
  const response = await fetch(
    seed.upstream +
      '/v1' +
      (role === 'rerank'
        ? '/memory/rerank/v1'
        : role === 'embedding'
          ? '/embeddings'
          : '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fixture-broker',
        'X-MemStation-Internal-Call': 'memory-broker-v1',
        'X-MemStation-Role': role,
        'X-MemStation-Workspace': 'fixture',
        'X-MemStation-Call-Id': uid(),
        'X-MemStation-Embedding-Fingerprint': 'fixture-embedding-v1:3',
      },
      body: JSON.stringify({
        ...body,
        model: 'memory.' + role,
        ...(docs ? { documents: docs } : {}),
      }),
    },
  );
  const data = await response.json();
  if (role === 'rerank')
    return Response.json({
      ...data,
      model: 'fixture-rerank-v1',
      results: data.results.map((r: any) => ({
        index: Number(r.document_id),
        relevance_score: r.score,
      })),
    });
  return Response.json(data, { status: response.status });
};
const app = await createApp(dir, { fetcher, internalToken: 'joint-control' });
async function wait<T>(
  fn: () => Promise<T | false>,
  label: string,
): Promise<T> {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== false) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('joint_timeout:' + label);
}
try {
  const key = await app.state.setSecret('memstation', seed.key),
    brokerKey = await app.state.setSecret('broker', 'joint-broker');
  await app.state.save(
    {
      ...app.state.config,
      safety: { mode: 'off', threshold: 0.75 },
      budgets: { ...app.state.config.budgets, dailyCalls: 10000, runCalls: 30 },
      connections: [
        {
          id: 'fixture',
          name: 'Fixture only',
          provider: 'local',
          baseUrl: 'http://fixture-upstream',
          protocol: 'chat',
          secretRef: '',
          enabled: true,
        },
      ],
      routes: Object.fromEntries(
        [
          ['memory.summary', 'summary-fixture'],
          ['memory.analysis', 'analysis-fixture'],
          ['memory.embedding', 'fixture-embedding-v1'],
          ['memory.rerank', 'rerank-fixture'],
        ].map(([role, model]) => [role, { connectionId: 'fixture', model }]),
      ),
      memory: {
        ...app.state.config.memory,
        secretRef: key,
        bindings: seed.bindings,
        timeoutMs: 10000,
        broker: {
          ...app.state.config.memory.broker,
          enabled: true,
          secretRef: brokerKey,
          embeddingModel: 'fixture-embedding-v1',
          embeddingFingerprint: 'fixture-embedding-v1:3',
          embeddingDimensions: 3,
        },
      },
    },
    app.state.revision,
  );
  await new Promise<void>((r) => app.broker.listen(0, '127.0.0.1', r));
  await writeFile(
    seedPath + '.ready',
    JSON.stringify({
      url: 'http://127.0.0.1:' + (app.broker.address() as any).port,
    }),
  );
  const url = await wait(async () => {
    try {
      return await readFile(seedPath + '.url', 'utf8');
    } catch {
      return false;
    }
  }, 'memstation_url');
  await app.state.save(
    {
      ...app.state.config,
      memory: { ...app.state.config.memory, enabled: true, baseUrl: url },
    },
    app.state.revision,
  );
  for (const [i, city] of ['上海', '北京'].entries()) {
    const workspaceId = 'joint-' + i;
    const m = message({
      id: 'member-message',
      sourceId: 'platform-message',
      workspaceId,
      actorId: 'alice',
      actorName: '同名',
      text: '我在' + city + '工作。',
      mentions: ['first-seen-member'],
    });
    await app.engine.ingest(m, { schedule: false });
  }
  await app.memory.flush();
  const jobs = await app.db.list<MemoryJob>('memory-outbox');
  if (jobs.length !== 2 || jobs.some((j) => j.value.status !== 'accepted'))
    throw new Error(
      'joint_ingestion_failed:' + JSON.stringify(jobs.map((j) => j.value)),
    );
  for (const job of jobs) {
    const ctx = app.memory.context(job.scope),
      id = (job.value.receipt as any).events[0].conversation_id;
    const window = await (app.memory.provider() as any).call(
      '/api/v1/conversations/' + id,
      'GET',
      undefined,
      ctx,
    );
    await app.memory
      .provider()
      .operation(
        'finalize',
        { id, expected_revision: window.revision },
        uid(),
        ctx,
      );
  }
  await wait(async () => {
    await app.memory.flush();
    const rows = await app.db.list<MemoryJob>('memory-outbox');
    return rows.every((r) => r.value.status === 'indexed') ? true : false;
  }, 'indexed');
  const recalls = [];
  for (const [i, city] of ['上海', '北京'].entries()) {
    const ctx = app.memory.context('joint-' + i),
      found = await app.memory.recall('工作', ctx);
    if (
      !found.items.length ||
      !found.items.some((m) => m.content.includes(city)) ||
      found.items.some((m) => m.content.includes(i === 0 ? '北京' : '上海'))
    )
      throw new Error('joint_scope_recall:' + JSON.stringify(found));
    recalls.push(found);
    const receipt = jobs.find((j) => j.scope === 'joint-' + i)!.value
      .receipt! as any;
    const source = await app.memory
      .provider()
      .source(receipt.events[0].message_id, ctx);
    if (!source.parts.find((p: any) => p.type === 'mention' && p.actor_id))
      throw new Error('joint_mention_unresolved');
  }
  const foreign = recalls[0]!.items[0]!.id;
  await app.memory
    .provider()
    .inspect(foreign, app.memory.context('joint-1'))
    .then(
      () => {
        throw new Error('joint_cross_scope_read');
      },
      (e) => {
        if (!String(e).includes('404')) throw e;
      },
    );
  await app.engine.ingest(
    message({
      id: 'member-message',
      sourceId: 'platform-message',
      workspaceId: 'joint-0',
      actorId: 'alice',
      text: '',
      kind: 'deleted',
      revision: 2,
      mentions: [],
    }),
    { schedule: false },
  );
  await app.memory.flush();
  if (
    await app.memory.validate(recalls[0]!.items, app.memory.context('joint-0'))
  )
    throw new Error('joint_deleted_memory_readable');
  const usage = (await app.db.list<Usage>('usage', undefined, 1000)).map(
    (r) => r.value,
  );
  if (
    !usage.length ||
    usage.some(
      (u) => u.status !== 'reported' || u.pluginId !== 'memory-memstation',
    ) ||
    new Set(usage.map((u) => u.id)).size !== usage.length
  )
    throw new Error('joint_usage_invalid');
  const report = {
    status: 'passed',
    joint: true,
    model: 'deterministic fixture only',
    checks: [
      'actual TypeScript transport and MemStation HTTP',
      'PostgreSQL outbox and Redis workers',
      'MemStation -> actual Mimic broker -> shared AIRuntime',
      'two groups with same display name',
      'first-seen external mention',
      'indexed watermarks',
      'scoped recall and cross-ID denial',
      'source deletion invalidation',
      'single usage ledger',
    ],
    providerCalls: fixtureCalls.length,
    roles: [...new Set(fixtureCalls)],
    usageRows: usage.length,
    groups: 2,
  };
  if (
    ['summary', 'analysis', 'embedding', 'rerank'].some(
      (role) => !fixtureCalls.includes(role),
    )
  )
    throw new Error('joint_missing_model_role');
  await writeFile(seed.report, JSON.stringify(report, null, 2) + '\n');
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
