import type { MemoryProvider } from '../../../packages/contracts/src/index.js';
export const disabledMemory: MemoryProvider = {
  id: 'memory-disabled',
  async recall() {
    return { status: 'disabled', items: [] };
  },
};
