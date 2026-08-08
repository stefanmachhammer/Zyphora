/**
 * First-run seed — CLI entry point for `npm run db:seed`. Seeds system roles,
 * the bootstrap admin, and default site settings.
 *
 * Idempotent (safe to re-run). Shares its logic with the web installer via
 * `src/lib/install-ops.ts`. Admin credentials come from env
 * (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`) so production
 * deploys can avoid the well-known defaults.
 */
import {
  seedSystemRoles,
  createAdminUser,
  seedSiteSettingsIfMissing,
} from '../lib/install-ops.ts';

const insertedRoleSlugs = await seedSystemRoles();
if (insertedRoleSlugs.length > 0) {
  console.log(`Seeded ${insertedRoleSlugs.length} system role(s): ${insertedRoleSlugs.join(', ')}`);
}

const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@zyphora.local';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';
const displayName = process.env.SEED_ADMIN_NAME ?? 'Admin';

const admin = await createAdminUser({ email, password, displayName });
if (admin.created) {
  // Never echo the password — it may come from SEED_ADMIN_PASSWORD and deploy
  // logs are retained/shared (CWE-532). Naming the documented default is fine.
  console.log(`Admin user created: ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log('Password is the documented default (changeme123).');
  }
  console.log('Change the password after first login.');
} else {
  console.log(`User ${email} already exists — skipping.`);
}

const seededSettings = await seedSiteSettingsIfMissing({
  title: 'Zyphora',
  description: 'A site powered by Zyphora',
});
if (seededSettings) {
  console.log('Default settings created.');
}

// Explicit exit — the mysql2 pool keeps the event loop alive otherwise.
process.exit(0);
