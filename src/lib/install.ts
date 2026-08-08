/**
 * Install-state detection — the source of truth for "is this CMS ready to
 * serve, or does it need the web installer?"
 *
 * States, least- to most-installed:
 *   'no-db-config'  — DB_* env vars missing, or the DB is unreachable / wrong
 *                     credentials. Installer collects DB credentials.
 *   'no-tables'     — DB reachable but schema not applied (no `users` table).
 *                     Installer auto-runs migrations.
 *   'no-admin'      — Schema present but no admin user. Installer collects
 *                     site title + admin account.
 *   'installed'     — Set up; installer 404s so nobody can re-run it.
 *
 * Only 'installed' is cached (per process) — the partial states represent an
 * operator mid-wizard, so each request re-checks. The fast path makes the
 * middleware gate effectively free in steady state.
 */
import { sql, inArray } from 'drizzle-orm';
import { db, schema, isDbConfigured } from '../db/client.ts';
import { writeEnvVars } from './env-file.ts';

export type InstallState = 'no-db-config' | 'no-tables' | 'no-admin' | 'installed';

// Durable "installed" marker written to `.env`. Security-critical: without it,
// a reboot while the DB is briefly unreachable would report `no-db-config` and
// re-open the public installer — letting a passer-by repoint the CMS at their
// own database or mint a fresh admin. Once set, the gate treats the CMS as
// installed regardless of DB reachability. Wiping `.env` is the reset escape hatch.
const INSTALL_MARKER = 'ZYPHORA_INSTALLED';

// In-process latch (lost on restart; backed by the durable marker above).
let installedCache = false;

/**
 * Resolve the current install state — at most two short queries, and zero once
 * the process has seen 'installed'.
 */
export async function getInstallState(): Promise<InstallState> {
  if (installedCache || process.env[INSTALL_MARKER] === '1') {
    installedCache = true;
    return 'installed';
  }
  if (!isDbConfigured()) return 'no-db-config';

  // Can we talk to MySQL at all? Any failure → back to step 1; the installer's
  // own `testConnection` gives a precise error when the operator re-submits.
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    return 'no-db-config';
  }

  // "Administrator" is defined by capability (any role granting `manage_users`),
  // not the literal `admin` slug — else renaming the admin role would report
  // "no admin" and re-open the public installer. `users` is the earliest schema
  // object, so a missing-table error here doubles as "schema not applied".
  let adminCount: number;
  try {
    const adminRoles = await db
      .select({ slug: schema.roles.slug, permissions: schema.roles.permissions })
      .from(schema.roles);
    const adminRoleSlugs = adminRoles
      .filter((r) => Array.isArray(r.permissions) && r.permissions.includes('manage_users'))
      .map((r) => r.slug);

    if (adminRoleSlugs.length === 0) {
      adminCount = 0;
    } else {
      const rows = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.role, adminRoleSlugs))
        .limit(1);
      adminCount = rows.length;
    }
  } catch (err) {
    // Missing table (ER_NO_SUCH_TABLE / 1146) → schema not applied. Any other
    // failure also falls through to 'no-tables' so the operator sees the
    // installer, not a stack trace, and the migration step re-tests.
    if (isMissingTableError(err)) return 'no-tables';
    return 'no-tables';
  }

  if (adminCount === 0) return 'no-admin';

  markInstalled();
  return 'installed';
}

/**
 * Flip the install-complete latch and persist the durable marker, so later
 * requests — and restarts — skip the DB probe and can't re-open the wizard.
 * Persisting is best-effort: a read-only `.env` keeps only the in-process latch
 * (falls back to the DB probe after a restart), so a hardened deploy still installs.
 */
export function markInstalled(): void {
  if (installedCache && process.env[INSTALL_MARKER] === '1') return;
  installedCache = true;
  if (process.env[INSTALL_MARKER] === '1') return;
  process.env[INSTALL_MARKER] = '1';
  try {
    writeEnvVars({ [INSTALL_MARKER]: '1' });
  } catch {
    // .env not writable — keep the in-memory latch (see above).
  }
}

/**
 * Drop the cached "installed" verdict. Used by the installer after it reloads
 * the DB pool against new credentials — the old verdict was about a different DB.
 */
export function resetInstallStateCache(): void {
  installedCache = false;
}

/** Recognize MySQL's "table doesn't exist" error (code ER_NO_SUCH_TABLE / errno 1146). */
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown };
  if (e.code === 'ER_NO_SUCH_TABLE') return true;
  if (typeof e.errno === 'number' && e.errno === 1146) return true;
  return false;
}
