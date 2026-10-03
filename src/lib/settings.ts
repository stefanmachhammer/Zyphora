import { db, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}