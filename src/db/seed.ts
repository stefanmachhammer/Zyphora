/**
 * First-run seed script.
 *
 * Idempotent — re-running on an already-seeded DB only logs and exits.
 * Reads admin credentials from env (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`,
 * `SEED_ADMIN_NAME`) so production deploys can avoid the well-known defaults.
 */
import { db, schema } from './client.ts';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

// Resolve seed credentials. Defaults are fine for local dev but should be
// overridden via env in any non-throwaway deployment.
const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@zyphora.local';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';
const displayName = process.env.SEED_ADMIN_NAME ?? 'Admin';

// Create the bootstrap admin only if no user with this email exists yet.
// Re-running the script on an already-seeded DB is a no-op.
const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
if (existing) {
  console.log(`User ${email} already exists — skipping.`);
} else {
  const passwordHash = await hash(password);
  await db.insert(schema.users).values({
    id: randomUUID(),
    email,
    passwordHash,
    displayName,
    role: 'admin',
  });
  console.log(`Admin user created: ${email}`);
  console.log('Change the password after first login.');
}

// Insert default site settings on first run. Presence of `site_title` is the
// sentinel for whether settings have been seeded.
const siteTitle = await db.select().from(schema.settings).where(eq(schema.settings.key, 'site_title')).get();
if (!siteTitle) {
  await db.insert(schema.settings).values([
    { key: 'site_title', value: 'Zyphora' },
    { key: 'site_description', value: 'A site powered by Zyphora' },
  ]);
  console.log('Default settings created.');
}

// Explicit exit — better-sqlite3 keeps the process alive otherwise.
process.exit(0);