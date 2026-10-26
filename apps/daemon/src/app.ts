import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SqliteStorage } from '../../../plugins/storage-sqlite/src/index.js';
import {
  State,
  uid,
  errorCode,
  hash,
} from '../../../packages/core/src/state.js';
import {
  AIRuntime,
  limitedJson,
} from '../../../packages/ai-runtime/src/index.js';
import { ConversationEngine } from '../../../packages/core/src/engine.js';
import { DecisionSafety } from '../../../plugins/safety-decisions/src/index.js';
import { disabledMemory } from '../../../plugins/memory-disabled/src/index.js';
import { MemoryService } from '../../../packages/core/src/memory.js';
import { MemStationTransport } from '../../../plugins/memory-memstation/src/index.js';
import { MemoryBroker } from '../../../packages/ai-runtime/src/memory-broker.js';
import {
  QQAdapter,
  normalizeQQ,
  verifyQQ,
  qqChallenge,
} from '../../../plugins/protocol-qq/src/index.js';
import { createTools } from '../../../plugins/tools/src/index.js';
import {
  Scheduler,
  preview,
  type ScheduledJob,
} from '../../../packages/scheduler/src/index.js';
import { pruneHistory } from '../../../packages/core/src/maintenance.js';
import { screenedContext } from '../../../packages/core/src/context.js';
import { refreshProfile } from '../../../packages/core/src/profiles.js';
import {
  installPlugins,
  type MimicPlugin,
} from '../../../packages/plugin-sdk/src/host.js';
import { catalog } from '../../../packages/plugin-sdk/src/catalog.js';
import {
  type Message,
  type Workspace,
  type Run,
  type Usage,
  type ProtocolAdapter,
  type StorageProvider,
  type MemoryProvider,
  type RecordEntry,
  scheduleSchema,
} from '../../../packages/contracts/src/index.js';
export async function body(req: IncomingMessage, max = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
function authorized(value: string | undefined, token: string) {
  const a = Buffer.from(value?.replace(/^Bearer /, '') ?? ''),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function createApp(
  dataDir: string,
  options: {
    fetcher?: typeof fetch;
    internalToken?: string;
    plugins?: MimicPlugin[];
    storage?: StorageProvider;
    memory?: MemoryProvider;
  } = {},
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db =
    options.storage ?? new SqliteStorage(join(dataDir, 'mimic.sqlite'));
  let rollback: (() => Promise<void>) | undefined;
  try {
    const state = new State(db, dataDir);
    await state.init();
    let token = options.internalToken ?? process.env.MIMIC_INTERNAL_TOKEN;
    const tokenPath = join(dataDir, 'control.token');
    if (!token) {
      try {
        token = (await readFile(tokenPath, 'utf8')).trim();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        token = randomBytes(32).toString('hex');
        await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
      }
    }
    if (!token.trim()) throw new Error('internal_token_empty');
    const ai = new AIRuntime(state, options.fetcher),
      safety = new DecisionSafety(ai, state),
      qq = new QQAdapter(state, options.fetcher);
    const memory: MemoryService = new MemoryService(state, () => engine.safety);
    memory.register(
      new MemStationTransport(
        () => state.config.memory,
        (ref) => state.secret(ref),
        options.fetcher,
      ),
    );
    const memoryBroker = new MemoryBroker(state, ai);
    const broker = createServer(async (req, res) => {
      try {
        await memoryBroker.handle(req, res, async () =>
          JSON.parse((await body(req, 2 * 1024 * 1024)).toString()),
        );
      } catch {
        if (!res.headersSent) send(res, 500, { error: 'broker_failed' });
        else res.end();
      }
    });
    const protocols = new Map<string, ProtocolAdapter>([
      ['qq', qq],
      [
        'replay',
        {
          id: 'replay',
          coverage: () => 'all_messages',
          async send() {
            return { status: 'sent' as const, id: `local-${uid()}` };
          },
        },
      ],
    ]);
    const engine: ConversationEngine = new ConversationEngine(
        state,
        ai,
        safety,
        options.memory ?? memory,
        protocols,
        createTools(state, ai),
        options.memory ? undefined : memory,
      ),
      scheduler = new Scheduler(state, engine);
    const lifecycle = new AbortController();
    rollback = async () => {
      lifecycle.abort();
      await Promise.allSettled(
        [...protocols.values()].map((adapter) => adapter.stop?.()),
      );
      await scheduler.stop();
      await engine.cancelAll();
      await memory.close();
      await memoryBroker.close();
    };
    const plugins = options.plugins ?? [];
    await installPlugins(
      plugins,
      {
        state,
        db,
        ai,
        memory: options.memory ?? memory,
        engine,
        scheduler,
      },
      catalog,
    );
    const installedCatalog = [...catalog, ...plugins.map((p) => p.manifest)];
    for (const row of await memory.rows<any>('memory-broker'))
      if (row.value.status === 'processing')
        await db.commit([
          {
            ...row,
            value: {
              ...row.value,
              status: 'unknown',
              code: 'interrupted_request',
            },
            expected: row.revision,
            at: row.at,
          },
        ]);
    // Never replay ambiguous network sends after a crash.
    const interrupted = new Map<
      string,
      { row: RecordEntry<Run>; delivery?: string }
    >();
    for await (const row of state.scan<Run>('run'))
      if (
        ['observing', 'deciding', 'generating', 'deferred'].includes(
          row.value.status,
        )
      )
        interrupted.set(row.value.id, { row });
    for await (const item of state.scan<{ status: string; runId?: string }>(
      'send',
    )) {
      const run = item.value.runId
        ? interrupted.get(item.value.runId)
        : undefined;
      if (run)
        run.delivery =
          item.value.status === 'sending' ? 'unknown' : item.value.status;
      if (item.value.status === 'sending')
        await db.commit([
          {
            key: item.key,
            kind: item.kind,
            scope: item.scope,
            value: {
              ...item.value,
              status: 'unknown',
              code: 'restart_during_send',
            },
            expected: item.revision,
          },
        ]);
    }
    for (const { row, delivery } of interrupted.values()) {
      const status =
        delivery === 'sent'
          ? 'sent'
          : delivery === 'unknown'
            ? 'unknown'
            : delivery === 'failed'
              ? 'failed'
              : 'cancelled';
      await db.commit([
        {
          ...row,
          value: {
            ...row.value,
            status,
            reason: delivery
              ? 'restart_after_delivery_reservation'
              : 'restart_during_run',
            endedAt: Date.now(),
          },
          expected: row.revision,
          at: row.at,
        },
      ]);
    }
    for await (const row of state.scan<Usage>('usage'))
      if (row.value.status === 'pending')
        await db.commit([
          {
            key: row.key,
            kind: row.kind,
            scope: row.scope,
            value: {
              ...row.value,
              status: 'unknown',
              error: 'interrupted_request',
            },
            expected: row.revision,
          },
        ]);
    for (const adapter of protocols.values())
      await adapter.start?.((event) => engine.ingest(event), lifecycle.signal);
    memory.start();
    const maintenance = setInterval(() => {
      void pruneHistory(state).catch((e) =>
        state.audit('retention.failed', { code: errorCode(e) }),
      );
    }, 86400000);
    maintenance.unref();
    const api = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health/live')
        return send(res, 200, { status: 'alive' });
      if (!authorized(req.headers.authorization, token!))
        return send(res, 401, { error: 'unauthorized' });
      try {
        const scope = url.searchParams.get('scope') ?? undefined;
        const limit = Math.min(
          Number(url.searchParams.get('limit') ?? 100),
          200,
        );
        if (!Number.isInteger(limit) || limit < 1)
          throw new Error('invalid_limit');
        const data =
          req.method === 'POST' || req.method === 'PUT'
            ? JSON.parse((await body(req, 2 * 1024 * 1024)).toString() || '{}')
            : {};
        const pluginConfig = url.pathname.match(
          /^\/api\/plugins\/([a-z][a-z0-9-]*)\/config\/([a-zA-Z0-9_.-]{1,100})$/,
        );
        if (pluginConfig) {
          const [, pluginId, key] = pluginConfig;
          if (!installedCatalog.some((p) => p.id === pluginId))
            throw new Error('plugin_missing');
          const storageKey = `plugin-config:${pluginId}:${key}`;
          if (req.method === 'GET')
            return send(res, 200, {
              record: (await db.get(storageKey)) ?? null,
            });
          if (req.method === 'PUT') {
            const value = z.json().parse(data.value);
            if (JSON.stringify(value).length > 65536)
              throw new Error('plugin_record_too_large');
            await db.commit([
              {
                key: storageKey,
                kind: 'plugin-config',
                scope: 'system',
                value,
                expected: z.number().int().nullable().parse(data.revision),
              },
            ]);
            await engine.cancelAll();
            return send(res, 200, { record: await db.get(storageKey) });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/overview') {
          const [workspaces, runs, usage, jobs] = await Promise.all([
            db.list<Workspace>('workspace', undefined, 200),
            db.list<Run>('run', undefined, 100),
            db.list<Usage>('usage', undefined, 1000),
            db.list('job', undefined, 10),
          ]);
          return send(res, 200, {
            status: state.config.paused ? 'paused' : 'ready',
            mode: state.config.mode,
            memory: state.config.memory.enabled
              ? state.config.memory.provider
              : 'disabled',
            workspaces: workspaces.length,
            runs: runs.map((r) => r.value).slice(0, 8),
            usage: {
              calls: usage.length,
              inputTokens: usage.reduce(
                (n, r) => n + (r.value.inputTokens ?? 0),
                0,
              ),
              outputTokens: usage.reduce(
                (n, r) => n + (r.value.outputTokens ?? 0),
                0,
              ),
              unknown: usage.filter((r) => r.value.status === 'unknown').length,
              window: 'latest_1000_calls',
              cost: null,
            },
            jobs: jobs.map((r) => r.value),
            configured: Object.keys(state.config.routes),
            qqEnabled: state.config.qq.enabled,
          });
        }
        if (url.pathname === '/api/config') {
          if (req.method === 'GET')
            return send(res, 200, {
              config: state.config,
              revision: state.revision,
            });
          if (req.method === 'PUT') {
            await state.save(
              data.config,
              z.number().int().parse(data.revision),
            );
            qq.reset();
            await engine.cancelAll();
            return send(res, 200, {
              config: state.config,
              revision: state.revision,
            });
          }
        }
        if (url.pathname === '/api/memory' && req.method === 'GET') {
          return send(res, 200, {
            enabled: state.config.memory.enabled,
            bindings: state.config.memory.bindings,
            jobs: await db.list('memory-outbox', scope, limit),
            recalls: await db.list('memory-recall', scope, limit),
            operations: await db.list('memory-operation', scope, limit),
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/probe')
          return send(
            res,
            200,
            await memory
              .provider()
              .probe(memory.context(z.string().parse(data.workspaceId))),
          );
        if (req.method === 'POST' && url.pathname === '/api/memory/flush') {
          await memory.flush();
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/retry') {
          await memory.retry(z.string().parse(data.key));
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/search')
          return send(
            res,
            200,
            await memory.recall(
              z.string().min(1).max(16000).parse(data.query),
              memory.context(z.string().parse(data.workspaceId)),
              z
                .object({
                  actorIds: z
                    .array(z.string().min(1).max(256))
                    .max(64)
                    .optional(),
                  from: z.iso.datetime().optional(),
                  to: z.iso.datetime().optional(),
                })
                .parse(data),
            ),
          );
        if (req.method === 'POST' && url.pathname === '/api/memory/inspect')
          return send(
            res,
            200,
            await memory
              .provider()
              .inspect(
                z.string().parse(data.id),
                memory.context(z.string().parse(data.workspaceId)),
              ),
          );
        if (req.method === 'POST' && url.pathname === '/api/memory/source')
          return send(
            res,
            200,
            await memory
              .provider()
              .source(
                z.string().parse(data.id),
                memory.context(z.string().parse(data.workspaceId)),
              ),
          );
        if (req.method === 'POST' && url.pathname === '/api/memory/operation') {
          const input = z
            .object({
              workspaceId: z.string(),
              action: z.enum([
                'forget',
                'retract',
                'export',
                'operation',
                'finalize',
              ]),
              value: z.record(z.string(), z.unknown()),
              key: z.string().min(1).max(200),
            })
            .strict()
            .parse(data);
          const result = await memory
            .provider()
            .operation(
              input.action,
              input.value,
              input.key,
              memory.context(input.workspaceId),
            );
          const key =
              'memory-operation:' + hash([input.workspaceId, input.key]),
            prior = await db.get(key);
          await db.commit([
            {
              key,
              kind: 'memory-operation',
              scope: input.workspaceId,
              value: { ...result, result: undefined },
              expected: prior?.revision ?? null,
            },
          ]);
          await engine.cancelAll();
          return send(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/secrets') {
          const input = z
            .object({
              name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
              value: z.string().min(1),
            })
            .parse(data);
          return send(res, 200, {
            ref: await state.setSecret(
              input.name.slice(0, 63) + '-' + uid(),
              input.value,
            ),
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/plugins')
          return send(res, 200, {
            items: installedCatalog.map((p) => ({
              ...p,
              enabled: !state.config.disabledPlugins.includes(p.id),
              status:
                p.id === 'memory-memstation'
                  ? state.config.memory.enabled
                    ? 'configured'
                    : 'disabled'
                  : p.id === 'tool-node'
                    ? 'requires_preflight'
                    : p.id === 'protocol-qq' && !state.config.qq.enabled
                      ? 'unconfigured'
                      : 'available',
            })),
          });
        const kinds: Record<string, string> = {
          '/api/workspaces': 'workspace',
          '/api/messages': 'message',
          '/api/runs': 'run',
          '/api/usage': 'usage',
          '/api/logs': 'audit',
          '/api/tasks': 'schedule',
          '/api/jobs': 'job',
          '/api/frames': 'frame',
          '/api/topics': 'topic',
          '/api/profiles': 'group-profile',
        };
        if (req.method === 'GET' && kinds[url.pathname]) {
          const cursor = url.searchParams.has('cursor')
            ? z
                .object({
                  at: z.number().int().safe(),
                  key: z.string().min(1).max(1000),
                })
                .parse(
                  JSON.parse(
                    Buffer.from(
                      z
                        .string()
                        .max(2048)
                        .regex(/^[A-Za-z0-9_-]+$/)
                        .parse(url.searchParams.get('cursor')),
                      'base64url',
                    ).toString('utf8'),
                  ),
                )
            : undefined;
          const rows = await db.list(
            kinds[url.pathname]!,
            scope,
            limit,
            cursor?.at ??
              (url.searchParams.has('before')
                ? z.coerce
                    .number()
                    .int()
                    .safe()
                    .parse(url.searchParams.get('before'))
                : undefined),
            cursor?.key,
          );
          return send(res, 200, {
            items: rows,
            nextBefore: rows.length === limit ? rows.at(-1)?.at : null,
            nextCursor:
              rows.length === limit
                ? Buffer.from(
                    JSON.stringify({
                      at: rows.at(-1)!.at,
                      key: rows.at(-1)!.key,
                    }),
                  ).toString('base64url')
                : null,
          });
        }
        if (req.method === 'PUT' && url.pathname === '/api/workspaces') {
          const input = z
            .object({
              id: z.string(),
              revision: z.number(),
              name: z.string().min(1).max(100),
              paused: z.boolean(),
              proactive: z.boolean(),
            })
            .parse(data);
          const row = await db.get<Workspace>(`workspace:${input.id}`);
          if (!row) throw new Error('workspace_missing');
          await db.commit([
            {
              key: row.key,
              kind: 'workspace',
              scope: row.scope,
              value: {
                ...row.value,
                name: input.name,
                paused: input.paused,
                proactive: input.proactive,
                revision: row.value.revision + 1,
              },
              expected: input.revision,
            },
          ]);
          await engine.cancelAll();
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/replay') {
          const input = z
            .object({
              workspace: z.string().min(1).max(80).default('开发回放'),
              actor: z.string().min(1).max(80).default('小林'),
              text: z.string().min(1).max(16000),
              mention: z.boolean().default(true),
              replyTo: z.string().optional(),
            })
            .parse(data);
          const message: Message = {
            id: uid(),
            sourceId: uid(),
            connectionId: 'replay',
            workspaceId: `replay:${input.workspace}`,
            actorId: input.actor,
            actorName: input.actor,
            text: input.text,
            kind: 'created',
            revision: 1,
            occurredAt: Date.now(),
            receivedAt: Date.now(),
            bot: false,
            direct: false,
            mentions: input.mention ? ['bot'] : [],
            attachments: [],
            replyTo: input.replyTo,
          };
          await engine.ingest(message);
          return send(res, 202, { message, localOnly: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/messages/delete') {
          const input = z
              .object({ scope: z.string(), id: z.string() })
              .parse(data),
            row = await db.get<Message>(`message:${input.scope}:${input.id}`);
          if (!row) throw new Error('message_missing');
          await engine.ingest({
            ...row.value,
            text: '',
            kind: 'deleted',
            revision: row.value.revision + 1,
            receivedAt: Date.now(),
          });
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/model/probe') {
          const input = z
            .object({ role: z.enum(['chat', 'participation', 'safety']) })
            .parse(data);
          const ctx = {
            workspaceId: 'system',
            runId: uid(),
            pluginId: 'admin-probe',
            signal: AbortSignal.timeout(15000),
          };
          const start = Date.now();
          if (input.role === 'chat')
            await ai.generate(
              [{ role: 'user', content: 'Reply with OK.' }],
              [],
              ctx,
            );
          else
            await ai.decide(
              input.role,
              { text: '正常问候' },
              [
                {
                  name: 'greeting',
                  type: 'predicate',
                  instructions: 'Is this a greeting?',
                },
              ],
              ctx,
            );
          return send(res, 200, {
            ok: true,
            latencyMs: Date.now() - start,
            billable: true,
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/tasks') {
          return send(
            res,
            200,
            await scheduler.save(
              data.spec,
              z.number().nullable().parse(data.revision),
            ),
          );
        }
        if (req.method === 'POST' && url.pathname === '/api/tasks/preview')
          return send(res, 200, preview(scheduleSchema.parse(data)));
        if (req.method === 'POST' && url.pathname === '/api/tasks/run') {
          return send(
            res,
            200,
            await scheduler.execute(
              z.string().parse(data.id),
              data.dryRun !== false,
            ),
          );
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/api/tasks/')) {
          const row = await db.get(
            `schedule:${decodeURIComponent(url.pathname.slice(11))}`,
          );
          if (row) await db.delete(row.key, row.revision);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/assets') {
          const rows = await db.list<{ data: string }>(
            'asset',
            'approved',
            100,
          );
          return send(res, 200, {
            items: rows.map((r) => ({
              ...r,
              value: { ...r.value, data: undefined },
            })),
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/assets') {
          const input = z
            .object({
              name: z.string().max(100),
              tags: z.string().max(500),
              alt: z.string().max(500),
              mime: z.enum(['image/png', 'image/jpeg']),
              data: z.string().max(1400000),
              source: z.string().max(1000),
            })
            .parse(data);
          const bytes = Buffer.from(input.data, 'base64');
          if (bytes.length > 1024 * 1024 || bytes.length < 8)
            throw new Error('invalid_image');
          if (
            input.mime === 'image/png'
              ? !bytes
                  .subarray(0, 8)
                  .equals(Buffer.from('89504e470d0a1a0a', 'hex'))
              : bytes[0] !== 255 || bytes[1] !== 216
          )
            throw new Error('invalid_image');
          const id = uid();
          await db.commit([
            {
              key: `asset:${id}`,
              kind: 'asset',
              scope: 'approved',
              value: input,
              expected: null,
            },
          ]);
          return send(res, 201, { id });
        }
        if (url.pathname.startsWith('/api/assets/') && req.method === 'GET') {
          const row = await db.get<{ data: string; mime: string }>(
            `asset:${url.pathname.slice(12)}`,
          );
          if (!row) return send(res, 404, { error: 'asset_missing' });
          res.writeHead(200, {
            'content-type': row.value.mime,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          });
          return res.end(Buffer.from(row.value.data, 'base64'));
        }
        if (
          url.pathname.startsWith('/api/assets/') &&
          req.method === 'DELETE'
        ) {
          const row = await db.get(`asset:${url.pathname.slice(12)}`);
          if (row) await db.delete(row.key, row.revision);
          return send(res, 200, { ok: true });
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/api/sandbox/preflight'
        ) {
          const base = process.env.MIMIC_SANDBOX_URL,
            key = process.env.MIMIC_SANDBOX_TOKEN;
          if (!base || !key) throw new Error('sandbox_broker_unconfigured');
          const response = await fetch(`${base}/preflight`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${key}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ driver: state.config.tools.sandboxDriver }),
            signal: AbortSignal.timeout(20000),
          });
          return send(res, response.status, await limitedJson(response));
        }
        if (req.method === 'GET' && url.pathname === '/api/system')
          return send(res, 200, {
            ...(await db.stats()),
            node: process.version,
            platform: process.platform,
            memory: state.config.memory.enabled
              ? state.config.memory.provider
              : 'disabled',
            sandboxConfigured: !!process.env.MIMIC_SANDBOX_URL,
            retentionDays: state.config.retentionDays,
          });
        if (req.method === 'POST' && url.pathname === '/api/backup') {
          const name = `backup-${Date.now()}.sqlite`;
          if (!('backup' in db) || typeof db.backup !== 'function')
            throw new Error('backup_unsupported');
          await db.backup(join(dataDir, name));
          await state.audit('backup.created', { name });
          return send(res, 200, { name, masterKeySeparate: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/profile/refresh') {
          const workspaceId = z.string().parse(data.workspaceId);
          const latest = (await db.list<Message>('message', workspaceId, 1))[0]
            ?.value;
          if (!latest) throw new Error('workspace_empty');
          const ctx = {
            workspaceId,
            runId: uid(),
            pluginId: 'behavior-scheduled',
            signal: AbortSignal.timeout(30000),
          };
          const context = await screenedContext(
            state,
            engine.safety,
            latest,
            ctx,
          );
          if (!context.allow) throw new Error('profile_input_denied');
          await refreshProfile(state, ai, context.messages, ctx, true);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/retention/run') {
          await engine.cancelAll();
          return send(res, 200, await pruneHistory(state));
        }
        if (req.method === 'POST' && url.pathname === '/api/soul/reload') {
          const soul = await readFile(join(dataDir, 'soul.md'), 'utf8');
          await state.save({ ...state.config, soul }, state.revision);
          await engine.cancelAll();
          return send(res, 200, { ok: true, revision: state.revision });
        }
        return send(res, 404, { error: 'not_found' });
      } catch (e) {
        return send(res, errorCode(e) === 'revision_conflict' ? 409 : 422, {
          error: e instanceof z.ZodError ? 'validation_failed' : errorCode(e),
        });
      }
    });
    const ingress = createServer(async (req, res) => {
      if (req.url === '/health/live')
        return send(res, 200, { status: 'alive' });
      if (req.method !== 'POST' || req.url !== '/qq/webhook')
        return send(res, 404, { error: 'not_found' });
      try {
        if (
          !state.config.qq.enabled ||
          state.config.disabledPlugins.includes('protocol-qq')
        )
          return send(res, 503, { error: 'qq_disabled' });
        const raw = await body(req);
        const secret = await state.secret(state.config.qq.secretRef);
        if (req.headers['x-bot-appid'] !== state.config.qq.appId)
          return send(res, 401, { error: 'invalid_app' });
        const input = JSON.parse(raw.toString());
        if (input.op === 13) {
          const d = z
            .object({
              plain_token: z.string().min(1).max(256),
              event_ts: z.string().regex(/^\d{10}$/),
            })
            .parse(input.d);
          return send(res, 200, qqChallenge(secret, d.plain_token, d.event_ts));
        }
        if (
          !verifyQQ(
            secret,
            String(req.headers['x-signature-timestamp'] ?? ''),
            raw,
            String(req.headers['x-signature-ed25519'] ?? ''),
          )
        )
          return send(res, 401, { error: 'invalid_signature' });
        if (
          [
            'GROUP_MESSAGE_CREATE',
            'GROUP_AT_MESSAGE_CREATE',
            'C2C_MESSAGE_CREATE',
          ].includes(input.t)
        ) {
          const message = normalizeQQ(input, state.config.qq.appId);
          if (message) await engine.ingest(message);
        }
        return send(res, 200, { op: 12 });
      } catch (e) {
        return send(res, 422, { error: errorCode(e) });
      }
    });
    return {
      state,
      db,
      ai,
      memory,
      broker,
      engine,
      scheduler,
      api,
      ingress,
      async close() {
        clearInterval(maintenance);
        lifecycle.abort();
        for (const adapter of protocols.values()) await adapter.stop?.();
        await scheduler.stop();
        await engine.cancelAll();
        await memory.close();
        await memoryBroker.close();
        await Promise.all([
          new Promise<void>((r) => api.close(() => r())),
          new Promise<void>((r) => ingress.close(() => r())),
          new Promise<void>((r) => broker.close(() => r())),
        ]);
        await db.close();
      },
    };
  } catch (error) {
    await rollback?.().catch(() => {});
    await db.close().catch(() => {});
    throw error;
  }
}
