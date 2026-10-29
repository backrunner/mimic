import { z } from 'zod';
import type {
  Answers,
  ChatMessage,
  Generation,
  Question,
  Scope,
  ToolDefinition,
  Usage,
  ModelProvider,
} from '../../contracts/src/index.js';
import { State, uid, errorCode } from '../../core/src/state.js';
const object = z.record(z.string(), z.unknown());
const number = z.number().finite().nonnegative();
export async function limitedJson(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
) {
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class AIRuntime {
  #providers = new Map<string, ModelProvider>();
  register(provider: ModelProvider) {
    if (this.#providers.has(provider.id))
      throw new Error('duplicate_model_provider');
    this.#providers.set(provider.id, provider);
  }
  provider(role: string) {
    const route = this.state.config.routes[role];
    const connection = this.state.config.connections.find(
      (c) => c.id === route?.connectionId,
    );
    const provider = connection && this.#providers.get(connection.provider);
    if (!provider) throw new Error('model_provider_missing');
    return {
      provider,
      options: { model: route!.model, protocol: connection!.protocol },
    };
  }
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly state: State,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async #reserve(
    role: string,
    operation: string,
    scope: Scope,
    usageId?: string,
    configRevision = this.state.revision,
  ) {
    const result = this.#queue.then(async () => {
      scope.signal.throwIfAborted();
      if (this.state.revision !== configRevision)
        throw new Error('config_changed');
      const config = this.state.config;
      const route = config.routes[role];
      if (!route) throw new Error(`route_unconfigured:${role}`);
      const connection = config.connections.find(
        (c) => c.id === route.connectionId && c.enabled,
      );
      if (
        !connection ||
        config.disabledPlugins.includes(`model-${connection.provider}`)
      )
        throw new Error('model_unavailable');
      const day = new Date().toISOString().slice(0, 10),
        dayKey = `budget:day:${day}`,
        runKey = `budget:run:${scope.runId}`;
      const dayRow = await this.state.db.get<number>(dayKey),
        runRow = await this.state.db.get<number>(runKey);
      if (
        (dayRow?.value ?? 0) >= config.budgets.dailyCalls ||
        (runRow?.value ?? 0) >= config.budgets.runCalls
      )
        throw new Error('budget_exhausted');
      const usage: Usage = {
        id: usageId ?? uid(),
        runId: scope.runId,
        workspaceId: scope.workspaceId,
        pluginId: scope.pluginId,
        role,
        connectionId: connection.id,
        model: route.model,
        operation,
        status: 'pending',
        durationMs: 0,
        at: Date.now(),
      };
      await this.state.db.commit(
        [
          {
            key: dayKey,
            kind: 'budget',
            scope: 'system',
            value: (dayRow?.value ?? 0) + 1,
            expected: dayRow?.revision ?? null,
          },
          {
            key: runKey,
            kind: 'budget',
            scope: scope.workspaceId,
            value: (runRow?.value ?? 0) + 1,
            expected: runRow?.revision ?? null,
          },
          {
            key: `usage:${usage.id}`,
            kind: 'usage',
            scope: scope.workspaceId,
            value: usage,
            expected: null,
          },
        ],
        [{ key: 'config', revision: configRevision }],
      );
      return { connection, route, usage };
    });
    this.#queue = result.catch(() => {});
    return result;
  }
  async request(
    role: string,
    operation: string,
    build: (
      model: string,
      provider: string,
      protocol: string,
    ) => { path: string; body: unknown },
    scope: Scope,
    options: { usageId?: string; timeoutMs?: number } = {},
  ) {
    const configRevision = this.state.revision,
      configSignal = this.state.configSignal;
    const { connection, route, usage } = await this.#reserve(
      role,
      operation,
      scope,
      options.usageId,
      configRevision,
    );
    let result: Record<string, unknown>;
    let dispatched = false;
    try {
      const spec = build(route.model, connection.provider, connection.protocol);
      const base = connection.baseUrl.replace(/\/$/, '');
      const path =
        base.endsWith('/v1') && spec.path.startsWith('/v1/')
          ? spec.path.slice(3)
          : spec.path;
      const key = await this.state.secret(connection.secretRef);
      scope.signal.throwIfAborted();
      configSignal.throwIfAborted();
      if (
        !this.#providers.get(connection.provider)?.credentialsOptional &&
        !key
      )
        throw new Error('credential_missing');
      dispatched = true;
      const body = JSON.stringify(spec.body);
      usage.requestChars = body.length;
      const response = await this.fetcher(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body,
        signal: AbortSignal.any([
          scope.signal,
          configSignal,
          AbortSignal.timeout(options.timeoutMs ?? 20000),
        ]),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`provider_http_${response.status}`);
      }
      result = object.parse(await limitedJson(response));
      usage.providerRequestId =
        typeof result.id === 'string'
          ? result.id
          : (response.headers.get('x-request-id') ?? undefined);
      const u = object.safeParse(result.usage);
      usage.status =
        u.success &&
        typeof (u.data.input_tokens ?? u.data.prompt_tokens) === 'number'
          ? 'reported'
          : 'unknown';
      if (u.success) {
        const value = u.data;
        usage.inputTokens = number
          .optional()
          .parse(value.input_tokens ?? value.prompt_tokens);
        usage.outputTokens = number
          .optional()
          .parse(value.output_tokens ?? value.completion_tokens);
        usage.cacheTokens = number
          .optional()
          .parse(value.prompt_cache_hit_tokens);
      }
      if (typeof result.model === 'string') usage.model = result.model;
      if (
        (operation === 'text' || operation === 'decision') &&
        usage.outputTokens === undefined
      )
        usage.status = 'unknown';
      if (operation === 'embedding' || operation === 'rerank') {
        if (
          usage.inputTokens === undefined &&
          u.success &&
          typeof u.data.total_tokens === 'number'
        )
          usage.inputTokens = number.parse(u.data.total_tokens);
        usage.outputTokens = 0;
        usage.status = usage.inputTokens === undefined ? 'unknown' : 'reported';
      }
      if (operation === 'search' || operation === 'fetch') {
        usage.status = 'reported';
        usage.units =
          operation === 'search'
            ? Array.isArray(result.results) && result.results.length
              ? 1
              : 0
            : typeof result.content === 'string' && result.content
              ? 1
              : 0;
      }
    } catch (e) {
      usage.status = dispatched ? 'unknown' : 'failed';
      usage.error = errorCode(e);
      throw e;
    } finally {
      usage.durationMs = Date.now() - usage.at;
      const record = await this.state.db.get(`usage:${usage.id}`);
      await this.state.db.commit([
        {
          key: `usage:${usage.id}`,
          kind: 'usage',
          scope: scope.workspaceId,
          value: usage,
          expected: record?.revision ?? null,
        },
      ]);
    }
    return result;
  }
  async decide(
    role: string,
    state: unknown,
    questions: Question[],
    scope: Scope,
  ): Promise<Answers> {
    if (new Set(questions.map((q) => q.name)).size !== questions.length)
      throw new Error('duplicate_question');
    const { provider, options } = this.provider(role);
    if (!provider.decision) throw new Error('decision_unsupported');
    const data = await this.request(
      role,
      'decision',
      () => provider.decision!.encode(options, state, questions),
      scope,
    );
    return provider.decision.decode(data, questions, options);
  }
  async generate(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    scope: Scope,
  ): Promise<Generation> {
    if (
      JSON.stringify({ messages, tools }).length >
      this.state.config.context.maxPromptChars
    )
      throw new Error('prompt_budget_exceeded');
    const { provider, options } = this.provider('chat');
    if (!provider.text) throw new Error('text_unsupported');
    const data = await this.request(
      'chat',
      'text',
      () => provider.text!.encode(options, messages, tools),
      scope,
    );
    return provider.text.decode(data);
  }
  async web(operation: 'search' | 'fetch', input: unknown, scope: Scope) {
    const { provider } = this.provider('web-search');
    if (!provider.web) throw new Error('web_unsupported');
    return this.request(
      'web-search',
      operation,
      () => provider.web!.encode(operation, input),
      scope,
    );
  }
  async memoryCall(
    role: string,
    operation: 'text' | 'embedding' | 'rerank',
    input: any,
    scope: Scope,
    usageId: string,
  ) {
    const { provider, options } = this.provider(role);
    const data = await this.request(
      role,
      operation,
      () => {
        if (operation === 'embedding') {
          if (!provider.embedding) throw new Error('embedding_unsupported');
          return provider.embedding.encode(
            options,
            input.input,
            input.dimensions,
          );
        }
        if (operation === 'rerank') {
          if (!provider.rerank) throw new Error('rerank_unsupported');
          return provider.rerank.encode(options, input.query, input.documents);
        }
        if (!provider.text) throw new Error('text_unsupported');
        const spec = provider.text.encode(options, input.messages, []);
        return {
          ...spec,
          body: {
            ...object.parse(spec.body),
            stream: false,
            max_tokens: input.max_tokens,
            response_format: { type: 'json_object' },
            ...(input.reasoning_effort
              ? { reasoning_effort: input.reasoning_effort }
              : {}),
          },
        };
      },
      scope,
      { usageId, timeoutMs: this.state.config.memory.broker.timeoutMs },
    );
    if (operation === 'embedding')
      return {
        ...data,
        data: [
          {
            index: 0,
            embedding: provider.embedding!.decode(data, input.dimensions),
          },
        ],
      };
    if (operation === 'rerank')
      return {
        ...data,
        version: 1,
        results: provider.rerank!.decode(data, input.documents),
      };
    return data;
  }
}
