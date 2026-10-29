import { z } from 'zod';
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export const id = z.string().min(1).max(200);
export const messageSchema = z
  .object({
    id,
    sourceId: id,
    connectionId: id,
    workspaceId: id,
    actorId: id,
    actorName: z.string().max(120),
    text: z.string().max(16000),
    kind: z.enum(['created', 'edited', 'deleted']).default('created'),
    revision: z.number().int().positive().default(1),
    occurredAt: z.number().int(),
    receivedAt: z.number().int(),
    bot: z.boolean().default(false),
    direct: z.boolean().default(false),
    mentions: z.array(id).max(100).default([]),
    replyTo: id.optional(),
    quote: z
      .object({
        actorId: id.optional(),
        text: z.string().max(8000),
        sourceId: id.optional(),
      })
      .optional(),
    attachments: z
      .array(
        z.object({
          type: z.string().max(80),
          url: z.string().max(8192),
          alt: z.string().max(1000).optional(),
        }),
      )
      .max(10)
      .default([]),
    protocol: z
      .object({
        groupId: id.optional(),
        userId: id.optional(),
        referenceId: id.optional(),
        replyId: id.optional(),
      })
      .optional(),
  })
  .strict();
export type Message = z.infer<typeof messageSchema>;
export interface Workspace {
  id: string;
  name: string;
  connectionId: string;
  kind: 'group' | 'direct';
  revision: number;
  receive: 'all_messages' | 'mentions_only' | 'direct_only' | 'unknown';
  paused: boolean;
  proactive: boolean;
  lastSentAt: number;
  lastObservedAt: number;
}
export interface Scope {
  workspaceId: string;
  runId: string;
  pluginId: string;
  signal: AbortSignal;
}
export interface Question {
  name: string;
  type: 'predicate' | 'choice';
  instructions: string;
  choices?: Record<string, string>;
}
export interface Answer {
  type: 'predicate' | 'choice';
  value: boolean | string;
  probability?: number;
  probabilities?: Record<string, number>;
  uncertainty: 'native' | 'unknown';
}
export type Answers = Record<string, Answer>;
export interface Usage {
  id: string;
  runId: string;
  workspaceId: string;
  pluginId: string;
  role: string;
  connectionId: string;
  model: string;
  operation: string;
  status: 'pending' | 'reported' | 'unknown' | 'failed';
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  units?: number;
  durationMs: number;
  requestChars?: number;
  at: number;
  error?: string;
  providerRequestId?: string;
}
export interface Run {
  id: string;
  workspaceId: string;
  triggerId: string;
  revision: number;
  configRevision: number;
  status:
    | 'observing'
    | 'deciding'
    | 'generating'
    | 'deferred'
    | 'silent'
    | 'shadow'
    | 'sent'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  action?: string;
  reason?: string;
  draft?: string;
  assetId?: string;
  answers?: Answers;
  tone?: string;
  at: number;
  endedAt?: number;
  stages: { stage: string; at: number; detail?: string }[];
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  reasoning_content?: string;
}
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface Generation {
  content: string;
  toolCalls: ToolCall[];
  assistant: ChatMessage;
}
export type Delivery =
  | { status: 'sent'; id: string }
  | { status: 'failed'; code: string }
  | { status: 'unknown'; code: string };
