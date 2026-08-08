/**
 * Database client — lazy MySQL connection pool shared across the app.
 *
 * Settings come from DB_HOST / DB_PORT (default 3306) / DB_USER / DB_PASS /
 * DB_NAME; no `DATABASE_URL` form, to avoid leaking a full DSN into logs.
 *
 * This module does NOT fail fast on missing env vars: a fresh checkout with no
 * `.env` must still boot so the web installer (`/install`) can collect
 * credentials, write `.env`, and reload the pool. The `db` proxy below throws
 * a clear error only when the first query runs before config is in place.
 *
 * `.env` is loaded as a side-effect import so its keys are in `process.env`
 * before we read them. Charset is pinned to utf8mb4 so 4-byte characters
 * (emoji) round-trip — MySQL's "utf8" alias is the 3-byte form and corrupts them.
 *
 * mysql2 query builders are async: `await db.select()...where()` resolves to a
 * row array. Use `(await ...limit(1))[0]` for "first or undefined" reads.
 */
import '../lib/env-file.ts';
import { createPool, type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema.ts';

type DbInstance = MySql2Database<typeof schema>;

// Populated on first use, cleared by `reloadDbConfig()` so the installer can
// switch credentials without restarting the Node process.
let activePool: Pool | null = null;
let activeDb: DbInstance | null = null;

/**
 * Read the four required env vars, throwing a single error that lists all
 * missing names at once (not one at a time).
 */
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

/**
 * Build a fresh pool from current env config (called lazily — see `db` below).
 * connectionLimit stays conservative: a large pool just lets one slow query
 * starve the lot under the Node adapter's own request concurrency.
 */
function buildPool(): Pool {
  const cfg = readDbConfig();
  return createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    connectionLimit: 10,
    // Decode DATE/DATETIME/TIMESTAMP as JS Date for Drizzle's `timestamp`
    // columns. Explicit to guard against a future driver default change.
    dateStrings: false,
  });
}

/**
 * Resolve the current Drizzle binding, building the pool on first use. Callers
 * normally go through the `db` proxy; exported so the installer's connection
 * test can force initialization in a controlled spot.
 */
export function getDb(): DbInstance {
  if (!activeDb) {
    activePool = buildPool();
    // `mode: 'default'` for standard MySQL; `'planetscale'` is only for
    // serverless backends without cross-table foreign keys.
    activeDb = drizzle(activePool, { schema, mode: 'default' });
  }
  return activeDb;
}

/**
 * Proxy that forwards every access to the lazily-built Drizzle instance, so
 * call sites can `import { db }` and write `db.select()...` as if it were eager;
 * the first method call triggers `getDb()`. Functions are bound to the instance
 * so Drizzle's `this`-using fluent API survives destructuring via the proxy.
 */
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

/** True iff all four required DB_* env vars are present and non-empty. */
export function isDbConfigured(): boolean {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME);
}

/**
 * Drop the cached pool so the next query rebuilds against current env config.
 * Used by the installer after it writes new credentials. `pool.end()` is
 * best-effort — references are cleared regardless so the rebuild is clean;
 * worst case is one leaked connection the process lifecycle reaps.
 */
export async function reloadDbConfig(): Promise<void> {
  const pool = activePool;
  activePool = null;
  activeDb = null;
  if (pool) {
    try {
      await pool.end();
    } catch {
      // ignored — see comment above
    }
  }
}

/**
 * Open a one-shot pool, run `SELECT 1`, close it. Returns null on success or a
 * human-readable error string on failure. The installer uses this to validate
 * credentials *before* writing them to `.env`, so a typo can't lock the
 * operator out. The message is surfaced verbatim in the UI.
 */
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
      // Fail fast so a misconfigured host doesn't hang the installer page
      // for the default 10 seconds.
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
      } catch {
        // ignored
      }
    }
  }
}

export { schema };
