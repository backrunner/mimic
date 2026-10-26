import { Worker } from 'node:worker_threads';
import type {
  StorageProvider,
  RecordEntry,
  Write,
} from '../../../packages/contracts/src/index.js';
export class SqliteStorage implements StorageProvider {
  #worker: Worker;
  #failure?: Error;
  #next = 0;
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  constructor(path: string) {
    this.#worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { path },
    });
    this.#worker.on('message', ({ id, result, error }) => {
      const p = this.#pending.get(id);
      this.#pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    });
    this.#worker.on('exit', (code) => {
      this.#failure ??= new Error(`storage_worker_exited_${code}`);
      for (const p of this.#pending.values()) p.reject(this.#failure);
      this.#pending.clear();
    });
    this.#worker.on('error', (e) => {
      this.#failure =
        e instanceof Error ? e : new Error('storage_worker_failed');
      for (const p of this.#pending.values())
        p.reject(e instanceof Error ? e : new Error('storage_worker_failed'));
      this.#pending.clear();
    });
  }
  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      this.#pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.#worker.postMessage({ id, method, args });
    });
  }
  get<T>(key: string) {
    return this.#call<RecordEntry<T> | undefined>('get', key);
  }
  scan<T>(kind: string, after = '', limit = 200) {
    return this.#call<RecordEntry<T>[]>('scan', kind, after, limit);
  }
  list<T>(
    kind: string,
    scope?: string,
    limit = 100,
    before?: number,
    beforeKey?: string,
  ) {
    return this.#call<RecordEntry<T>[]>(
      'list',
      kind,
      scope,
      limit,
      before,
      beforeKey,
    );
  }
  commit(writes: Write[], guards?: { key: string; revision: number | null }[]) {
    return this.#call<void>('commit', writes, guards);
  }
  delete(key: string, expected: number) {
    return this.#call<void>('delete', key, expected);
  }
  stats() {
    return this.#call<Record<string, unknown>>('stats');
  }
  backup(path: string) {
    return this.#call<void>('backup', path);
  }
  async close() {
    if (!this.#failure) await this.#call('close');
    await this.#worker.terminate();
  }
}
