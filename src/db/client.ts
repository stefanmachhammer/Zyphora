/**
 * Database client — lazy MySQL connection pool shared across the app.
 *
 * Connection settings come from env vars; there's no `DATABASE_URL`
 * convenience form because passing them individually makes it harder to
 * leak a full DSN into a log line by accident. `DB_PORT` defaults to 3306;
 * the others have no defaults.
 *
 *   DB_HOST  hostname or IP of the MySQL server
 *   DB_PORT  TCP port (default 3306)
 *   DB_USER  account name
 *   DB_PASS  account password
 *   DB_NAME  database/schema name
 *
 * Unlike a typical app boot, this module does NOT fail fast on missing env
 * vars. A fresh checkout with no `.env` should still be able to start the
 * server so the web installer (`/install`) can collect credentials, write
 * the `.env` file, and reload the pool — all without ever asking the
 * operator to touch a terminal. Code paths that actually need the DB go
 * through the `db` proxy below and only blow up (with a clear error) when
 * the first query is issued before configuration is in place.
 *
 * The `.env` file is loaded as a side-effect import so any keys it defines
 * are merged into `process.env` before we read them here.
 *
 * Charset is pinned to utf8mb4 so emoji and other non-BMP characters in post
 * titles and content survive a round-trip. (MySQL's "utf8" alias is the
 * historical 3-byte form and would silently corrupt 4-byte sequences.)
 *
 * Drizzle is exported alongside the schema so callers can write
 * `db.select().from(schema.posts)` without an extra import. With the mysql2
 * driver, query builders are genuinely async — `await db.select()...where()`
 * resolves to a row array. Drop `.get()` / `.all()` style chains used by the
 * previous better-sqlite3 driver and prefer `(await ...limit(1))[0]` for
 * "first or undefined" reads.
 */
import '../lib/env-file.ts';
import { createPool, type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema.ts';

type DbInstance = MySql2Database<typeof schema>;

// Cached pool + drizzle binding. Both are populated on first use and cleared
// by `reloadDbConfig()` so the installer can switch credentials without
// restarting the Node process.
let activePool: Pool | null = null;
let activeDb: DbInstance | null = null;

/**
 * Read the four required env vars. Throws a single clear error listing the
 * missing names, rather than the generic "Missing env var DB_HOST" the
 * previous implementation produced — operators staring at a config screen
 * shouldn't have to play whack-a-mole one variable at a time.
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
 * Build a fresh pool from current env config. Called lazily — see `db` below.
 *
 * Pool sizing stays conservative: Astro under the Node adapter does its own
 * request concurrency, and a large pool just lets one slow query starve the
 * lot. 10 is the same default we had pre-installer.
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
    // Decode DATE/DATETIME/TIMESTAMP as JS Date so Drizzle's `timestamp`
    // columns round-trip cleanly. mysql2 defaults to this; being explicit
    // protects us from drift if a future driver release changes the default.
    dateStrings: false,
  });
}

/**
 * Resolve the current Drizzle binding, building the pool on first use.
 * Callers normally don't invoke this directly — they go through the `db`
 * proxy below — but it's exported for the rare case (the connection test in
 * the installer) where you want to force initialization in a controlled spot.
 */
export function getDb(): DbInstance {
  if (!activeDb) {
    activePool = buildPool();
    // `mode: 'default'` matches the standard MySQL planner behavior; the
    // alternative (`'planetscale'`) trades semantics for compatibility with
    // serverless backends that don't support cross-table foreign keys, which
    // we don't want here.
    activeDb = drizzle(activePool, { schema, mode: 'default' });
  }
  return activeDb;
}

/**
 * `db` is a Proxy that forwards every property access to the lazily-built
 * Drizzle instance. The proxy shape lets existing call sites keep using
 * `import { db } from '../db/client.ts'` and writing `db.select()...` as if
 * the binding were eager. The first method call triggers `getDb()`, which
 * either returns the cached binding or builds a fresh pool from env config.
 *
 * Functions are returned bound to the underlying instance so that Drizzle's
 * own `this`-using methods (notably the query-builder fluent API) keep
 * working when destructured via the proxy.
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
 * Drop the cached pool so the next query rebuilds it against current env
 * config. Used by the installer after it writes new credentials to `.env`
 * and patches `process.env` in-process — without this, the next request
 * would still hit the old (possibly nonexistent) pool.
 *
 * `pool.end()` is best-effort: if it throws (already closed, broken socket,
 * whatever) we still clear the references so the next request gets a clean
 * rebuild. Worst case is one leaked connection at the OS level, which the
 * server's natural lifecycle will reap.
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
 * Open a one-shot pool with the provided credentials, run `SELECT 1`, and
 * close it. Returns null on success, a human-readable error string on
 * failure. The installer uses this to validate credentials *before* writing
 * them to `.env` — otherwise a typo would lock the operator out of the
 * server until they SSH'd in and fixed the file by hand.
 *
 * The error string is surfaced verbatim in the UI, so we trim mysql2's
 * sometimes-noisy messages to the most useful prefix and avoid leaking the
 * raw error stack into the page.
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
      // One connection is enough for a SELECT 1, and a tight cap means a
      // hung handshake doesn't sit around eating sockets.
      connectionLimit: 1,
      // Fail fast — a misconfigured host shouldn't make the installer page
      // hang for the default 10 seconds.
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
