import { z } from 'zod';
import type {
  MemoryConfig,
  MemoryItem,
  MemoryOperationScope,
  MemoryTransport,
  Message,
  MemoryCandidate,
} from '../../../packages/contracts/src/index.js';
import { hash } from '../../../packages/core/src/state.js';
import { limitedJson } from '../../../packages/ai-runtime/src/index.js';

const ref = z.object({
  workspace_id: z.string(),
  message_id: z.string(),
  revision: z.number().int().safe().positive(),
  part_index: z.number().int().nonnegative(),
  span: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .optional(),
});
export function memoryItem(raw: unknown, workspace: string): MemoryItem {
  const value = z
    .object({
      node_id: z.string().min(1),
      content: z.string().max(1000000),
      workspace_id: z.literal(workspace),
      revision: z.number().int().safe().positive(),
      source_refs: z.array(ref).default([]),
      subject_actor_ids: z.array(z.string()).default([]),
      effective_score: z.number().finite().optional(),
    })
    .passthrough()
    .parse(raw);
  if (value.source_refs.some((r) => r.workspace_id !== workspace))
    throw new Error('memory_scope_mismatch');
  return {
    id: value.node_id,
    content: value.content,
    revision: value.revision,
    sources: value.source_refs,
    sourceIds: value.source_refs.map((r) => r.message_id),
    actorIds: value.subject_actor_ids,
    score: value.effective_score,
  };
}
/** Stateless transport: receives settings/secrets, never a storage handle. */
export class MemStationTransport implements MemoryTransport {
  readonly id = 'memstation';
  constructor(
    readonly config: () => MemoryConfig,
    readonly secret: (ref: string) => Promise<string>,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async call(
    path: string,
    method: string,
    data: unknown,
    scope: MemoryOperationScope,
    key?: string,
  ) {
    scope.signal.throwIfAborted();
    const c = this.config(),
      b = scope.binding;
    const credential = await this.secret(c.secretRef);
    scope.signal.throwIfAborted();
    if (!credential) throw new Error('memory_credential_missing');
    const response = await this.fetcher(c.baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'X-MemStation-Workspace': b.remoteWorkspaceId,
        'X-MemStation-Audience': JSON.stringify(
          b.partitionId
            ? { kind: 'direct', actor_ids: b.audienceActorIds }
            : { kind: 'workspace' },
        ),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      redirect: 'error',
      signal: AbortSignal.any([
        scope.signal,
        AbortSignal.timeout(
          method === 'GET' || path.endsWith('/search') ? c.timeoutMs : 10000,
        ),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`memory_http_${response.status}`);
    }
    return z.record(z.string(), z.any()).parse(await limitedJson(response));
  }
  async probe(scope: MemoryOperationScope) {
    const result = await this.call(
      '/api/v1/capabilities',
      'GET',
      undefined,
      scope,
    );
    if (
      result.contract_version !== '1.0' ||
      result.status !== 'ready' ||
      result.access?.workspace_id !== scope.binding.remoteWorkspaceId ||
      !result.capabilities?.server_isolation ||
      !result.capabilities?.multi_workspace
    )
      throw new Error('memory_capability_mismatch');
    if (
      result.runtime?.ai_backend !== 'broker' ||
      result.runtime?.usage_authority !== 'broker' ||
      !result.capabilities.broker
    )
      throw new Error('memory_broker_required');
    if (scope.binding.partitionId && !result.capabilities.private_audience)
      throw new Error('memory_private_unsupported');
    return result;
  }
  async encode(
    m: Message,
    mappings: Record<string, { id: string; revision: number }>,
    deliveryReceipt: string | undefined,
    ctx: MemoryOperationScope,
  ) {
    const probe = await this.probe(ctx),
      binding = ctx.binding;
    if (
      !probe.capabilities?.independent_ingestion ||
      !probe.capabilities?.batch_idempotency
    )
      throw new Error('memory_ingestion_unsupported');
    const parts: any[] = [];
    let reply_to;
    if (m.kind !== 'deleted') {
      parts.push({ type: 'text', text: m.text });
      if (m.quote) {
        const mapped = m.quote.sourceId
          ? mappings[m.quote.sourceId]
          : undefined;
        if (!mapped) throw new Error('memory_quote_source_unresolved');
        const source = await this.source(mapped.id, ctx);
        let index = -1,
          start = -1;
        for (const [i, p] of (source.parts ?? []).entries())
          if (
            p.type === 'text' &&
            typeof p.text === 'string' &&
            (start = p.text.indexOf(m.quote.text)) >= 0
          ) {
            index = i;
            break;
          }
        if (index < 0) throw new Error('memory_quote_source_changed');
        const text = source.parts[index].text;
        const codepointStart = [...text.slice(0, start)].length;
        parts.push({
          type: 'quote',
          text: m.quote.text,
          source: {
            workspace_id: binding.remoteWorkspaceId,
            message_id: source.id,
            revision: source.revision,
            part_index: index,
            span: {
              start: codepointStart,
              end: codepointStart + [...m.quote.text].length,
            },
          },
        });
      }
      for (const actor of m.mentions) {
        if (!probe.capabilities?.external_actor_mentions)
          throw new Error('memory_external_actor_unsupported');
        parts.push({
          type: 'mention',
          author: {
            kind: actor === 'bot' ? 'bot' : 'human',
            external_id: actor,
          },
        });
      }
      if (m.replyTo) {
        const mapped = mappings[m.replyTo];
        if (!mapped) throw new Error('memory_reply_source_unresolved');
        reply_to = {
          workspace_id: binding.remoteWorkspaceId,
          message_id: mapped.id,
          revision: mapped.revision,
          part_index: 0,
        };
      }
    }
    const event = {
      event_id: hash([m.workspaceId, m.id, m.revision, m.kind]),
      type: 'message.' + m.kind,
      source_message_id: hash([m.workspaceId, m.sourceId]),
      source_revision: m.revision,
      speaker: {
        kind: m.bot ? 'bot' : 'human',
        external_id: m.actorId,
        display_name: m.actorName,
      },
      occurred_at: new Date(m.occurredAt).toISOString(),
      ...(m.kind === 'deleted' ? {} : { parts, reply_to }),
      ...(m.bot
        ? { delivery_status: 'confirmed', delivery_receipt: deliveryReceipt }
        : {}),
    };
    return {
      workspace_id: binding.remoteWorkspaceId,
      integration_id: binding.integrationId,
      external_space_id: binding.externalSpaceId,
      partition_id: binding.partitionId,
      events: [event],
    };
  }
  observe(
    batch: Record<string, unknown>,
    key: string,
    scope: MemoryOperationScope,
  ) {
    return this.call('/api/v1/events/batch', 'POST', batch, scope, key);
  }
  progress(id: string, scope: MemoryOperationScope) {
    return this.call(
      `/api/v1/ingestions/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      scope,
    );
  }
  async search(
    query: string,
    options: import('../../../packages/contracts/src/index.js').MemoryQuery,
    scope: MemoryOperationScope,
  ) {
    const result = await this.call(
      '/api/v1/memory/search',
      'POST',
      {
        query,
        query_id: scope.runId,
        top_n: this.config().topN,
        subject_actor_ids: options.actorIds ?? [],
        date_from: options.from,
        date_to: options.to,
        partition_id: scope.binding.partitionId,
      },
      scope,
    );
    const rows = z
      .array(z.unknown())
      .parse(result.memories ?? result.records ?? []);
    return {
      items: rows.map((r) => memoryItem(r, scope.binding.remoteWorkspaceId)),
      trace: z.record(z.string(), z.unknown()).parse(result.trace ?? {}),
    };
  }
  async inspect(id: string, scope: MemoryOperationScope) {
    return memoryItem(
      await this.call(
        `/api/v1/memory/records/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        scope,
      ),
      scope.binding.remoteWorkspaceId,
    );
  }
  source(id: string, scope: MemoryOperationScope) {
    return this.call(
      `/api/v1/sources/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      scope,
    );
  }
  propose(candidate: MemoryCandidate, scope: MemoryOperationScope) {
    return this.call(
      '/api/v1/memory/candidates',
      'POST',
      {
        kind: candidate.kind,
        content: candidate.content,
        source_refs: candidate.sources,
        subject_actor_ids: candidate.actorIds,
        partition_id: scope.binding.partitionId,
      },
      scope,
    );
  }
  operation(
    path: 'forget' | 'retract' | 'export' | 'operation' | 'finalize',
    value: Record<string, unknown>,
    key: string,
    scope: MemoryOperationScope,
  ) {
    const routes = {
      forget: '/api/v1/memory/forget',
      retract: '/api/v1/sources/retract',
      export: '/api/v1/exports',
      operation: `/api/v1/operations/${encodeURIComponent(String(value.id))}`,
      finalize: `/api/v1/conversations/${encodeURIComponent(String(value.id))}/finalize`,
    };
    return this.call(
      routes[path],
      path === 'operation' ? 'GET' : 'POST',
      path === 'operation'
        ? undefined
        : {
            ...value,
            id: undefined,
            ...(['forget', 'retract'].includes(path)
              ? { partition_id: scope.binding.partitionId }
              : {}),
          },
      scope,
      key,
    );
  }
}
