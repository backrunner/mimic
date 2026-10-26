import { CronExpressionParser } from 'cron-parser';
import {
  scheduleSchema,
  type Schedule,
  type Message,
  type Scope,
} from '../../contracts/src/index.js';
import { State, uid, errorCode } from '../../core/src/state.js';
import { ConversationEngine } from '../../core/src/engine.js';
import { isQuiet } from '../../core/src/decisions.js';
export interface ScheduledJob {
  spec: Schedule;
  nextAt: number;
  occurrence: string;
  leaseUntil: number;
  fence: number;
  lastStatus?: string;
  lastAt?: number;
}
export function nextTime(spec: Schedule, now: number, random = Math.random) {
  if (spec.kind === 'once') {
    if (!spec.onceAt || spec.onceAt <= now)
      throw new Error('once_time_must_be_future');
    return spec.onceAt;
  }
  if (spec.kind === 'random')
    return (
      now + spec.minMs + Math.floor(random() * (spec.maxMs - spec.minMs + 1))
    );
  return CronExpressionParser.parse(spec.expression, {
    currentDate: new Date(now),
    tz: spec.timezone,
  })
    .next()
    .getTime();
}
export function preview(spec: Schedule, now = Date.now()) {
  const times: number[] = [];
  for (let i = 0; i < (spec.kind === 'once' ? 1 : 10); i++) {
    now = nextTime(spec, now, () => 0.5);
    times.push(now);
  }
  return { times, randomEstimate: spec.kind === 'random' };
}
export class Scheduler {
  #handlers = new Map<
    string,
    (spec: Schedule, scope: Scope) => Promise<string | null>
  >();
  register(
    id: string,
    handler: (spec: Schedule, scope: Scope) => Promise<string | null>,
  ) {
    if (this.#handlers.has(id)) throw new Error('duplicate_behavior');
    this.#handlers.set(id, handler);
  }
  #timer?: ReturnType<typeof setInterval>;
  #busy = false;
  constructor(
    readonly state: State,
    readonly engine: ConversationEngine,
  ) {}
  async save(input: unknown, expected: number | null) {
    const spec = scheduleSchema.parse(input);
    new Intl.DateTimeFormat('en', { timeZone: spec.timezone });
    preview(spec);
    const key = `schedule:${spec.id}`,
      old = await this.state.db.get<ScheduledJob>(key);
    if ((old?.revision ?? null) !== expected)
      throw new Error('revision_conflict');
    const same = old && JSON.stringify(old.value.spec) === JSON.stringify(spec);
    const value: ScheduledJob = same
      ? old.value
      : {
          spec,
          nextAt: nextTime(spec, Date.now()),
          occurrence: uid(),
          leaseUntil: 0,
          fence: (old?.value.fence ?? 0) + 1,
        };
    await this.state.db.commit([
      { key, kind: 'schedule', scope: spec.workspaceId, value, expected },
    ]);
    return value;
  }
  start() {
    this.#timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.state.audit('scheduler.failed', { code: errorCode(e) }),
      );
    }, 1000);
  }
  async tick(now = Date.now()) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (this.state.config.disabledPlugins.includes('behavior-scheduled'))
        return;
      for await (const row of this.state.scan<ScheduledJob>('schedule')) {
        const job = row.value;
        if (!job.spec.enabled || job.nextAt > now || job.leaseUntil > now)
          continue;
        await this.execute(job.spec.id, false, now, row.revision);
      }
    } finally {
      this.#busy = false;
    }
  }
  async execute(
    id: string,
    dryRun = true,
    now = Date.now(),
    expected?: number,
  ) {
    if (this.state.config.disabledPlugins.includes('behavior-scheduled'))
      throw new Error('plugin_disabled');
    const key = `schedule:${id}`,
      row = await this.state.db.get<ScheduledJob>(key);
    if (!row) throw new Error('schedule_missing');
    const job = row.value;
    if (expected !== undefined && expected !== row.revision) return;
    if (job.leaseUntil > now) throw new Error('job_running');
    const fence = job.fence + 1,
      claimed = { ...job, fence, leaseUntil: now + 180000 };
    await this.state.db.commit([
      {
        key,
        kind: 'schedule',
        scope: job.spec.workspaceId,
        value: claimed,
        expected: row.revision,
      },
    ]);
    let status = 'completed';
    try {
      if (
        !dryRun &&
        isQuiet(now, job.spec.quietStart, job.spec.quietEnd, job.spec.timezone)
      )
        status = 'skipped_quiet_hours';
      else if (
        !dryRun &&
        now - job.nextAt > 60000 &&
        job.spec.misfire === 'skip'
      )
        status = 'skipped_misfire';
      else {
        const message = (
          await this.state.db.list<Message>('message', job.spec.workspaceId, 1)
        )[0]?.value;
        if (!message) status = 'skipped_no_context';
        else {
          const handler =
            job.spec.handler === 'participate'
              ? undefined
              : this.#handlers.get(job.spec.handler);
          if (job.spec.handler !== 'participate' && !handler)
            throw new Error('behavior_missing');
          const proposal = handler
            ? await handler(job.spec, {
                workspaceId: job.spec.workspaceId,
                runId: uid(),
                pluginId: job.spec.handler.split(':')[0]!,
                signal: AbortSignal.timeout(30000),
              })
            : job.spec.prompt;
          if (proposal)
            await this.engine.start(
              { ...message, bot: false, mentions: [], direct: false },
              proposal,
              dryRun,
              job.occurrence,
            );
          status = dryRun ? 'dry_run' : 'proposal_evaluated';
        }
      }
    } catch (e) {
      status = errorCode(e);
    } finally {
      const current = await this.state.db.get<ScheduledJob>(key);
      if (current?.value.fence === fence) {
        const next = dryRun
          ? job.nextAt
          : job.spec.kind === 'once'
            ? job.nextAt
            : nextTime(job.spec, Date.now());
        await this.state.db.commit([
          {
            key,
            kind: 'schedule',
            scope: job.spec.workspaceId,
            value: {
              ...current.value,
              spec: {
                ...job.spec,
                enabled:
                  job.spec.kind === 'once' && !dryRun
                    ? false
                    : job.spec.enabled,
              },
              nextAt: next,
              occurrence: dryRun ? job.occurrence : uid(),
              leaseUntil: 0,
              lastStatus: status,
              lastAt: now,
            },
            expected: current.revision,
          },
          {
            key: `job:${uid()}`,
            kind: 'job',
            scope: job.spec.workspaceId,
            value: {
              scheduleId: id,
              occurrence: job.occurrence,
              dryRun,
              status,
              at: now,
            },
            expected: null,
          },
        ]);
      }
    }
    return { status };
  }
  async stop() {
    clearInterval(this.#timer);
    while (this.#busy) await new Promise((r) => setTimeout(r, 10));
  }
}
