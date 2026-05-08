import { db, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (existing) {
    await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key));
  } else {
    await db.insert(schema.settings).values({ key, value });
  }
}