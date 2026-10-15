import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { AppConfig } from '../config.js';
import { getConfig } from '../config.js';
import { ConfigurationError, DatabaseUnavailableError } from '../errors.js';
import { repoRoot } from '../paths.js';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = '3';
/** Older versions that can be upgraded in place (later versions only add tables/indexes). */
const MIGRATABLE_FROM = new Set(['2']);

export interface IDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  initSchema(): Promise<void>;
}

function schemaSql(): string {
  const p = path.join(repoRoot(), 'database', 'schema.sql');
  if (!fs.existsSync(p)) throw new ConfigurationError(`Database schema file missing: ${p}`);
  return fs.readFileSync(p, 'utf-8');
}

async function checkVersion(db: IDatabase, tableExists: (name: string) => Promise<boolean>): Promise<void> {
  const hasMeta = await tableExists('schema_meta');
  const hasLegacy = await tableExists('topics');
  if (!hasMeta && hasLegacy) {
    throw new ConfigurationError(
      'Database was created by an older, incompatible schema (v1). Move or delete it (e.g. database/dev.sqlite) so a v2 schema can be created.'
    );
  }
  if (hasMeta) {
    const rows = await db.query<{ value: string }>(`SELECT value FROM schema_meta WHERE key = 'version'`);
    if (rows[0] && rows[0].value !== SCHEMA_VERSION && !MIGRATABLE_FROM.has(rows[0].value)) {
      throw new ConfigurationError(`Database schema version ${rows[0].value} != expected ${SCHEMA_VERSION}`);
    }
  }
}

class SQLiteDatabase implements IDatabase {
  readonly dialect = 'sqlite' as const;
  private db: any;
  private readonly tx = new AsyncLocalStorage<true>();
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    const { DatabaseSync } = require('node:sqlite');
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }

  async initSchema(): Promise<void> {
    await checkVersion(this, async (name) => (await this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name])).length > 0);
    this.db.exec(schemaSql());
    await this.execute(`INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION]);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const info = this.db.prepare(sql).run(...params);
    return { changes: Number(info.changes) };
  }

  /**
   * One connection, so concurrent transactions are queued; a nested call (same async context) joins
   * the enclosing transaction. Statements issued outside any transaction while one is open still run
   * on the shared connection (single-process SQLite mode; use Postgres for multi-process deployments).
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await this.tx.run(true, fn);
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    const p = this.txQueue.then(run, run);
    this.txQueue = p.catch(() => undefined);
    return p;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Connection-level failures (as opposed to SQL errors) become a clear, retryable DatabaseUnavailableError. */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', '57P01', '57P03', '08000', '08001', '08003', '08004', '08006', '28P01', '3D000']);
function wrapPgError(err: unknown): unknown {
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if ((e?.code && CONNECTION_CODES.has(e.code)) || /timeout exceeded when trying to connect|Connection terminated/i.test(msg)) {
    return new DatabaseUnavailableError(`cannot reach PostgreSQL (${e?.code ?? 'connect'}): ${msg}`, err);
  }
  return err;
}

class PostgresDatabase implements IDatabase {
  readonly dialect = 'postgres' as const;
  private pool: pg.Pool;
  /** Client bound to the current async context while a transaction is open. */
  private readonly tx = new AsyncLocalStorage<pg.PoolClient>();

  constructor(connectionString: string, opts: { connectTimeoutMs?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, connectionTimeoutMillis: opts.connectTimeoutMs ?? 5000, max: 10 });
    // An idle client dying (server restart) must not crash the process; the next query reports it.
    this.pool.on('error', () => undefined);
  }

  private runner(): pg.Pool | pg.PoolClient {
    return this.tx.getStore() ?? this.pool;
  }

  async initSchema(): Promise<void> {
    // Serialize schema creation across processes (concurrent CREATE ... IF NOT EXISTS can still race).
    const client = await this.pool.connect().catch((e) => {
      throw wrapPgError(e);
    });
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('shorts_schema'))`);
      await this.tx.run(client, async () => {
        await checkVersion(this, async (name) =>
          (await this.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`, [name])).length > 0
        );
        await client.query(schemaSql());
        await this.execute(`INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION]);
      });
    } catch (e) {
      throw wrapPgError(e);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('shorts_schema'))`).catch(() => undefined);
      client.release();
    }
  }

  /** Converts `?` placeholders (outside single-quoted literals) to $1..$n. */
  static toPg(sql: string): string {
    let inQuotes = false;
    let i = 1;
    let out = '';
    for (const ch of sql) {
      if (ch === "'") inQuotes = !inQuotes;
      out += ch === '?' && !inQuotes ? `$${i++}` : ch;
    }
    return out;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return (await this.runner().query(PostgresDatabase.toPg(sql), params)).rows as T[];
    } catch (e) {
      throw wrapPgError(e);
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    try {
      return { changes: (await this.runner().query(PostgresDatabase.toPg(sql), params)).rowCount ?? 0 };
    } catch (e) {
      throw wrapPgError(e);
    }
  }

  /** Real transaction on a dedicated client; nested calls in the same async context join it. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    const client = await this.pool.connect().catch((e) => {
      throw wrapPgError(e);
    });
    try {
      await client.query('BEGIN');
      const out = await this.tx.run(client, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw wrapPgError(e);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { PostgresDatabase };

let dbInstance: IDatabase | null = null;

export function createDatabase(cfg: AppConfig, memoryOnly = false): IDatabase {
  if (memoryOnly) return new SQLiteDatabase(':memory:');
  if (cfg.USE_SQLITE_FALLBACK) return new SQLiteDatabase(cfg.sqlitePath);
  if (!cfg.DATABASE_URL) throw new ConfigurationError('USE_SQLITE_FALLBACK=false requires DATABASE_URL');
  return new PostgresDatabase(cfg.DATABASE_URL, { connectTimeoutMs: cfg.DB_CONNECT_TIMEOUT_MS });
}

export function getDatabase(memoryOnly = false): IDatabase {
  if (memoryOnly) return createDatabase(getConfig(), true);
  if (!dbInstance) dbInstance = createDatabase(getConfig());
  return dbInstance;
}
