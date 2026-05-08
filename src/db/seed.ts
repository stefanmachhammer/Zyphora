import { db, schema } from './client.ts';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@zyphora.local';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';
const displayName = process.env.SEED_ADMIN_NAME ?? 'Admin';

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
  console.log(`Admin user created: ${email} / ${password}`);
  console.log('Change the password after first login.');
}

const siteTitle = await db.select().from(schema.settings).where(eq(schema.settings.key, 'site_title')).get();
if (!siteTitle) {
  await db.insert(schema.settings).values([
    { key: 'site_title', value: 'ZyphoraCMS' },
    { key: 'site_description', value: 'A site powered by ZyphoraCMS' },
  ]);
  console.log('Default settings created.');
}

process.exit(0);