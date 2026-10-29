import { describe, it, expect } from 'vitest';
import { fixture, message, fakeFetch } from './helpers.js';
import type {
  Run,
  Usage,
  Message,
  Workspace,
} from '../packages/contracts/src/index.js';
describe('conversation pipeline', () => {
  it('observes a message, uses one runtime for safety and chat, and never sends in shadow', async () => {
    const app = await fixture();
    try {
      await app.engine.ingest(message());
      await app.engine.idle();
      const runs = await app.db.list<Run>('run');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.value.status).toBe('shadow');
      expect(runs[0]!.value.draft).toContain('事务');
      expect(await app.db.list('send')).toHaveLength(0);
      const usage = await app.db.list<Usage>('usage');
      expect(usage).toHaveLength(4);
      expect(usage.every((r) => (r.value.requestChars ?? 0) > 0)).toBe(true);
      expect(usage.every((r) => r.value.status === 'reported')).toBe(true);
      expect(new Set(usage.map((r) => r.value.connectionId))).toEqual(
        new Set(['fixture']),
      );
    } finally {
      await app.cleanup();
    }
  });
  it('deduplicates repeated events and separates identical source IDs across groups', async () => {
    const app = await fixture();
    try {
      expect(await app.engine.ingest(message(), { schedule: false })).toEqual({
        duplicate: false,
      });
      expect(await app.engine.ingest(message(), { schedule: false })).toEqual({
        duplicate: true,
      });
      await app.engine.ingest(message({ workspaceId: 'group-b' }), {
        schedule: false,
      });
      expect(await app.db.list('message', 'group-a')).toHaveLength(1);
      expect(await app.db.list('message', 'group-b')).toHaveLength(1);
    } finally {
      await app.cleanup();
    }
  });
  it('does not send after the source is withdrawn while generation is pending', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let generating!: () => void;
    const started = new Promise<void>((r) => (generating = r));
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/chat/completions')) {
        generating();
        await blocked;
      }
      return fakeFetch(input, init);
    };
    const app = await fixture(fetcher);
    try {
      await app.state.save(
        { ...app.state.config, mode: 'live' },
        app.state.revision,
      );
      const m = message();
      await app.engine.ingest(m);
      await started;
      await app.engine.ingest({ ...m, kind: 'deleted', text: '', revision: 2 });
      release();
      await app.engine.idle();
      expect(await app.db.list('send')).toHaveLength(0);
      expect((await app.db.list<Run>('run'))[0]!.value.status).toBe(
        'cancelled',
      );
    } finally {
      release?.();
      await app.cleanup();
    }
  });
  it('persists a single delivery and confirmed bot message in local replay live mode', async () => {
    const app = await fixture();
    try {
      await app.state.save(
        { ...app.state.config, mode: 'live' },
        app.state.revision,
      );
      const m = message();
      await app.engine.ingest(m);
      await app.engine.idle();
      expect((await app.db.list<Run>('run'))[0]!.value.status).toBe('sent');
      expect(await app.db.list('send')).toHaveLength(1);
      expect(
        (await app.db.list<Message>('message', 'group-a')).filter(
          (r) => r.value.bot,
        ),
      ).toHaveLength(1);
      await app.engine.start(m);
      expect(await app.db.list('send')).toHaveLength(1);
    } finally {
      await app.cleanup();
    }
  });
  it('fails closed on safety provider failure and records uncertain usage', async () => {
    const app = await fixture(async () => {
      throw new Error('network_timeout');
    });
    try {
      await app.engine.ingest(message());
      await app.engine.idle();
      const run = (await app.db.list<Run>('run'))[0]!.value;
      expect(run.status).toBe('silent');
      expect(run.reason).toBe('safety_unavailable');
      expect((await app.db.list<Usage>('usage'))[0]!.value.status).toBe(
        'unknown',
      );
      expect(await app.db.list('send')).toHaveLength(0);
    } finally {
      await app.cleanup();
    }
  });
  it('storage CAS is atomic and plugin namespaced records cannot overwrite core config', async () => {
    const app = await fixture();
    try {
      const ws: Workspace = {
        id: 'g',
        name: 'g',
        connectionId: 'replay',
        kind: 'group',
        revision: 1,
        receive: 'all_messages',
        paused: false,
        proactive: false,
        lastSentAt: 0,
        lastObservedAt: 0,
      };
      await app.db.commit([
        { key: 'w', kind: 'workspace', scope: 'g', value: ws, expected: null },
      ]);
      await expect(
        app.db.commit([
          { key: 'new', kind: 'test', scope: 'g', value: 1, expected: null },
          { key: 'w', kind: 'workspace', scope: 'g', value: ws, expected: 99 },
        ]),
      ).rejects.toThrow('revision_conflict');
      expect(await app.db.get('new')).toBeUndefined();
    } finally {
      await app.cleanup();
    }
  });
});
