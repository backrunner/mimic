import { it, expect } from 'vitest';
import { fixture } from './helpers.js';
import {
  nextTime,
  type ScheduledJob,
} from '../packages/scheduler/src/index.js';
import { scheduleSchema } from '../packages/contracts/src/index.js';
it('persists random next time; querying and disabled ticks never resample it', async () => {
  const app = await fixture();
  try {
    const spec = scheduleSchema.parse({
      id: 'random',
      name: 'test',
      workspaceId: 'empty',
      kind: 'random',
      prompt: '观察',
      minMs: 1000,
      maxMs: 2000,
    });
    const job = await app.scheduler.save(spec, null);
    expect(job.nextAt).toBeGreaterThan(Date.now());
    await app.scheduler.tick(job.nextAt + 10000);
    expect(
      (await app.db.get<ScheduledJob>('schedule:random'))!.value.nextAt,
    ).toBe(job.nextAt);
    const result = await app.scheduler.execute('random', true);
    expect(result?.status).toBe('skipped_no_context');
    expect(
      (await app.db.get<ScheduledJob>('schedule:random'))!.value.nextAt,
    ).toBe(job.nextAt);
  } finally {
    await app.cleanup();
  }
});
it('cron uses the specified IANA time zone and random bounds are deterministic with injected entropy', () => {
  const spec = scheduleSchema.parse({
    id: 's',
    name: 'x',
    workspaceId: 'w',
    kind: 'cron',
    expression: '0 12 * * *',
    timezone: 'Asia/Shanghai',
    prompt: '观察',
  });
  expect(
    new Date(nextTime(spec, Date.parse('2026-10-25T00:00:00Z'))).toISOString(),
  ).toBe('2026-10-25T04:00:00.000Z');
  expect(
    nextTime(
      { ...spec, kind: 'random', minMs: 1000, maxMs: 2000 },
      100,
      () => 0,
    ),
  ).toBe(1100);
});
