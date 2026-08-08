/**
 * Key-value wrapper around the `settings` table. Values are always strings;
 * callers serialize/parse structured values themselves, so new settings need
 * no schema change.
 */
import { db, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';

/** Read a setting. Returns `fallback` when the row is missing. */
export async function getSetting(key: string, fallback = ''): Promise<string> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return rows[0]?.value ?? fallback;
}

/** Upsert a setting. One atomic statement via MySQL's `ON DUPLICATE KEY UPDATE`. */
export async function setSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}