export interface SendAction {
  key: string;
  workspace: Workspace;
  trigger: Message;
  text: string;
  assetId?: string;
  expiresAt: number;
  sequence: number;
  referenceId?: string;
  proactive: boolean;
}
export interface ProtocolAdapter {
  coverage?(workspace: Workspace): Workspace['receive'];
  start?(
    ingest: (event: unknown) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void>;
  stop?(): Promise<void>;
  id: string;
  send(action: SendAction, signal: AbortSignal): Promise<Delivery>;
}
export interface MemoryQuery {
  actorIds?: string[];
  from?: string;
  to?: string;
}
export interface MemoryProvider {
  id: string;
  propose?(
    candidate: MemoryCandidate,
    scope: Scope,
  ): Promise<Record<string, unknown>>;
  recall(
    query: string,
    scope: Scope,
    options?: MemoryQuery,
  ): Promise<{
    status: 'disabled' | 'ready' | 'degraded';
    items: MemoryItem[];
    trace?: Record<string, unknown>;
  }>;
}
export interface MemorySource {
  workspace_id: string;
  message_id: string;
  revision: number;
  part_index: number;
  span?: { start: number; end: number };
}
export interface MemoryItem {
  id: string;
  content: string;
  sourceIds: string[];
  revision?: number;
  sources?: MemorySource[];
  actorIds?: string[];
  score?: number;
}
export interface MemoryCandidate {
  kind:
    | 'fact'
    | 'preference'
    | 'event'
    | 'relationship'
    | 'group_habit'
    | 'summary'
    | 'inference';
  content: string;
  sources: MemorySource[];
  actorIds: string[];
}
export const memoryBindingSchema = z.object({
  workspaceId: id,
  remoteWorkspaceId: id,
  integrationId: id,
  externalSpaceId: id,
  partitionId: z.string().max(200).default(''),
  audienceActorIds: z.array(id).max(64).default([]),
});
export type MemoryBinding = z.infer<typeof memoryBindingSchema>;
export const memoryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.string().default('memstation'),
    baseUrl: z.url().default('http://127.0.0.1:8090'),
    secretRef: z.string().max(300).default(''),
    bindings: z.array(memoryBindingSchema).max(200).default([]),
    timeoutMs: z.number().int().min(100).max(10000).default(1500),
    maxChars: z.number().int().min(100).max(12000).default(5000),
    topN: z.number().int().min(1).max(20).default(6),
    broker: z
      .object({
        enabled: z.boolean().default(false),
        secretRef: z.string().max(300).default(''),
        timeoutMs: z.number().int().min(1000).max(180000).default(90000),
        embeddingModel: z.string().max(200).default(''),
        embeddingFingerprint: z.string().max(200).default(''),
        embeddingDimensions: z.number().int().min(1).max(8192).default(1024),
      })
      .default({
        enabled: false,
        secretRef: '',
        timeoutMs: 90000,
        embeddingModel: '',
        embeddingFingerprint: '',
        embeddingDimensions: 1024,
      }),
  })
  .strict();
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export interface MemoryOperationScope extends Scope {
  binding: MemoryBinding;
}
export interface MemoryTransport {
  id: string;
  encode(
    message: Message,
    mappings: Record<string, { id: string; revision: number }>,
    deliveryReceipt: string | undefined,
    scope: MemoryOperationScope,
  ): Promise<Record<string, unknown>>;
  probe(scope: MemoryOperationScope): Promise<Record<string, any>>;
  observe(
    batch: Record<string, unknown>,
    key: string,
    scope: MemoryOperationScope,
  ): Promise<Record<string, any>>;
  progress(
    id: string,
    scope: MemoryOperationScope,
  ): Promise<Record<string, any>>;
  search(
    query: string,
    options: MemoryQuery,
    scope: MemoryOperationScope,
  ): Promise<{ items: MemoryItem[]; trace: Record<string, unknown> }>;
  inspect(id: string, scope: MemoryOperationScope): Promise<MemoryItem>;
  source(id: string, scope: MemoryOperationScope): Promise<Record<string, any>>;
  propose?(
    candidate: MemoryCandidate,
    scope: MemoryOperationScope,
  ): Promise<Record<string, unknown>>;
  operation(
    path: 'forget' | 'retract' | 'export' | 'operation' | 'finalize',
    value: Record<string, unknown>,
    key: string,
    scope: MemoryOperationScope,
  ): Promise<Record<string, any>>;
}
export interface ToolExecutionScope extends Scope {
  readonly request: Readonly<{
    speaker: string;
    text: string;
    proposal?: string;
  }>;
  readonly results: readonly { name: string; result: unknown }[];
}
export interface ToolPlugin {
  pluginId?: string;
  name: string;
  definition: ToolDefinition;
  schema: z.ZodType;
  effect: 'read' | 'network' | 'compute' | 'propose_send';
  available?(): boolean;
  authorize?(input: unknown, scope: ToolExecutionScope): void | Promise<void>;
  projectResult?(value: unknown, maxChars: number): unknown;
  assetIds?(value: unknown): string[];
  execute(input: unknown, scope: ToolExecutionScope): Promise<unknown>;
}
export interface Hook {
  id: string;
  stage:
    | 'input.pre'
    | 'context.pre'
    | 'decision.post'
    | 'tool.pre'
    | 'tool.post'
    | 'output.post'
    | 'send.pre'
    | 'run.post';
  priority: number;
  timeoutMs: number;
  required: boolean;
  execute(
    subject: unknown,
    scope: Scope,
  ): Promise<{ allow: boolean; reason?: string }>;
}
export interface PluginManifest {
  id: string;
  name: string;
  kind:
    | 'protocol'
    | 'model'
    | 'memory'
    | 'storage'
    | 'tool'
    | 'safety'
    | 'behavior';
  version: string;
  dependencies: string[];
  permissions: string[];
  admin: string;
  trust: 'builtin' | 'isolated' | 'trustedInProcess';
}
export interface RecordEntry<T = unknown> {
  key: string;
  kind: string;
  scope: string;
  revision: number;
  value: T;
  at: number;
}
export interface Write {
  key: string;
  kind: string;
  scope: string;
  value: unknown;
  expected: number | null;
  at?: number;
}
export interface StorageProvider {
  get<T>(key: string): Promise<RecordEntry<T> | undefined>;
  scan<T>(
    kind: string,
    after?: string,
    limit?: number,
  ): Promise<RecordEntry<T>[]>;
  list<T>(
    kind: string,
    scope?: string,
    limit?: number,
    before?: number,
    beforeKey?: string,
  ): Promise<RecordEntry<T>[]>;
  commit(
    writes: Write[],
    guards?: { key: string; revision: number | null }[],
  ): Promise<void>;
  delete(key: string, expected: number): Promise<void>;
  stats(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export const connectionSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/),
    baseUrl: z.url(),
    protocol: z.enum(['chat', 'systemone', 'decisions']).default('chat'),
    secretRef: z.string().max(300).default(''),
    enabled: z.boolean().default(true),
  })
  .strict();
