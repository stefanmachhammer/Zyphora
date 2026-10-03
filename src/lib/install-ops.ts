import { db, schema } from '../db/client.ts';
import { migrate as drizzleMigrate } from 'drizzle-orm/mysql2/migrator';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import { setSetting } from './settings.ts';

// 'admin' and 'subscriber' are referenced by slug elsewhere (createAdminUser, /register).
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
      'view_analytics',
    ],
  },
  {
    slug: 'editor',
    name: 'Editor',
    // Permissions added here reach fresh installs only; existing roles need a migration (see 0001).
    permissions: ['manage_posts_any', 'manage_posts_own', 'manage_media', 'view_analytics'],
  },
  {
    slug: 'author',
    name: 'Author',
    permissions: ['manage_posts_own', 'manage_media'],
  },
  { slug: 'subscriber', name: 'Subscriber', permissions: [] },
];

export async function runMigrations(): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
}

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

export async function seedSiteSettings(input: {
  title: string;
  description: string;
}): Promise<void> {
  await setSetting('site_title', input.title);
  await setSetting('site_description', input.description);
}

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

export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  analytics_enabled: '1',
  analytics_exclude_logged_in: '1',
  analytics_retention_days: '365',
};

// The select only feeds the return value; the no-op ON DUPLICATE KEY makes the insert
// race-safe against a double-submitted installer form or a concurrent db:seed.
export async function seedDefaultSettingsIfMissing(): Promise<string[]> {
  const keys = Object.keys(DEFAULT_SETTINGS);
  const existing = await db
    .select({ key: schema.settings.key })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys));
  const present = new Set(existing.map((r) => r.key));
  const toInsert = keys.filter((k) => !present.has(k));
  if (toInsert.length === 0) return [];
  await db
    .insert(schema.settings)
    .values(toInsert.map((key) => ({ key, value: DEFAULT_SETTINGS[key] })))
    .onDuplicateKeyUpdate({ set: { key: sql`${schema.settings.key}` } });
  return toInsert;
}

export interface CreatedAdmin {
  id: string;
  email: string;
  created: boolean;
}

// If the email already exists its id is returned without checking the password; the caller must verify it.
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
