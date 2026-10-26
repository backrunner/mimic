import { z } from 'zod';
import type { MimicPlugin } from '../packages/plugin-sdk/src/index.js';
import type { RecordEntry } from '../packages/contracts/src/index.js';
/** Demonstrates scoped data and shared admin settings; no database handle. */
export default {
  manifest: {
    id: 'tool-counter',
    name: '示例计数工具',
    kind: 'tool',
    version: '0.1.0',
    dependencies: [],
    permissions: ['data.read', 'data.write', 'config.read'],
    admin: 'tool-counter',
    trust: 'trustedInProcess',
  },
  setup(registrar) {
    registrar.tool({
      name: 'counter_increment',
      effect: 'compute',
      schema: z.object({}).strict(),
      definition: {
        type: 'function',
        function: {
          name: 'counter_increment',
          description: '为当前会话的示例计数器加一。仅在用户要求时使用。',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      async execute(_input, services) {
        const settings = (await services.settings.get('settings')) as
          RecordEntry<{ enabled?: boolean }> | undefined;
        if (settings?.value.enabled === false)
          throw new Error('counter_disabled');
        const old = (await services.data.get('count')) as
          RecordEntry<number> | undefined;
        const count = (old?.value ?? 0) + 1;
        await services.data.put('count', count, old?.revision ?? null);
        return { count };
      },
    });
  },
} satisfies MimicPlugin;
