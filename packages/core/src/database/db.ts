import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import type { AppConfig } from '../config.js';
import { getConfig } from '../config.js';
import { ConfigurationError } from '../errors.js';
import { repoRoot } from '../paths.js';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = '2';

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
    if (rows[0] && rows[0].value !== SCHEMA_VERSION) {
      throw new ConfigurationError(`Database schema version ${rows[0].value} != expected ${SCHEMA_VERSION}`);
    }
  }
}

class SQLiteDatabase implements IDatabase {
  readonly dialect = 'sqlite' as const;
  private db: any;
  private txDepth = 0;

  constructor(filePath: string) {
    const { DatabaseSync } = require('node:sqlite');
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }

  async initSchema(): Promise<void> {
    await checkVersion(this, async (name) => (await this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name])).length > 0);
    this.db.exec(schemaSql());
    await this.execute(`INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO NOTHING`, [SCHEMA_VERSION]);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const info = this.db.prepare(sql).run(...params);
    return { changes: Number(info.changes) };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = await fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDatabase implements IDatabase {
  readonly dialect = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async initSchema(): Promise<void> {
    await checkVersion(this, async (name) =>
      (await this.query(`SELECT table_name FROM information_schema.tables WHERE table_name = ?`, [name])).length > 0
    );
    await this.pool.query(schemaSql());
    await this.execute(`INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO NOTHING`, [SCHEMA_VERSION]);
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
    return (await this.pool.query(PostgresDatabase.toPg(sql), params)).rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return { changes: (await this.pool.query(PostgresDatabase.toPg(sql), params)).rowCount ?? 0 };
  }

  // NOTE: single-connection transactions would need a dedicated client; statements used inside
  // transaction() are individually atomic and guarded by unique indexes / conditional updates.
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
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
  return new PostgresDatabase(cfg.DATABASE_URL);
}

export function getDatabase(memoryOnly = false): IDatabase {
  if (memoryOnly) return createDatabase(getConfig(), true);
  if (!dbInstance) dbInstance = createDatabase(getConfig());
  return dbInstance;
}
