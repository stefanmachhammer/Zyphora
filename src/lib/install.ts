import { sql, inArray } from 'drizzle-orm';
import { db, schema, isDbConfigured } from '../db/client.ts';
import { writeEnvVars } from './env-file.ts';

export type InstallState = 'no-db-config' | 'no-tables' | 'no-admin' | 'installed';

// Durable marker in .env: without it a reboot with the DB briefly down reports 'no-db-config'
// and re-opens the public installer. Delete the key from .env to reset.
const INSTALL_MARKER = 'ZYPHORA_INSTALLED';

let installedCache = false;

export async function getInstallState(): Promise<InstallState> {
  if (installedCache || process.env[INSTALL_MARKER] === '1') {
    installedCache = true;
    return 'installed';
  }
  if (!isDbConfigured()) return 'no-db-config';

  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    return 'no-db-config';
  }

  // Admin = any role granting manage_users, not the 'admin' slug, which an operator may rename.
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
    // Missing table = schema not applied; any other failure also lands on 'no-tables' so the
    // operator sees the installer instead of a stack trace.
    if (isMissingTableError(err)) return 'no-tables';
    return 'no-tables';
  }

  if (adminCount === 0) return 'no-admin';

  markInstalled();
  return 'installed';
}

export function markInstalled(): void {
  if (installedCache && process.env[INSTALL_MARKER] === '1') return;
  installedCache = true;
  if (process.env[INSTALL_MARKER] === '1') return;
  process.env[INSTALL_MARKER] = '1';
  try {
    writeEnvVars({ [INSTALL_MARKER]: '1' });
  } catch {}
}

export function resetInstallStateCache(): void {
  installedCache = false;
}

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown };
  if (e.code === 'ER_NO_SUCH_TABLE') return true;
  if (typeof e.errno === 'number' && e.errno === 1146) return true;
  return false;
}
