/**
 * Install-state detection — the single source of truth for "is this CMS
 * ready to serve traffic, or does it need to walk a fresh operator through
 * the web installer?"
 *
 * Returned states, from least-installed to most-installed:
 *
 *   'no-db-config'  — Required DB_* env vars are missing or the DB
 *                     they point at is unreachable / wrong credentials.
 *                     Installer step: collect DB credentials.
 *   'no-tables'     — DB reachable but the schema hasn't been applied yet
 *                     (the `users` table doesn't exist). Installer should
 *                     auto-run migrations and proceed to the next step.
 *   'no-admin'      — Schema is in place but no admin user exists yet.
 *                     Installer step: collect site title + admin account.
 *   'installed'     — Everything's set up; the installer should 404 to
 *                     prevent a stray visitor from re-running it.
 *
 * Caching: once we observe `'installed'`, we cache that forever (per
 * process). The other states are *not* cached — they represent partially-
 * set-up systems where the operator might be actively progressing through
 * the wizard, and each request should observe the latest reality. The
 * 'installed' fast path makes the gate in middleware effectively free for
 * the steady-state.
 */
import { sql } from 'drizzle-orm';
import { db, schema, isDbConfigured } from '../db/client.ts';
import { eq } from 'drizzle-orm';

export type InstallState = 'no-db-config' | 'no-tables' | 'no-admin' | 'installed';

// Sticky once true. The installer flips it explicitly via `markInstalled()`
// the moment it creates the bootstrap admin, so the next request through
// middleware can short-circuit without re-querying the DB.
let installedCache = false;

/**
 * Resolve the current install state with at most two short queries — and
 * zero queries once the process has seen 'installed' even once.
 */
export async function getInstallState(): Promise<InstallState> {
  if (installedCache) return 'installed';
  if (!isDbConfigured()) return 'no-db-config';

  // Step 1: can we talk to MySQL at all?
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    // Connection refused, access denied, unknown database — treat them all
    // as "config is wrong, send the user back to step 1." We deliberately
    // don't try to discriminate the specific failure here: the installer's
    // own connection-test surface (`testConnection`) gives the operator a
    // precise error message when they re-submit the form.
    return 'no-db-config';
  }

  // Step 2: has the schema been applied? The `users` table is the
  // earliest-needed object — without it nothing else works.
  let adminCount: number;
  try {
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.role, 'admin'))
      .limit(1);
    adminCount = rows.length;
  } catch (err) {
    // The mysql2 error for a missing table is ER_NO_SUCH_TABLE (code 1146).
    // Any other failure here is unexpected and we still want the operator
    // to see the installer rather than a stack trace, so we fall through to
    // the same "no-tables" branch and let the migration step re-test.
    if (isMissingTableError(err)) return 'no-tables';
    return 'no-tables';
  }

  if (adminCount === 0) return 'no-admin';

  installedCache = true;
  return 'installed';
}

/**
 * Flip the install-complete latch. Called by the installer the instant the
 * admin user is created so subsequent requests skip the DB probe entirely.
 */
export function markInstalled(): void {
  installedCache = true;
}

/**
 * Drop the cached "installed" verdict. Used by the installer when it
 * reloads the DB pool after writing new credentials — the cached verdict
 * (if any) was about a different database and might be stale.
 */
export function resetInstallStateCache(): void {
  installedCache = false;
}

/**
 * Recognize MySQL's "table doesn't exist" error across the small variations
 * mysql2 emits (numeric `errno` 1146, string `code` 'ER_NO_SUCH_TABLE').
 * Pulled into its own helper so the recognition rule lives in one place if
 * future drivers report it differently.
 */
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown };
  if (e.code === 'ER_NO_SUCH_TABLE') return true;
  if (typeof e.errno === 'number' && e.errno === 1146) return true;
  return false;
}