export const routeSchema = z
  .object({ connectionId: id, model: z.string().min(1).max(160) })
  .strict();
export const scheduleSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    workspaceId: id,
    enabled: z.boolean().default(false),
    kind: z.enum(['cron', 'random', 'once']),
    expression: z.string().max(100).default('0 12 * * *'),
    timezone: z.string().max(100).default('Asia/Shanghai'),
    minMs: z.number().int().min(1000).default(3600000),
    maxMs: z.number().int().min(1000).default(10800000),
    onceAt: z.number().optional(),
    quietStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('22:00'),
    quietEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('09:00'),
    prompt: z.string().min(1).max(2000),
    handler: z.string().max(160).default('participate'),
    misfire: z.enum(['skip', 'coalesce']).default('skip'),
  })
  .strict()
  .refine((v) => v.minMs <= v.maxMs, 'minMs must not exceed maxMs');
export type Schedule = z.infer<typeof scheduleSchema>;
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    mode: z.enum(['shadow', 'live']).default('shadow'),
    paused: z.boolean().default(false),
    botName: z.string().min(1).max(60).default('小弥'),
    soul: z
      .string()
      .min(1)
      .max(16000)
      .default(
        '你叫小弥，喜欢软件、产品和音乐。说话简短自然，熟悉的可以聊，不熟悉的坦诚说明。认真讨论不插科打诨，轻松聊天不长篇说教。',
      ),
    connections: z.array(connectionSchema).max(30).default([]),
    routes: z.record(z.string(), routeSchema).default({}),
    memory: memoryConfigSchema.default(() => memoryConfigSchema.parse({})),
    context: z
      .object({
        historyMessages: z.number().int().min(2).max(40).default(16),
        historyChars: z.number().int().min(4000).max(16000).default(6000),
        decisionMessages: z.number().int().min(2).max(16).default(8),
        decisionChars: z.number().int().min(4000).max(10000).default(4000),
        memoryItems: z.number().int().min(1).max(10).default(3),
        memoryChars: z.number().int().min(200).max(6000).default(1800),
        toolResultChars: z.number().int().min(500).max(8000).default(4000),
        maxPromptChars: z.number().int().min(12000).max(48000).default(24000),
      })
      .default(() => ({
        historyMessages: 16,
        historyChars: 6000,
        decisionMessages: 8,
        decisionChars: 4000,
        memoryItems: 3,
        memoryChars: 1800,
        toolResultChars: 4000,
        maxPromptChars: 24000,
      })),
    safety: z
      .object({
        mode: z.enum(['off', 'audit', 'enforce']).default('enforce'),
        threshold: z.number().min(0).max(1).default(0.75),
      })
      .default({ mode: 'enforce', threshold: 0.75 }),
    behavior: z
      .object({
        debounceMs: z.number().int().min(0).max(10000).default(1000),
        maxDeferMs: z.number().int().min(0).max(8000).default(2000),
        cooldownMs: z.number().int().min(0).max(3600000).default(30000),
        maxChars: z.number().int().min(20).max(2000).default(300),
        proactiveCalibrated: z.boolean().default(false),
        quietStart: z.string().default('23:00'),
        quietEnd: z.string().default('08:00'),
        timezone: z.string().default('Asia/Shanghai'),
      })
      .default({
        debounceMs: 1000,
        maxDeferMs: 2000,
        cooldownMs: 30000,
        maxChars: 300,
        proactiveCalibrated: false,
        quietStart: '23:00',
        quietEnd: '08:00',
        timezone: 'Asia/Shanghai',
      }),
    budgets: z
      .object({
        dailyCalls: z.number().int().min(1).max(100000).default(5000),
        runCalls: z.number().int().min(1).max(30).default(14),
        runTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
        maxToolRounds: z.number().int().min(0).max(3).default(3),
      })
      .default({
        dailyCalls: 5000,
        runCalls: 14,
        runTimeoutMs: 20000,
        maxToolRounds: 3,
      }),
    qq: z
      .object({
        enabled: z.boolean().default(false),
        appId: z.string().max(100).default(''),
        secretRef: z.string().max(300).default(''),
        receive: z
          .enum(['all_messages', 'mentions_only'])
          .default('mentions_only'),
        proactive: z.boolean().default(false),
      })
      .default({
        enabled: false,
        appId: '',
        secretRef: '',
        receive: 'mentions_only',
        proactive: false,
      }),
    tools: z
      .object({
        web: z.boolean().default(true),
        stickers: z.boolean().default(true),
        node: z.boolean().default(false),
        sandboxDriver: z.enum(['apple', 'docker']).default('apple'),
      })
      .default({
        web: true,
        stickers: true,
        node: false,
        sandboxDriver: 'apple',
      }),
    disabledPlugins: z.array(z.string()).default([]),
    retentionDays: z.number().int().min(1).max(3650).default(30),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

