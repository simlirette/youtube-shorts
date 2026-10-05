import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export interface IDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  close(): Promise<void>;
  initSchema(): Promise<void>;
}

class SQLiteDatabase implements IDatabase {
  private db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      const dir = path.dirname(path.resolve(process.cwd(), filePath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(filePath === ':memory:' ? ':memory:' : path.resolve(process.cwd(), filePath));
    logger.info(`Initialized SQLite Database at: ${filePath}`, { stage: 'DATABASE' });
  }

  async initSchema(): Promise<void> {
    const schemaPath = path.resolve(process.cwd(), 'database/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
      this.db.exec(schemaSql);
      logger.info('Database schema applied successfully', { stage: 'DATABASE' });
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const results = stmt.all(...params) as T[];
    return results;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    return { changes: Number(info.changes) };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDatabase implements IDatabase {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
    logger.info('Initialized PostgreSQL connection pool', { stage: 'DATABASE' });
  }

  async initSchema(): Promise<void> {
    const schemaPath = path.resolve(process.cwd(), 'database/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
      await this.pool.query(schemaSql);
      logger.info('Database schema applied successfully to PostgreSQL', { stage: 'DATABASE' });
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    // Convert ? to $1, $2 for Postgres compatibility if needed
    let pgSql = sql;
    let paramIndex = 1;
    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);
    const res = await this.pool.query(pgSql, params);
    return res.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    let pgSql = sql;
    let paramIndex = 1;
    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);
    const res = await this.pool.query(pgSql, params);
    return { changes: res.rowCount || 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let dbInstance: IDatabase | null = null;

export function getDatabase(memoryOnly = false): IDatabase {
  if (memoryOnly) {
    const memDb = new SQLiteDatabase(':memory:');
    return memDb;
  }

  if (!dbInstance) {
    if (config.USE_SQLITE_FALLBACK) {
      dbInstance = new SQLiteDatabase(config.SQLITE_DB_PATH);
    } else {
      dbInstance = new PostgresDatabase(config.DATABASE_URL);
    }
  }
  return dbInstance;
}
