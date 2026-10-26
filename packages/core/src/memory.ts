import type {
  MemoryProvider,
  Workspace,
  MemoryQuery,
  MemoryTransport,
  MemoryBinding,
  MemoryOperationScope,
  MemoryItem,
  Message,
  Scope,
  SafetyProvider,
  MemoryCandidate,
  Write,
  RecordEntry,
} from '../../contracts/src/index.js';
import { State, hash, uid, errorCode } from './state.js';

export interface MemoryJob {
  messageId: string;
  revision: number;
  kind: Message['kind'];
  bindingHash: string;
  status:
    | 'pending_policy'
    | 'ready'
    | 'retry'
    | 'accepted'
    | 'indexed'
    | 'skipped'
    | 'dead_letter';
  attempt: number;
  nextAt: number;
  payload?: Record<string, unknown>;
  receiptId?: string;
  receipt?: Record<string, unknown>;
  code?: string;
  deliveryReceipt?: string;
  retractOnly?: boolean;
}
export class MemoryService implements MemoryProvider {
  readonly id = 'memory-service';
  #providers = new Map<string, MemoryTransport>();
  #active?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #cursor = '';
  #stop = new AbortController();
  constructor(
    readonly state: State,
    readonly safety: () => SafetyProvider,
  ) {}
  register(provider: MemoryTransport) {
    if (this.#providers.has(provider.id))
      throw new Error('duplicate_memory_provider');
    this.#providers.set(provider.id, provider);
  }
  binding(workspaceId: string) {
    const c = this.state.config.memory;
    return c.enabled &&
      !this.state.config.disabledPlugins.includes('memory-' + c.provider)
      ? c.bindings.find((b) => b.workspaceId === workspaceId)
      : undefined;
  }
  async checkAudience(workspaceId: string) {
    const b = this.binding(workspaceId);
    if (
      b?.partitionId &&
      (await this.state.db.get<Workspace>('workspace:' + workspaceId))?.value
        .kind !== 'direct'
    )
      throw new Error('memory_audience_mismatch');
  }
  fingerprint(b: MemoryBinding) {
    return hash([
      this.state.config.memory.provider,
      this.state.config.memory.baseUrl,
      b,
    ]);
  }
  context(workspaceId: string, scope?: Scope): MemoryOperationScope {
    const binding = this.binding(workspaceId);
    if (!binding) throw new Error('memory_unbound');
    return {
      ...(scope ?? {
        workspaceId,
        runId: uid(),
        pluginId: 'memory-' + this.state.config.memory.provider,
        signal: AbortSignal.timeout(10000),
      }),
      binding,
      signal: AbortSignal.any([
        scope?.signal ?? AbortSignal.timeout(10000),
        this.state.configSignal,
      ]),
    };
  }
  provider() {
    const p = this.#providers.get(this.state.config.memory.provider);
    if (!p) throw new Error('memory_provider_missing');
    return p;
  }
  mappingKey(b: MemoryBinding, id: string) {
    return 'memory-source:' + hash([this.fingerprint(b), id]);
  }
  /** Only references are committed with the message. Unchecked body never enters the outbox. */
  prepare(message: Message, deliveryReceipt?: string): Write[] {
    const b = this.binding(message.workspaceId);
    if (
      !b ||
      (message.bot &&
        message.actorId === 'bot' &&
        message.kind !== 'deleted' &&
        !deliveryReceipt)
    )
      return [];
    const job: MemoryJob = {
      messageId: message.id,
      revision: message.revision,
      kind: message.kind,
      bindingHash: this.fingerprint(b),
      status: 'pending_policy',
      attempt: 0,
      nextAt: 0,
      ...(message.bot
        ? { deliveryReceipt: deliveryReceipt ?? message.sourceId }
        : {}),
    };
    return [
      {
        key:
          'memory-outbox:' +
          hash([
            message.workspaceId,
            message.id,
            message.revision,
            message.kind,
          ]),
        kind: 'memory-outbox',
        scope: message.workspaceId,
        value: job,
        expected: null,
        at: message.receivedAt,
      },
    ];
  }
  start() {
    this.#timer = setInterval(() => void this.flush().catch(() => {}), 1000);
    this.#timer.unref();
  }
  async close() {
    clearInterval(this.#timer);
    this.#stop.abort();
    await this.#active?.catch(() => {});
  }
  async rows<T>(kind: string) {
    const all: RecordEntry<T>[] = [];
    for await (const row of this.state.scan<T>(kind)) all.push(row);
    return all;
  }
  flush() {
    if (this.#active) return this.#active;
    this.#active = this.#flush().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }
  async #flush() {
    if (this.#stop.signal.aborted || !this.state.config.memory.enabled) return;
    const rows = await this.state.db.scan<MemoryJob>(
      'memory-outbox',
      this.#cursor,
      200,
    );
    this.#cursor = rows.length === 200 ? rows.at(-1)!.key : '';
    rows.sort(
      (a, b) =>
        Number(b.value.kind === 'deleted') -
          Number(a.value.kind === 'deleted') ||
        a.at - b.at ||
        a.key.localeCompare(b.key),
    );
    for (const row of rows) {
      if (this.#stop.signal.aborted) break;
      if (
        ['indexed', 'skipped', 'dead_letter'].includes(row.value.status) ||
        row.value.nextAt > Date.now()
      )
        continue;
      const binding = this.binding(row.scope);
      if (!binding) continue;
      let current = await this.state.db.get<MemoryJob>(row.key);
      if (!current) continue;
      let job = { ...current.value };
      const update = async (
        value: MemoryJob,
        guards: { key: string; revision: number | null }[] = [],
      ) => {
        await this.state.db.commit(
          [
            {
              key: row.key,
              kind: row.kind,
              scope: row.scope,
              value,
              expected: current!.revision,
              at: row.at,
            },
          ],
          guards,
        );
        current = (await this.state.db.get<MemoryJob>(row.key))!;
        job = value;
      };
      try {
        await this.checkAudience(row.scope);
        if (job.bindingHash !== this.fingerprint(binding)) {
          await update({
            ...job,
            status: 'dead_letter',
            code: 'memory_binding_changed',
            payload: undefined,
          });
          continue;
        }
        const ctx = this.context(row.scope, {
          workspaceId: row.scope,
          runId: row.key,
          pluginId: 'memory-' + this.provider().id,
          signal: AbortSignal.any([
            this.#stop.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (job.status === 'accepted') {
          const receipt = await this.provider().progress(job.receiptId!, ctx);
          checkReceipt(receipt, binding);
          await update({
            ...job,
            receipt,
            status: receipt.status === 'complete' ? 'indexed' : 'accepted',
            nextAt: Date.now() + 3000,
            code: receipt.failure_code,
          });
          continue;
        }
        const messageRow = await this.state.db.get<Message>(
          `message:${row.scope}:${job.messageId}`,
        );
        if (
          !messageRow ||
          messageRow.value.revision !== job.revision ||
          messageRow.value.kind !== job.kind
        ) {
          await update({
            ...job,
            status: 'skipped',
            payload: undefined,
            code: 'source_changed',
          });
          continue;
        }
        const m = messageRow.value,
          configRevision = this.state.revision;
        let retractOnly = job.retractOnly ?? false;
        // Recheck before every network attempt. Deletions bypass semantic screening.
        if (m.kind !== 'deleted' && (!m.bot || m.actorId !== 'bot')) {
          const verdict = await this.safety().check(
            'memory.input',
            { text: m.text, quote: m.quote },
            ctx,
          );
          if (verdict.reason === 'safety_unavailable')
            throw new Error('memory_safety_unavailable');
          if (!verdict.allow) {
            if (m.kind === 'created' && !job.payload && !job.attempt) {
              await update(
                {
                  ...job,
                  status: 'skipped',
                  payload: undefined,
                  code: 'input_denied',
                },
                [
                  { key: messageRow.key, revision: messageRow.revision },
                  { key: 'config', revision: configRevision },
                ],
              );
              continue;
            }
            retractOnly = true;
            if (!job.retractOnly)
              await update({ ...job, retractOnly: true, payload: undefined });
          }
        }
        if (!job.payload) {
          const mappings: Record<string, { id: string; revision: number }> = {};
          for (const id of [m.replyTo, m.quote?.sourceId].filter(
            Boolean,
          ) as string[]) {
            const row = await this.state.db.get<{
              id: string;
              revision: number;
            }>(this.mappingKey(binding, id));
            if (row) mappings[id] = row.value;
          }
          const observed = retractOnly
            ? { ...m, kind: 'deleted' as const, text: '' }
            : m;
          const payload = await this.provider().encode(
            observed,
            mappings,
            job.deliveryReceipt,
            ctx,
          );
          await update({ ...job, status: 'ready', payload }, [
            { key: messageRow.key, revision: messageRow.revision },
            { key: 'config', revision: configRevision },
          ]);
        }
        const receipt = await this.provider().observe(
          job.payload!,
          row.key + (job.retractOnly ? ':retract' : ''),
          ctx,
        );
        checkReceipt(receipt, binding);
        const acceptance = receipt.events?.[0];
        if (!acceptance?.message_id) throw new Error('memory_receipt_invalid');
        // Binding and source guards make a concurrent edit/disable fail closed.
        const writes: Write[] = [
          {
            key: row.key,
            kind: row.kind,
            scope: row.scope,
            at: row.at,
            value: {
              ...job,
              status: 'accepted',
              payload: undefined,
              receiptId: receipt.id,
              receipt,
              nextAt: Date.now() + 1000,
              code: undefined,
            },
            expected: current!.revision,
          },
        ];
        for (const id of new Set(
          [m.id, m.sourceId, m.protocol?.referenceId].filter(
            Boolean,
          ) as string[],
        )) {
          const key = this.mappingKey(binding, id),
            prior = await this.state.db.get(key);
          writes.push({
            key,
            kind: 'memory-source',
            scope: row.scope,
            value: { id: acceptance.message_id, revision: m.revision },
            expected: prior?.revision ?? null,
          });
        }
        await this.state.db.commit(writes, [
          { key: messageRow.key, revision: messageRow.revision },
          { key: 'config', revision: configRevision },
        ]);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'revision_conflict') continue;
        const attempt = job.attempt + 1;
        await update({
          ...job,
          attempt,
          status:
            attempt >= 8 || code === 'memory_http_409'
              ? 'dead_letter'
              : job.receiptId
                ? 'accepted'
                : 'retry',
          nextAt: Date.now() + Math.min(3600000, 1000 * 2 ** attempt),
          code,
        }).catch(() => {});
      }
    }
  }
  async recall(query: string, scope: Scope, options: MemoryQuery = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 16000)
      throw new Error('invalid_memory_query');
    if (
      options.actorIds &&
      (!Array.isArray(options.actorIds) ||
        options.actorIds.length > 64 ||
        options.actorIds.some(
          (id) => typeof id !== 'string' || !id || id.length > 256,
        ))
    )
      throw new Error('invalid_memory_actor_filter');
    if (
      [options.from, options.to].some(
        (date) =>
          date !== undefined &&
          (typeof date !== 'string' || !Number.isFinite(Date.parse(date))),
      ) ||
      (options.from &&
        options.to &&
        Date.parse(options.from) > Date.parse(options.to))
    )
      throw new Error('invalid_memory_date_filter');
    if (!this.binding(scope.workspaceId))
      return { status: 'disabled' as const, items: [] };
    const started = Date.now(),
      queryId = uid(),
      ctx = this.context(scope.workspaceId, {
        ...scope,
        runId: queryId,
        signal: AbortSignal.any([
          scope.signal,
          AbortSignal.timeout(this.state.config.memory.timeoutMs),
        ]),
      });
    let result: {
      status: 'ready' | 'degraded';
      items: MemoryItem[];
      trace: Record<string, unknown>;
    };
    try {
      await this.checkAudience(scope.workspaceId);
      await this.provider().probe(ctx);
      const found = await this.provider().search(query, options, ctx);
      let remaining = this.state.config.memory.maxChars;
      const items: MemoryItem[] = [];
      const seen = new Set<string>();
      for (const item of found.items) {
        const cost = JSON.stringify(item).length;
        if (seen.has(item.id) || !item.sources?.length || cost > remaining)
          continue;
        const current = await this.provider().inspect(item.id, ctx);
        if (
          current.revision !== item.revision ||
          current.content !== item.content
        )
          continue;
        // Any local edit/deletion still awaiting delivery blocks old remote evidence.
        if (await this.pendingMutation(scope.workspaceId)) continue;
        remaining -= cost;
        seen.add(item.id);
        items.push(item);
      }
      result = {
        status: found.trace.degraded ? 'degraded' : 'ready',
        items,
        trace: { ...found.trace, injected_count: items.length },
      };
    } catch (e) {
      result = {
        status: 'degraded',
        items: [],
        trace: { failure_code: errorCode(e), injected_count: 0 },
      };
    }
    await this.state.db.commit([
      {
        key: 'memory-recall:' + queryId,
        kind: 'memory-recall',
        scope: scope.workspaceId,
        value: {
          ...result,
          items: result.items.map(({ content, ...item }) => ({
            ...item,
            contentHash: hash(content),
          })),
          queryHash: hash(query),
          latencyMs: Date.now() - started,
          usedRefs: [],
          usageVerified: false,
          runId: scope.runId,
        },
        expected: null,
      },
    ]);
    return result;
  }
  async pendingMutation(workspaceId: string) {
    return (await this.rows<MemoryJob>('memory-outbox')).some(
      (r) =>
        r.scope === workspaceId &&
        r.value.kind !== 'created' &&
        !['accepted', 'indexed', 'skipped'].includes(r.value.status),
    );
  }
  async validate(items: MemoryItem[], scope: Scope) {
    if (!items.length) return true;
    if (
      !this.binding(scope.workspaceId) ||
      (await this.pendingMutation(scope.workspaceId))
    )
      return false;
    const ctx = this.context(scope.workspaceId, scope);
    try {
      await this.checkAudience(scope.workspaceId);
      for (const item of items) {
        const current = await this.provider().inspect(item.id, ctx);
        if (
          current.revision !== item.revision ||
          current.content !== item.content
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  async propose(candidate: MemoryCandidate, scope: Scope) {
    if (!candidate.content?.trim() || candidate.content.length > 16000)
      throw new Error('invalid_memory_candidate');
    await this.checkAudience(scope.workspaceId);
    const ctx = this.context(scope.workspaceId, scope),
      provider = this.provider();
    if (!provider.propose) throw new Error('memory_candidates_unsupported');
    const verdict = await this.safety().check(
      'memory.candidate',
      candidate,
      scope,
    );
    if (!verdict.allow || verdict.reason === 'safety_unavailable')
      throw new Error('memory_candidate_denied');
    return provider.propose(candidate, ctx);
  }
  async retry(key: string) {
    const row = await this.state.db.get<MemoryJob>(key);
    if (!row || row.kind !== 'memory-outbox')
      throw new Error('memory_job_missing');
    await this.state.db.commit([
      {
        ...row,
        value: {
          ...row.value,
          status: row.value.receiptId ? 'accepted' : 'retry',
          attempt: 0,
          nextAt: 0,
        },
        expected: row.revision,
        at: row.at,
      },
    ]);
  }
}
function checkReceipt(receipt: Record<string, any>, binding: MemoryBinding) {
  if (
    typeof receipt.id !== 'string' ||
    receipt.workspace_id !== binding.remoteWorkspaceId ||
    !Number.isSafeInteger(receipt.accepted_sequence) ||
    !Number.isSafeInteger(receipt.indexed_sequence)
  )
    throw new Error('memory_receipt_invalid');
}
