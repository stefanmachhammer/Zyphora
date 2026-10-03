// Must NOT fail fast on missing env vars: a fresh checkout has no `.env` and
// must still boot so the web installer can write one and `reloadDbConfig()`.
import '../lib/env-file.ts';
import { createPool, type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema.ts';

type DbInstance = MySql2Database<typeof schema>;

let activePool: Pool | null = null;
let activeDb: DbInstance | null = null;

function readDbConfig() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const database = process.env.DB_NAME;
  const port = Number(process.env.DB_PORT ?? 3306);

  const missing: string[] = [];
  if (!host) missing.push('DB_HOST');
  if (!user) missing.push('DB_USER');
  if (!password) missing.push('DB_PASS');
  if (!database) missing.push('DB_NAME');
  if (missing.length > 0) {
    throw new Error(
      `Database is not configured. Missing env var(s): ${missing.join(', ')}. ` +
        `Visit /install in the browser or set them in your environment.`,
    );
  }
  return { host: host!, port, user: user!, password: password!, database: database! };
}

function buildPool(): Pool {
  const cfg = readDbConfig();
  return createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    // MySQL's "utf8" is the 3-byte form and corrupts emoji; utf8mb4 is required.
    charset: 'utf8mb4',
    connectionLimit: 10,
    dateStrings: false,
  });
}

export function getDb(): DbInstance {
  if (!activeDb) {
    activePool = buildPool();
    activeDb = drizzle(activePool, { schema, mode: 'default' });
  }
  return activeDb;
}

// Methods are bound to the instance: Drizzle's fluent API relies on `this`,
// which the Proxy would otherwise lose.
export const db = new Proxy({} as DbInstance, {
  get(_target, prop) {
    const instance = getDb();
    const value = (instance as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
}) as DbInstance;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME);
}

export async function reloadDbConfig(): Promise<void> {
  const pool = activePool;
  activePool = null;
  activeDb = null;
  if (pool) {
    try {
      await pool.end();
    } catch {}
  }
}

export async function testConnection(cfg: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Promise<string | null> {
  let pool: Pool | null = null;
  try {
    pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      charset: 'utf8mb4',
      connectionLimit: 1,
      connectTimeout: 5000,
    });
    await pool.query('SELECT 1');
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {}
    }
  }
}

export { schema };
