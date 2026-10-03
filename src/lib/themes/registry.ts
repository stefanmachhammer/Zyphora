import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import type { ThemeManifest, ThemeRecord } from './types.ts';
import { getActiveThemeSlug } from './active.ts';

// Outside `src/` so Vite/Astro doesn't bundle it — themes are read at runtime.
export const THEMES_DIR = join(process.cwd(), 'themes');

export const DEFAULT_THEME_SLUG = 'default';

// Slug lands in URLs and on disk; the narrow alphabet rules out path traversal.
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

export function readManifest(slug: string): ThemeManifest | null {
  const dir = join(THEMES_DIR, slug);
  const manifestPath = join(dir, 'theme.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) return null;
    return { ...parsed.data, slug };
  } catch {
    return null;
  }
}

export function scanThemes(): ThemeManifest[] {
  if (!existsSync(THEMES_DIR)) return [];
  const entries = readdirSync(THEMES_DIR);
  const manifests: ThemeManifest[] = [];
  for (const entry of entries) {
    // Dot-prefixed dirs are the installer's `.staging-`/`.backup-` dirs mid-update.
    if (entry.startsWith('.')) continue;
    const full = join(THEMES_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    const m = readManifest(entry);
    if (m) manifests.push(m);
  }
  return manifests;
}

export async function syncThemes(): Promise<void> {
  const onDisk = scanThemes();
  const onDiskSlugs = new Set(onDisk.map((m) => m.slug));

  for (const m of onDisk) {
    const existingRows = await db.select().from(schema.themes).where(eq(schema.themes.slug, m.slug)).limit(1);
    const existing = existingRows[0];
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

  const dbRows = await db.select().from(schema.themes);
  for (const row of dbRows) {
    if (!onDiskSlugs.has(row.slug)) {
      await db.delete(schema.themes).where(eq(schema.themes.slug, row.slug));
    }
  }
}

export async function listThemes(): Promise<ThemeRecord[]> {
  await syncThemes();
  const rows = await db.select().from(schema.themes);
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

export async function resolveActiveTheme(): Promise<ThemeRecord | null> {
  const all = await listThemes();
  const explicit = all.find((t) => t.active);
  if (explicit) return explicit;
  return all.find((t) => t.slug === DEFAULT_THEME_SLUG) ?? null;
}