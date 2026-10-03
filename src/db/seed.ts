import {
  seedSystemRoles,
  createAdminUser,
  seedSiteSettingsIfMissing,
  seedDefaultSettingsIfMissing,
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
  // Never log the password: it may come from SEED_ADMIN_PASSWORD and deploy logs are retained.
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

const seededDefaults = await seedDefaultSettingsIfMissing();
if (seededDefaults.length > 0) {
  console.log(`Seeded default setting(s): ${seededDefaults.join(', ')}`);
}

// The mysql2 pool keeps the event loop alive otherwise.
process.exit(0);