export interface ModelOptions {
  model: string;
  protocol: string;
}
export interface ProviderRequest {
  path: string;
  body: unknown;
}
/** Codecs never receive credentials or a database handle. All requests use AIRuntime. */
export interface ModelProvider {
  id: string;
  credentialsOptional?: boolean;
  decision?: {
    encode(
      options: ModelOptions,
      state: unknown,
      questions: Question[],
    ): ProviderRequest;
    decode(
      data: Record<string, unknown>,
      questions: Question[],
      options: ModelOptions,
    ): Answers;
  };
  text?: {
    encode(
      options: ModelOptions,
      messages: ChatMessage[],
      tools: ToolDefinition[],
    ): ProviderRequest;
    decode(data: Record<string, unknown>): Generation;
  };
  web?: {
    encode(operation: 'search' | 'fetch', input: unknown): ProviderRequest;
  };
  embedding?: {
    encode(
      options: ModelOptions,
      input: string,
      dimensions: number,
    ): ProviderRequest;
    decode(data: Record<string, unknown>, dimensions: number): number[];
  };
  rerank?: {
    encode(
      options: ModelOptions,
      query: string,
      documents: { id: string; text: string }[],
    ): ProviderRequest;
    decode(
      data: Record<string, unknown>,
      documents: { id: string; text: string }[],
    ): { document_id: string; score: number }[];
  };
}
export interface SafetyProvider {
  id: string;
  check(
    stage: string,
    subject: unknown,
    scope: Scope,
  ): Promise<{ allow: boolean; reason: string }>;
}
