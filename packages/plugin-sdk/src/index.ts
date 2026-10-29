import { z } from 'zod';
import type {
  PluginManifest,
  Scope,
  Hook,
  StorageProvider,
  MemoryProvider,
} from '../../contracts/src/index.js';
import { AIRuntime } from '../../ai-runtime/src/index.js';
export type {
  PluginManifest,
  ToolPlugin,
  ProtocolAdapter,
  MemoryProvider,
  Hook,
  StorageProvider,
  SafetyProvider,
  ToolExecutionScope,
} from '../../contracts/src/index.js';
export class HookRegistry {
  #hooks: Hook[] = [];
  register(hook: Hook) {
    if (this.#hooks.some((h) => h.id === hook.id))
      throw new Error('duplicate_hook');
    this.#hooks.push(hook);
    this.#hooks.sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
    );
  }
  async run(stage: Hook['stage'], subject: unknown, scope: Scope) {
    for (const hook of this.#hooks.filter((h) => h.stage === stage)) {
      const signal = AbortSignal.any([
        scope.signal,
        AbortSignal.timeout(hook.timeoutMs),
      ]);
      let onAbort: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        const result = await Promise.race([
          hook.execute(structuredClone(subject), { ...scope, signal }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('hook_timeout'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
        if (!result.allow) return result;
      } catch {
        if (hook.required) return { allow: false, reason: 'hook_failed' };
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    return { allow: true };
  }
}
export type {
  MimicPlugin,
  PluginRegistrar,
  ExecutionContext,
  ToolExecutionContext,
  SafetyExecutionContext,
} from './host.js';
export interface PluginServices {
  settings: { get(key: string): Promise<unknown> };
  data: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown, expected: number | null): Promise<void>;
  };
  ai: {
    decide: (
      role: string,
      state: unknown,
      questions: Parameters<AIRuntime['decide']>[2],
    ) => ReturnType<AIRuntime['decide']>;
    generate: (
      messages: Parameters<AIRuntime['generate']>[0],
      tools: Parameters<AIRuntime['generate']>[1],
    ) => ReturnType<AIRuntime['generate']>;
    web: (
      operation: 'search' | 'fetch',
      input: unknown,
    ) => ReturnType<AIRuntime['web']>;
  };
  memory: {
    recall(
      query: string,
      options?: Parameters<MemoryProvider['recall']>[2],
    ): ReturnType<MemoryProvider['recall']>;
    propose(
      candidate: Parameters<NonNullable<MemoryProvider['propose']>>[0],
    ): Promise<Record<string, unknown>>;
  };
}
export function scopedServices(
  manifest: PluginManifest,
  scope: Scope,
  db: StorageProvider,
  ai: AIRuntime,
  memory: MemoryProvider,
): PluginServices {
  const prefix = `plugin:${manifest.id}:${scope.workspaceId}:`;
  const checked = (key: string) => {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key))
      throw new Error('invalid_plugin_key');
    return prefix + key;
  };
  const requirePermission = (p: string) => {
    if (!manifest.permissions.includes(p))
      throw new Error('plugin_permission_denied');
  };
  return {
    settings: {
      async get(key) {
        requirePermission('config.read');
        checked(key);
        return db.get(`plugin-config:${manifest.id}:${key}`);
      },
    },
    data: {
      async get(key) {
        requirePermission('data.read');
        return db.get(checked(key));
      },
      async put(key, value, expected) {
        requirePermission('data.write');
        z.json().parse(value);
        if (JSON.stringify(value).length > 65536)
          throw new Error('plugin_record_too_large');
        await db.commit([
          {
            key: checked(key),
            kind: `plugin:${manifest.id}`,
            scope: scope.workspaceId,
            value,
            expected,
          },
        ]);
      },
    },
    ai: {
      generate: async (messages, tools) => {
        requirePermission('ai.chat');
        return ai.generate(messages, tools, {
          ...scope,
          pluginId: manifest.id,
        });
      },
      web: async (operation, input) => {
        requirePermission('ai.web-search');
        return ai.web(operation, input, { ...scope, pluginId: manifest.id });
      },
      decide: async (role, state, questions) => {
        requirePermission(`ai.${role}`);
        return ai.decide(role, state, questions, {
          ...scope,
          pluginId: manifest.id,
        });
      },
    },
    memory: {
      propose: async (candidate) => {
        requirePermission('memory.propose');
        if (!memory.propose) throw new Error('memory_candidates_unsupported');
        return memory.propose(candidate, { ...scope, pluginId: manifest.id });
      },
      recall: async (query, options) => {
        requirePermission('memory.read');
        return memory.recall(
          query,
          { ...scope, pluginId: manifest.id },
          options,
        );
      },
    },
  };
}
export function validatePluginGraph(manifests: PluginManifest[]) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  if (byId.size !== manifests.length) throw new Error('duplicate_plugin');
  const visited = new Set<string>(),
    stack = new Set<string>();
  function visit(id: string) {
    if (stack.has(id)) throw new Error('plugin_dependency_cycle');
    if (visited.has(id)) return;
    const m = byId.get(id);
    if (!m) throw new Error('plugin_dependency_missing');
    stack.add(id);
    m.dependencies.forEach(visit);
    stack.delete(id);
    visited.add(id);
  }
  manifests.forEach((m) => visit(m.id));
}
