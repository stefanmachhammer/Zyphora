/**
 * Programmatic install operations — what a fresh DB needs to become a working
 * ZyphoraCMS instance, shared by the CLI scripts under `src/db/` and the web
 * installer at `/install`.
 *
 * Each function is idempotent (no-op or benign update on re-run): the installer
 * runs them without a transaction, so a refresh-and-retry must not corrupt anything.
 */
import { db, schema } from '../db/client.ts';
import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { resolve } from 'node:path';
import { setSetting } from './settings.ts';

/**
 * The four system roles. Slugs are referenced by name elsewhere (bootstrap
 * admin is `admin`, /register hands out `subscriber`) so they must exist
 * before the first user. `system: true` flags them undeletable in the UI.
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
  // Assigned on /register. Empty permissions on purpose — a profile but no
  // authoring rights until an admin promotes them.
  { slug: 'subscriber', name: 'Subscriber', permissions: [] },
];

/**
 * Apply pending SQL migrations from `./drizzle/`. Idempotent — drizzle-kit
 * tracks applied migrations in its own bookkeeping table.
 */
export async function runMigrations(): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
}

/**
 * Insert any system roles not already present. Returns the slugs actually
 * inserted (empty on a re-run) so the caller can log a precise message.
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
 * Upsert the site title and description. Overwrites existing rows — the
 * installer is the canonical place to set these first.
 */
export async function seedSiteSettings(input: {
  title: string;
  description: string;
}): Promise<void> {
  await setSetting('site_title', input.title);
  await setSetting('site_description', input.description);
}

/**
 * Seed defaults only if the keys don't exist yet, so re-running the CLI seed
 * never clobbers a customized site title.
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

export interface CreatedAdmin {
  id: string;
  email: string;
  created: boolean;
}

/**
 * Create the bootstrap admin if no row with this email exists (password hashed
 * with Argon2id — never persist plaintext). `created: false` means the account
 * already existed (e.g. a prior /install attempt); the existing id is still
 * returned, but verifying the supplied password is the caller's job.
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
