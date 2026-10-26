import type { State } from './state.js';
/** Core owns retention. Config, secrets, assets, plugin records and schedules are retained. */
export async function pruneHistory(state: State, now = Date.now()) {
  const before = now - state.config.retentionDays * 86400000;
  let removed = 0;
  for (const kind of [
    'message',
    'message-policy',
    'run',
    'audit',
    'usage',
    'send',
    'job',
    'budget',
    'topic',
    'frame',
    'group-profile',
    'memory-recall',
  ]) {
    for (;;) {
      const rows = await state.db.list(kind, undefined, 250, before);
      if (!rows.length) break;
      for (const row of rows) {
        try {
          await state.db.delete(row.key, row.revision);
          removed++;
        } catch (e) {
          if (!(e instanceof Error) || e.message !== 'revision_conflict')
            throw e;
        }
      }
      if (rows.length < 250) break;
    }
  }
  await state.audit('retention.completed', { before, removed });
  return { before, removed };
}
