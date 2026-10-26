import {
  createHash,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  configSchema,
  type Config,
  type StorageProvider,
} from '../../contracts/src/index.js';
export const uid = () => randomUUID();
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function errorCode(e: unknown) {
  const code = e instanceof Error ? e.message : 'unknown_error';
  return /^[a-z0-9_:.-]{1,100}$/i.test(code) ? code : 'operation_failed';
}
export class State {
  config: Config = configSchema.parse({});
  revision = 0;
  #configAbort = new AbortController();
  get configSignal() {
    return this.#configAbort.signal;
  }
  #master!: Buffer;
  #saveQueue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly db: StorageProvider,
    readonly dataDir: string,
  ) {}
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const keyFile = join(this.dataDir, 'master.key');
    try {
      this.#master = await readFile(keyFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.#master = randomBytes(32);
      await writeFile(keyFile, this.#master, { mode: 0o600, flag: 'wx' });
    }
    if (this.#master.length !== 32) throw new Error('invalid_master_key');
    const existing = await this.db.get<Config>('config');
    if (existing) {
      this.config = configSchema.parse(existing.value);
      this.revision = existing.revision;
    } else {
      try {
        this.config.soul = await readFile(
          join(this.dataDir, 'soul.md'),
          'utf8',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await this.save(this.config, 0);
    }
  }
  async save(input: unknown, expected: number) {
    const snapshot = configSchema.parse(input);
    const result = this.#saveQueue.then(() => this.#save(snapshot, expected));
    this.#saveQueue = result.catch(() => {});
    return result;
  }
  async #save(config: Config, expected: number) {
    const configured = (memory: Config['memory']) =>
      Boolean(memory.secretRef.trim() && memory.bindings.length);
    if (!configured(config.memory)) config.memory.enabled = false;
    else if (!configured(this.config.memory)) config.memory.enabled = true;
    const memoryUrl = new URL(config.memory.baseUrl);
    if (
      !['http:', 'https:'].includes(memoryUrl.protocol) ||
      memoryUrl.username ||
      memoryUrl.password ||
      memoryUrl.search ||
      memoryUrl.hash
    )
      throw new Error('invalid_memory_url');
    if (
      new Set(config.memory.bindings.map((b) => b.workspaceId)).size !==
      config.memory.bindings.length
    )
      throw new Error('duplicate_memory_binding');
    if (
      new Set(config.memory.bindings.map((b) => b.remoteWorkspaceId)).size !==
      config.memory.bindings.length
    )
      throw new Error('duplicate_remote_memory_binding');
    for (const b of config.memory.bindings)
      if (
        (b.partitionId && !b.audienceActorIds.length) ||
        (!b.partitionId && b.audienceActorIds.length)
      )
        throw new Error('invalid_memory_audience');
    if (
      new Set(config.connections.map((c) => c.id)).size !==
      config.connections.length
    )
      throw new Error('duplicate_connection');
    for (const route of Object.values(config.routes))
      if (
        !config.connections.some(
          (c) => c.id === route.connectionId && c.enabled,
        )
      )
        throw new Error('route_connection_missing');
    new Intl.DateTimeFormat('en', { timeZone: config.behavior.timezone });
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.behavior.quietStart) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.behavior.quietEnd)
    )
      throw new Error('invalid_quiet_hours');
    for (const c of config.connections) {
      const url = new URL(c.baseUrl);
      if (
        url.username ||
        url.password ||
        !['https:', 'http:'].includes(url.protocol)
      )
        throw new Error('invalid_provider_url');
      if (url.protocol === 'http:' && c.provider !== 'local')
        throw new Error('provider_https_required');
    }
    await this.db.commit([
      {
        key: 'config',
        kind: 'config',
        scope: 'system',
        value: config,
        expected: expected || null,
      },
    ]);
    this.config = config;
    this.revision = expected + 1;
    this.#configAbort.abort();
    this.#configAbort = new AbortController();
    await writeFile(join(this.dataDir, 'soul.md'), config.soul, {
      mode: 0o600,
    });
    await this.audit('config.updated', { revision: this.revision });
  }
  async setSecret(name: string, plaintext: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name) || plaintext.length > 16000)
      throw new Error('invalid_secret');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.#master, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const key = `secret:${name}`,
      old = await this.db.get(key);
    await this.db.commit([
      {
        key,
        kind: 'secret',
        scope: 'system',
        value: {
          nonce: nonce.toString('base64'),
          cipher: encrypted.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
        },
        expected: old?.revision ?? null,
      },
    ]);
    await this.audit('secret.updated', { name });
    return `secret:${name}`;
  }
  async *scan<T>(kind: string) {
    let after = '';
    for (;;) {
      const rows = await this.db.scan<T>(kind, after, 200);
      for (const row of rows) yield row;
      if (rows.length < 200) return;
      after = rows.at(-1)!.key;
    }
  }
  async secret(ref: string) {
    if (!ref) return '';
    if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? '';
    if (!ref.startsWith('secret:')) throw new Error('unsupported_secret_ref');
    const row = await this.db.get<{
      nonce: string;
      cipher: string;
      tag: string;
    }>(ref);
    if (!row) throw new Error('secret_missing');
    const d = createDecipheriv(
      'aes-256-gcm',
      this.#master,
      Buffer.from(row.value.nonce, 'base64'),
    );
    d.setAuthTag(Buffer.from(row.value.tag, 'base64'));
    return Buffer.concat([
      d.update(Buffer.from(row.value.cipher, 'base64')),
      d.final(),
    ]).toString('utf8');
  }
  async asset(id: string) {
    return (
      await this.db.get<{
        data: string;
        mime: string;
        name: string;
        tags: string;
        alt: string;
      }>(`asset:${id}`)
    )?.value;
  }
  async searchAssets(query: string) {
    const rows = await this.db.list<{
      name: string;
      tags: string;
      alt: string;
    }>('asset', 'approved', 100);
    return rows
      .filter((r) =>
        `${r.value.name} ${r.value.tags} ${r.value.alt}`.includes(query),
      )
      .map((r) => ({
        id: r.key.slice(6),
        name: r.value.name,
        tags: r.value.tags,
        alt: r.value.alt,
      }))
      .slice(0, 10);
  }
  async audit(
    event: string,
    details: Record<string, unknown> = {},
    workspace = 'system',
  ) {
    await this.db.commit([
      {
        key: `audit:${uid()}`,
        kind: 'audit',
        scope: workspace,
        value: { event, details, at: Date.now() },
        expected: null,
      },
    ]);
  }
}
