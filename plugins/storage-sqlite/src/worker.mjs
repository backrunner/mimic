import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { eq, and, or, lt, gt, asc, desc } from 'drizzle-orm';
const sqlite = new DatabaseSync(workerData.path);
sqlite.exec(
  'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
);
if (sqlite.prepare('PRAGMA user_version').get().user_version > 1)
  throw new Error('storage_schema_too_new');
sqlite.exec(
  `CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS records_listing ON records(kind,scope,at DESC); CREATE INDEX IF NOT EXISTS records_scan ON records(kind,key); PRAGMA user_version=1;`,
);
const records = sqliteTable('records', {
  key: text().primaryKey(),
  kind: text().notNull(),
  scope: text().notNull(),
  revision: integer().notNull(),
  value: text({ mode: 'json' }).notNull(),
  at: integer().notNull(),
});
const db = drizzle(async (sql, params, method) => {
  const statement = sqlite.prepare(sql);
  if (method === 'run') return { rows: statement.run(...params) };
  statement.setReturnArrays(true);
  return {
    rows:
      method === 'get' ? statement.get(...params) : statement.all(...params),
  };
});
const get = (key) =>
  db.select().from(records).where(eq(records.key, key)).get();
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(() => handle(message));
});
async function handle({ id, method, args }) {
  try {
    let result;
    if (method === 'get') result = await get(args[0]);
    else if (method === 'scan') {
      result = await db
        .select()
        .from(records)
        .where(and(eq(records.kind, args[0]), gt(records.key, args[1] ?? '')))
        .orderBy(asc(records.key))
        .limit(Math.min(args[2] ?? 200, 1000))
        .all();
    } else if (method === 'list') {
      const [kind, scope, limit = 100, before, beforeKey] = args;
      const filters = [eq(records.kind, kind)];
      if (scope !== undefined) filters.push(eq(records.scope, scope));
      if (before !== undefined)
        filters.push(
          beforeKey === undefined
            ? lt(records.at, before)
            : or(
                lt(records.at, before),
                and(eq(records.at, before), lt(records.key, beforeKey)),
              ),
        );
      result = await db
        .select()
        .from(records)
        .where(and(...filters))
        .orderBy(desc(records.at), desc(records.key))
        .limit(Math.min(limit, 1000))
        .all();
    } else if (method === 'commit') {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const [writes, guards = []] = args;
        if (new Set(writes.map((w) => w.key)).size !== writes.length)
          throw new Error('duplicate_write_key');
        for (const entry of [...guards, ...writes])
          if (
            ((await get(entry.key))?.revision ?? null) !==
            (entry.expected === undefined ? entry.revision : entry.expected)
          )
            throw new Error('revision_conflict');
        for (const write of writes) {
          const revision = ((await get(write.key))?.revision ?? 0) + 1;
          const value = {
            key: write.key,
            kind: write.kind,
            scope: write.scope,
            revision,
            value: write.value,
            at: write.at ?? Date.now(),
          };
          await db
            .insert(records)
            .values(value)
            .onConflictDoUpdate({ target: records.key, set: value })
            .run();
        }
        sqlite.exec('COMMIT');
        result = true;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    } else if (method === 'delete') {
      if ((await get(args[0]))?.revision !== args[1])
        throw new Error('revision_conflict');
      await db.delete(records).where(eq(records.key, args[0])).run();
      result = true;
    } else if (method === 'stats')
      result = {
        driver: 'sqlite/drizzle',
        journal: 'wal',
        schemaVersion: 1,
        records: sqlite.prepare('SELECT count(*) AS count FROM records').get()
          .count,
        pageCount: sqlite.prepare('PRAGMA page_count').get().page_count,
      };
    else if (method === 'backup') {
      sqlite.prepare('VACUUM INTO ?').run(args[0]);
      result = true;
    } else if (method === 'close') {
      sqlite.close();
      result = true;
    } else throw new Error('unsupported_storage_operation');
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : 'storage_error',
    });
  }
}
