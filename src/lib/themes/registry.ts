/**
 * Theme registry — discovers themes on disk and keeps the DB row index in sync.
 *
 * Themes are filesystem-first: the source of truth for what's installed is the
 * presence of a directory under `themes/<slug>/` containing a valid
 * `theme.json`. The DB row exists so we can query by slug efficiently and so
 * the admin UI can show install metadata; it's reconciled on startup and
 * after any install/uninstall.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import type { ThemeManifest, ThemeRecord } from './types.ts';
import { getActiveThemeSlug } from './active.ts';

/**
 * Root directory for all themes. Lives outside `src/` so it isn't bundled by
 * Vite/Astro — themes are read at runtime, not at build time.
 */
export const THEMES_DIR = join(process.cwd(), 'themes');

/** The slug used when no theme is set or the configured one is missing. */
export const DEFAULT_THEME_SLUG = 'default';

/**
 * Manifest schema — strict validation here gives uploaders a clean error
 * message instead of a render-time crash later.
 *
 * Slug is restricted to lowercase alphanumeric + dashes because it ends up in
 * URLs (asset routes) and on disk (directory name); narrowing the alphabet
 * sidesteps both URL-encoding surprises and path-traversal worries.
 */
const manifestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  author: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  templates: z
    .object({
      index: z.string().optional(),
      post: z.string().optional(),
      notFound: z.string().optional(),
    })
    .optional(),
});

/**
 * Read and validate `theme.json` for a single slug. Returns null if the dir
 * is missing or the manifest is invalid; callers can decide whether to warn.
 */
export function readManifest(slug: string): ThemeManifest | null {
  const dir = join(THEMES_DIR, slug);
  const manifestPath = join(dir, 'theme.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) return null;
    // The folder name wins over whatever the manifest claims — protects us
    // against a manifest whose `slug` doesn't match the directory it lives in.
    return { ...parsed.data, slug };
  } catch {
    return null;
  }
}

/**
 * Scan the themes directory and return one record per valid theme.
 * Skips entries that aren't directories or lack a usable manifest.
 *
 * Dot-prefixed directories (`.staging-…`, `.backup-…`) are skipped — the
 * theme installer uses those names while swapping an update into place, and
 * a scan that lands mid-update would otherwise register a phantom theme row
 * for the staging dir.
 */
export function scanThemes(): ThemeManifest[] {
  if (!existsSync(THEMES_DIR)) return [];
  const entries = readdirSync(THEMES_DIR);
  const manifests: ThemeManifest[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(THEMES_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    const m = readManifest(entry);
    if (m) manifests.push(m);
  }
  return manifests;
}

/**
 * Reconcile the `themes` table with what's on disk.
 * - Insert rows for newly-discovered themes
 * - Update version/name/etc for themes whose manifest changed
 * - Remove rows whose directory has been deleted
 *
 * `bundled` marks themes that ship with the codebase (currently just `default`)
 * so the UI can prevent the user from deleting them.
 */
export async function syncThemes(): Promise<void> {
  const onDisk = scanThemes();
  const onDiskSlugs = new Set(onDisk.map((m) => m.slug));

  for (const m of onDisk) {
    const existing = await db.select().from(schema.themes).where(eq(schema.themes.slug, m.slug)).get();
    const bundled = m.slug === DEFAULT_THEME_SLUG;
    if (existing) {
      await db
        .update(schema.themes)
        .set({
          name: m.name,
          version: m.version,
          author: m.author ?? null,
          description: m.description ?? null,
          bundled,
        })
        .where(eq(schema.themes.slug, m.slug));
    } else {
      await db.insert(schema.themes).values({
        slug: m.slug,
        name: m.name,
        version: m.version,
        author: m.author ?? null,
        description: m.description ?? null,
        bundled,
      });
    }
  }

  const dbRows = await db.select().from(schema.themes).all();
  for (const row of dbRows) {
    if (!onDiskSlugs.has(row.slug)) {
      await db.delete(schema.themes).where(eq(schema.themes.slug, row.slug));
    }
  }
}

/**
 * Return all installed themes for the admin UI — DB rows joined with the
 * active-theme flag and the absolute on-disk path.
 */
export async function listThemes(): Promise<ThemeRecord[]> {
  await syncThemes();
  const rows = await db.select().from(schema.themes).all();
  const activeSlug = await getActiveThemeSlug();
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    version: row.version,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    bundled: row.bundled,
    installedAt: row.installedAt,
    active: row.slug === activeSlug,
    dir: join(THEMES_DIR, row.slug),
  }));
}

/**
 * Resolve the currently-active theme, falling back to `default` if the
 * configured one is missing on disk. Returns null only if even `default`
 * is gone (which would mean a broken install).
 */
export async function resolveActiveTheme(): Promise<ThemeRecord | null> {
  const all = await listThemes();
  const explicit = all.find((t) => t.active);
  if (explicit) return explicit;
  return all.find((t) => t.slug === DEFAULT_THEME_SLUG) ?? null;
}