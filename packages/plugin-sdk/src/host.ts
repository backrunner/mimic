import type {
  Hook,
  ModelProvider,
  PluginManifest,
  ProtocolAdapter,
  SafetyProvider,
  Schedule,
  Scope,
  ToolPlugin,
  StorageProvider,
  MemoryProvider,
  MemoryTransport,
} from '../../contracts/src/index.js';
import type { AIRuntime } from '../../ai-runtime/src/index.js';
import type { ConversationEngine } from '../../core/src/engine.js';
import type { State } from '../../core/src/state.js';
import type { Scheduler } from '../../scheduler/src/index.js';
import {
  scopedServices,
  validatePluginGraph,
  type PluginServices,
} from './index.js';

export type ExecutionContext = PluginServices & {
  readonly scope: Readonly<Scope>;
};
export interface PluginRegistrar {
  memory(provider: MemoryTransport): void;
  model(provider: ModelProvider): void;
  tool(
    tool: Omit<ToolPlugin, 'execute'> & {
      execute(input: unknown, context: ExecutionContext): Promise<unknown>;
    },
  ): void;
  hook(
    hook: Omit<Hook, 'execute'> & {
      execute(
        subject: unknown,
        context: ExecutionContext,
      ): ReturnType<Hook['execute']>;
    },
  ): void;
  safety(
    safety: Omit<SafetyProvider, 'check'> & {
      check(
        stage: string,
        subject: unknown,
        context: ExecutionContext,
      ): ReturnType<SafetyProvider['check']>;
    },
  ): void;
  protocol(adapter: ProtocolAdapter): void;
  behavior(
    id: string,
    handler: (
      spec: Schedule,
      context: ExecutionContext,
    ) => Promise<string | null>,
  ): void;
}
export interface MimicPlugin {
  manifest: PluginManifest;
  setup(registrar: PluginRegistrar): void | Promise<void>;
}
export async function installPlugins(
  plugins: MimicPlugin[],
  host: {
    state: State;
    db: StorageProvider;
    ai: AIRuntime;
    memory: MemoryProvider;
    engine: ConversationEngine;
    scheduler: Scheduler;
  },
  builtin: PluginManifest[],
) {
  validatePluginGraph([...builtin, ...plugins.map((p) => p.manifest)]);
  const pending = [...plugins],
    installed = new Set(builtin.map((p) => p.id));
  while (pending.length) {
    const index = pending.findIndex((p) =>
      p.manifest.dependencies.every((id) => installed.has(id)),
    );
    if (index < 0) throw new Error('plugin_dependency_cycle');
    const plugin = pending.splice(index, 1)[0]!,
      m = plugin.manifest;
    if (!/^[a-z][a-z0-9-]{0,80}$/.test(m.id) || m.trust === 'isolated')
      throw new Error('unsupported_plugin_trust');
    const enabled = () => !host.state.config.disabledPlugins.includes(m.id);
    const context = (scope: Scope): ExecutionContext => ({
      ...scopedServices(m, scope, host.db, host.ai, host.memory),
      scope: Object.freeze({ ...scope, pluginId: m.id }),
    });
    const kind = (expected: PluginManifest['kind']) => {
      if (m.kind !== expected) throw new Error('plugin_kind_mismatch');
    };
    await plugin.setup({
      memory(provider) {
        kind('memory');
        const service = host.memory as MemoryProvider & {
          register?: (provider: MemoryTransport) => void;
        };
        if (m.id !== 'memory-' + provider.id || !service.register)
          throw new Error('memory_registry_unavailable');
        service.register(provider);
      },
      model(provider) {
        kind('model');
        if (m.id !== `model-${provider.id}`)
          throw new Error('model_plugin_id_mismatch');
        host.ai.register(provider);
      },
      tool(tool) {
        kind('tool');
        if (host.engine.tools.some((t) => t.name === tool.name))
          throw new Error('duplicate_tool');
        host.engine.tools.push({
          ...tool,
          pluginId: m.id,
          execute: async (input, scope) => {
            if (!enabled()) throw new Error('plugin_disabled');
            return tool.execute(input, context(scope));
          },
        });
      },
      hook(hook) {
        if (!m.permissions.includes(`hook.${hook.stage}`))
          throw new Error('plugin_permission_denied');
        host.engine.hooks.register({
          ...hook,
          id: `${m.id}:${hook.id}`,
          execute: async (subject, scope) =>
            enabled() ? hook.execute(subject, context(scope)) : { allow: true },
        });
      },
      safety(safety) {
        kind('safety');
        host.engine.safety = {
          id: m.id,
          check: async (stage, subject, scope) =>
            enabled()
              ? safety.check(stage, subject, context(scope))
              : { allow: false, reason: 'safety_plugin_disabled' },
        };
      },
      protocol(adapter) {
        kind('protocol');
        if (!m.permissions.includes('protocol.send'))
          throw new Error('plugin_permission_denied');
        if (host.engine.protocols.has(adapter.id))
          throw new Error('duplicate_protocol');
        host.engine.protocols.set(adapter.id, {
          id: adapter.id,
          coverage: adapter.coverage
            ? (workspace) =>
                enabled() ? adapter.coverage!(workspace) : 'unknown'
            : undefined,
          start: adapter.start
            ? async (ingest, signal) => {
                if (enabled())
                  await adapter.start!(
                    async (event) =>
                      enabled() && !signal.aborted
                        ? ingest(event)
                        : { duplicate: true },
                    signal,
                  );
              }
            : undefined,
          stop: adapter.stop ? () => adapter.stop!() : undefined,
          send: async (action, signal) =>
            enabled()
              ? adapter.send(action, signal)
              : { status: 'failed', code: 'plugin_disabled' },
        });
      },
      behavior(id, handler) {
        kind('behavior');
        host.scheduler.register(`${m.id}:${id}`, async (spec, scope) =>
          enabled() ? handler(spec, context(scope)) : null,
        );
      },
    });
    installed.add(m.id);
  }
}
