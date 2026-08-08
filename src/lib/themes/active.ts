/**
 * Active-theme selector.
 *
 * The active theme slug is stored as a single row in the `settings` table
 * (key `active_theme`) rather than as a column on the `themes` table. This
 * keeps the invariant "exactly one active theme" trivially enforced and
 * matches how every other site-wide preference is stored.
 */

import { getSetting, setSetting } from '../settings.ts';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import { DEFAULT_THEME_SLUG } from './registry.ts';

const ACTIVE_THEME_KEY = 'active_theme';

/**
 * Return the configured active theme slug, defaulting to `default` if the
 * setting hasn't been written yet (fresh install).
 */
export async function getActiveThemeSlug(): Promise<string> {
  const value = await getSetting(ACTIVE_THEME_KEY, DEFAULT_THEME_SLUG);
  return value || DEFAULT_THEME_SLUG;
}

/**
 * Activate a theme by slug. Verifies the theme is actually installed (DB row
 * present) so we never end up in a state where the active theme can't render.
 */
export async function setActiveTheme(slug: string): Promise<void> {
  const rows = await db.select().from(schema.themes).where(eq(schema.themes.slug, slug)).limit(1);
  if (rows.length === 0) throw new Error(`Theme not installed: ${slug}`);
  await setSetting(ACTIVE_THEME_KEY, slug);
}