/**
 * First-run seed script — CLI entry point for `npm run db:seed`.
 *
 * Delegates to the helpers in `src/lib/install-ops.ts` so the web installer
 * at `/install` can run the same logic without spawning a child process.
 * Idempotent — re-running on an already-seeded DB is safe.
 *
 * Three things get seeded on a fresh DB:
 *   1. The four system roles (admin/editor/author/subscriber).
 *   2. The bootstrap admin user (credentials below).
 *   3. Default site title + description (only when missing — a customized
 *      title set via the admin UI is preserved across re-runs).
 *
 * Reads admin credentials from env (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`,
 * `SEED_ADMIN_NAME`) so production deploys can avoid the well-known defaults.
 * Operators who'd rather run the web installer can ignore this script entirely
 * — it exists for headless/scripted deploys.
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
  console.log(`Admin user created: ${email} / ${password}`);
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

// Explicit exit — the mysql2 pool keeps the event loop alive otherwise
// (idle connections waiting to be reused).
process.exit(0);
