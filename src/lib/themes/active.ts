/**
 * Active-theme selector. The active slug is a single `settings` row
 * (`active_theme`), which keeps "exactly one active theme" trivially enforced.
 */

import { getSetting, setSetting } from '../settings.ts';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import { DEFAULT_THEME_SLUG } from './registry.ts';

const ACTIVE_THEME_KEY = 'active_theme';

/** Active theme slug, defaulting to `default` on a fresh install. */
export async function getActiveThemeSlug(): Promise<string> {
  const value = await getSetting(ACTIVE_THEME_KEY, DEFAULT_THEME_SLUG);
  return value || DEFAULT_THEME_SLUG;
}

/** Activate a theme by slug. Rejects slugs with no installed DB row. */
export async function setActiveTheme(slug: string): Promise<void> {
  const rows = await db.select().from(schema.themes).where(eq(schema.themes.slug, slug)).limit(1);
  if (rows.length === 0) throw new Error(`Theme not installed: ${slug}`);
  await setSetting(ACTIVE_THEME_KEY, slug);
}