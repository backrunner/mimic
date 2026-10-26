import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Usage, Scope } from '../../contracts/src/index.js';
import type { State } from '../../core/src/state.js';
import { hash, errorCode } from '../../core/src/state.js';
import type { AIRuntime } from './index.js';

const tokenEqual = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const callId = z.string().uuid();
const documents = z
  .array(
    z
      .object({ id: z.string().min(1).max(256), text: z.string().max(65536) })
      .strict(),
  )
  .min(1)
  .max(200);
export class MemoryBroker {
  #pending = new Set<Promise<void>>();
  constructor(
    readonly state: State,
    readonly ai: AIRuntime,
  ) {}
  async close() {
    await Promise.allSettled([...this.#pending]);
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    read: () => Promise<unknown>,
  ) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const config = this.state.config.memory,
      broker = config.broker;
    const reply = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'X-MemStation-Broker-Version': '1',
      });
      res.end(JSON.stringify(value));
    };
    if (
      !broker.enabled ||
      !config.enabled ||
      this.state.config.disabledPlugins.includes('memory-' + config.provider)
    )
      return reply(503, { error: 'memory_broker_disabled' });
    const key = await this.state.secret(broker.secretRef);
    if (
      !key ||
      !tokenEqual(String(req.headers.authorization ?? ''), 'Bearer ' + key)
    )
      return reply(401, { error: 'unauthorized' });
    const header = (name: string, empty = false) => {
      if (
        req.rawHeaders
          .filter((_, i) => i % 2 === 0)
          .filter((k) => k.toLowerCase() === name).length > 1
      )
        throw new Error('duplicate_broker_header');
      return z
        .string()
        .min(empty ? 0 : 1)
        .max(256)
        .parse(req.headers[name]);
    };
    try {
      if (
        header('x-memstation-internal-call') !== 'memory-broker-v1' ||
        header('x-memstation-broker-version') !== '1'
      )
        return reply(403, { error: 'broker_contract_required' });
      const workspace = header('x-memstation-workspace'),
        role = z
          .enum(['summary', 'analysis', 'embedding', 'rerank'])
          .parse(header('x-memstation-role'));
      const binding = config.bindings.find(
        (b) => b.remoteWorkspaceId === workspace,
      );
      if (!binding) return reply(403, { error: 'broker_workspace_denied' });
      if (req.method === 'GET' && path.startsWith('/v1/memory/calls/')) {
        const id = callId.parse(path.slice('/v1/memory/calls/'.length));
        const row = await this.state.db.get<any>('memory-broker:' + id);
        if (
          !row ||
          row.value.workspace !== workspace ||
          row.value.role !== role
        )
          return reply(404, { error: 'not_found' });
        const usage = await this.state.db.get<Usage>('usage:' + id);
        const u = usage?.value;
        return reply(200, {
          call_id: id,
          workspace_id: workspace,
          role,
          status:
            row.value.status === 'complete'
              ? 'complete'
              : u?.status === 'unknown'
                ? 'unknown'
                : row.value.status === 'unknown'
                  ? 'unknown'
                  : row.value.status === 'failed'
                    ? 'failed'
                    : 'processing',
          usage_id: id,
          request_id: u?.providerRequestId ?? id,
          model_version: u?.model ?? '',
          ...(u?.inputTokens !== undefined
            ? { input_tokens: u.inputTokens }
            : {}),
          ...(u?.outputTokens !== undefined
            ? { output_tokens: u.outputTokens }
            : {}),
          failure_code: row.value.code ?? u?.error,
        });
      }
      const allowed: Record<string, string> = {
        summary: '/v1/chat/completions',
        analysis: '/v1/chat/completions',
        embedding: '/v1/embeddings',
        rerank: '/v1/memory/rerank/v1',
      };
      if (req.method !== 'POST' || allowed[role] !== path)
        return reply(403, { error: 'broker_role_denied' });
      const id = callId.parse(header('x-memstation-call-id'));
      const job = z.string().max(200).parse(header('x-memstation-job', true));
      const attempt = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(header('x-memstation-attempt'));
      const raw = await read();
      let input: any;
      if (role === 'summary' || role === 'analysis')
        input = z
          .object({
            model: z.literal('memory.' + role),
            stream: z.literal(false),
            messages: z
              .array(
                z
                  .object({
                    role: z.enum(['system', 'user', 'assistant']),
                    content: z.string().max(1000000),
                  })
                  .strict(),
              )
              .min(1)
              .max(200),
            max_tokens: z.number().int().min(1).max(32768),
            response_format: z.object({ type: z.literal('json_object') }),
            reasoning_effort: z
              .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
              .optional(),
          })
          .strict()
          .parse(raw);
      else if (role === 'embedding') {
        input = z
          .object({
            model: z.literal('memory.embedding'),
            input: z.string().max(1000000),
            dimensions: z.literal(broker.embeddingDimensions),
          })
          .strict()
          .parse(raw);
        if (
          !broker.embeddingModel ||
          !broker.embeddingFingerprint ||
          header('x-memstation-model-version') !== broker.embeddingModel ||
          header('x-memstation-embedding-fingerprint') !==
            broker.embeddingFingerprint
        )
          return reply(409, { error: 'embedding_identity_mismatch' });
      } else {
        input = z
          .object({
            version: z.literal(1),
            model: z.literal('memory.rerank'),
            query: z.string().max(16000),
            documents,
            top_n: z.number().int().min(1).max(200),
          })
          .strict()
          .parse(raw);
        if (
          input.top_n !== input.documents.length ||
          new Set(input.documents.map((d: any) => d.id)).size !==
            input.documents.length
        )
          return reply(422, { error: 'invalid_rerank_batch' });
      }
      const fingerprint = hash([workspace, role, job, attempt, input]);
      const prior = await this.state.db.get<any>('memory-broker:' + id);
      if (prior)
        return reply(prior.value.fingerprint === fingerprint ? 409 : 409, {
          error:
            prior.value.fingerprint === fingerprint
              ? 'call_already_reserved'
              : 'idempotency_conflict',
        });
      await this.state.db.commit([
        {
          key: 'memory-broker:' + id,
          kind: 'memory-broker',
          scope: binding.workspaceId,
          value: {
            workspace,
            role,
            fingerprint,
            status: 'processing',
            job,
            attempt,
          },
          expected: null,
        },
      ]);
      // Client disconnection does not cancel accounting; a retry uses another Call-Id.
      const operation = (async () => {
        try {
          const scope: Scope = {
            workspaceId: binding.workspaceId,
            runId: 'memory-job:' + hash([workspace, job || id, attempt]),
            pluginId: 'memory-memstation',
            signal: AbortSignal.timeout(broker.timeoutMs),
          };
          const data = await this.ai.memoryCall(
            'memory.' + role,
            role === 'summary' || role === 'analysis' ? 'text' : role,
            input,
            scope,
            id,
          );
          const usage = (await this.state.db.get<Usage>('usage:' + id))!.value;
          if (
            usage.status !== 'reported' ||
            usage.inputTokens === undefined ||
            typeof data.model !== 'string' ||
            !data.model.trim() ||
            ((role === 'summary' || role === 'analysis') &&
              usage.outputTokens === undefined)
          )
            throw new Error('broker_usage_incomplete');
          if (role === 'embedding' && data.model !== broker.embeddingModel)
            throw new Error('embedding_identity_mismatch');
          if (role === 'summary' || role === 'analysis')
            z.object({
              choices: z
                .array(
                  z.object({
                    message: z.object({
                      role: z.literal('assistant'),
                      content: z.string(),
                    }),
                    finish_reason: z.string(),
                  }),
                )
                .length(1),
            }).parse(data);
          const current = await this.state.db.get<any>('memory-broker:' + id);
          await this.state.db.commit([
            {
              ...current!,
              value: { ...current!.value, status: 'complete' },
              expected: current!.revision,
            },
          ]);
          res.setHeader('X-MemStation-Call-Id', id);
          res.setHeader('X-MemStation-Usage-Id', id);
          res.setHeader(
            'X-MemStation-Request-Id',
            usage.providerRequestId ?? id,
          );
          res.setHeader(
            'X-MemStation-Model-Version',
            String(data.model ?? usage.model),
          );
          if (role === 'embedding')
            res.setHeader(
              'X-MemStation-Embedding-Fingerprint',
              broker.embeddingFingerprint,
            );
          reply(200, {
            ...data,
            model: data.model ?? usage.model,
            usage: {
              prompt_tokens: usage.inputTokens,
              ...(usage.outputTokens !== undefined
                ? { completion_tokens: usage.outputTokens }
                : {}),
            },
          });
        } catch (e) {
          const current = await this.state.db.get<any>('memory-broker:' + id);
          if (current)
            await this.state.db.commit([
              {
                ...current,
                value: {
                  ...current.value,
                  status: 'failed',
                  code: errorCode(e),
                },
                expected: current.revision,
              },
            ]);
          reply(502, { error: errorCode(e) });
        }
      })();
      this.#pending.add(operation);
      try {
        await operation;
      } finally {
        this.#pending.delete(operation);
      }
    } catch (e) {
      reply(errorCode(e) === 'revision_conflict' ? 409 : 422, {
        error:
          e instanceof z.ZodError ? 'invalid_broker_request' : errorCode(e),
      });
    }
  }
}
