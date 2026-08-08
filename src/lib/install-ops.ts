/**
 * Programmatic install operations — the pieces a fresh DB needs to become
 * a working ZyphoraCMS instance, callable both from the CLI scripts under
 * `src/db/` and from the web installer at `/install`.
 *
 * Each function is idempotent: re-running on an already-installed database
 * is a no-op (or, where applicable, a benign update). That's important
 * because the installer runs them in a single transaction-less sequence,
 * and a refresh-and-retry from the user must not corrupt anything.
 */
import { db, schema } from '../db/client.ts';
import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { resolve } from 'node:path';
import { setSetting } from './settings.ts';

/**
 * The four system roles. Their slugs are referenced by name elsewhere (the
 * bootstrap admin is `admin`, /register hands out `subscriber`, etc.) so
 * they must exist before the first user is created. `system: true` flags
 * them as undeletable in the roles admin UI.
 *
 * Kept as a module-level constant rather than re-derived inside the seeder
 * because the installer surfaces "what got seeded" back to the operator on
 * success, and a single source of truth keeps that message accurate.
 */
export const SYSTEM_ROLES: ReadonlyArray<{
  slug: string;
  name: string;
  permissions: ReadonlyArray<string>;
}> = [
  {
    slug: 'admin',
    name: 'Admin',
    permissions: [
      'manage_users',
      'manage_roles',
      'manage_posts_any',
      'manage_posts_own',
      'manage_media',
      'manage_themes',
      'manage_settings',
    ],
  },
  {
    slug: 'editor',
    name: 'Editor',
    permissions: ['manage_posts_any', 'manage_posts_own', 'manage_media'],
  },
  {
    slug: 'author',
    name: 'Author',
    permissions: ['manage_posts_own', 'manage_media'],
  },
  // Subscriber is the role assigned to anyone signing up via /register.
  // Empty permission set on purpose — they get a profile but no authoring
  // rights until an admin promotes them.
  { slug: 'subscriber', name: 'Subscriber', permissions: [] },
];

/**
 * Apply any pending SQL migrations from `./drizzle/`. Wraps
 * `drizzle-orm/mysql2/migrator` so call sites don't have to remember the
 * folder path. Idempotent — drizzle-kit tracks applied migrations in its
 * own bookkeeping table.
 */
export async function runMigrations(): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
}

/**
 * Insert any of the system roles that aren't already present. Returns the
 * slugs that were actually inserted (empty on a re-run) so the caller can
 * log a precise message.
 */
export async function seedSystemRoles(): Promise<string[]> {
  const existing = await db
    .select({ slug: schema.roles.slug })
    .from(schema.roles)
    .where(inArray(schema.roles.slug, SYSTEM_ROLES.map((r) => r.slug)));
  const present = new Set(existing.map((r) => r.slug));
  const toInsert = SYSTEM_ROLES.filter((r) => !present.has(r.slug));
  if (toInsert.length === 0) return [];
  await db.insert(schema.roles).values(
    toInsert.map((r) => ({
      slug: r.slug,
      name: r.name,
      permissions: r.permissions as string[],
      system: true,
    })),
  );
  return toInsert.map((r) => r.slug);
}

/**
 * Upsert the site title and description. Called by the installer with the
 * operator-supplied values; overwrites any existing rows on purpose because
 * the installer is the canonical place to set these for the first time.
 */
export async function seedSiteSettings(input: {
  title: string;
  description: string;
}): Promise<void> {
  await setSetting('site_title', input.title);
  await setSetting('site_description', input.description);
}

/**
 * Seed defaults only if the keys don't exist yet. Used by the CLI seed so
 * re-running it never clobbers a customized site title.
 */
export async function seedSiteSettingsIfMissing(input: {
  title: string;
  description: string;
}): Promise<boolean> {
  const existing = await db
    .select({ key: schema.settings.key })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'site_title'))
    .limit(1);
  if (existing.length > 0) return false;
  await db.insert(schema.settings).values([
    { key: 'site_title', value: input.title },
    { key: 'site_description', value: input.description },
  ]);
  return true;
}

/**
 * Result of `createAdminUser`. Returns the newly-created user id so the
 * web installer can immediately mint a session and log the operator in
 * without a second round-trip to the DB.
 */
export interface CreatedAdmin {
  id: string;
  email: string;
  created: boolean;
}

/**
 * Create the bootstrap admin user if no row with this email exists. Hashes
 * the password with Argon2id — never persist a plaintext password from
 * here or any caller.
 *
 * The `created` flag in the return value lets the installer distinguish
 * "I made the account" from "an account with this email already existed
 * (maybe from a previous /install attempt)". In the second case we still
 * return the existing user's id so the caller can log them in if they
 * supplied the right password — but verifying that is the caller's job.
 */
export async function createAdminUser(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<CreatedAdmin> {
  const email = input.email.trim().toLowerCase();
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing[0]) {
    return { id: existing[0].id, email, created: false };
  }
  const id = randomUUID();
  const passwordHash = await hash(input.password);
  await db.insert(schema.users).values({
    id,
    email,
    passwordHash,
    displayName: input.displayName,
    role: 'admin',
  });
  return { id, email, created: true };
}
