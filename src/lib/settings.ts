/**
 * Tiny key-value wrapper around the `settings` table.
 *
 * Always go through these helpers — `setSetting` does the upsert dance so
 * callers don't have to think about whether the row exists yet.
 *
 * Values are always stored as strings. Callers serialize/parse on each side
 * (e.g. JSON.stringify a structured value before saving). Keeping the table
 * untyped keeps it easy to add new settings without schema changes.
 */
import { db, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';

/** Read a setting. Returns `fallback` when the row is missing. */
export async function getSetting(key: string, fallback = ''): Promise<string> {
  // mysql2 returns an array; take the first row (or undefined). Limiting to
  // one keeps the planner honest even though `key` is the primary key.
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