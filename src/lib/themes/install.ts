/**
 * Theme installer — accepts a zip upload, validates it, and lays it out
 * under `themes/<slug>/`.
 *
 * Threat model:
 *   - The upload endpoint is admin-only (middleware enforces this).
 *   - Theme templates execute server-side as Eta — installing a theme is
 *     equivalent to giving it code execution. We surface this in the UI.
 *   - The installer guards against zip-slip (entries whose path resolves
 *     outside the destination dir) and oversized payloads.
 */

import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve, sep, dirname } from 'node:path';
import { z } from 'zod';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import { THEMES_DIR, DEFAULT_THEME_SLUG, syncThemes } from './registry.ts';
import { clearRenderCache } from './render.ts';
import { lintTemplatesDir, formatLintIssues } from './lint.ts';
import { getActiveThemeSlug, setActiveTheme } from './active.ts';

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

const installManifestSchema = z.object({
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
 * Strip a single optional top-level wrapper directory (e.g. `my-theme/...`)
 * from zip entry names. People zip themes both ways — with and without a
 * containing folder — and forcing one convention is a bad UX.
 *
 * If every entry shares the same first segment, drop it. Otherwise leave
 * names alone.
 */
function detectPrefix(entryNames: string[]): string {
  if (entryNames.length === 0) return '';
  const first = entryNames[0]!.split('/')[0];
  if (!first) return '';
  for (const name of entryNames) {
    const head = name.split('/')[0];
    if (head !== first) return '';
  }
  return `${first}/`;
}

/** Reject paths that try to escape the destination dir (zip-slip / CVE-2018-1002200). */
function isSafeRelative(rel: string): boolean {
  const normalized = normalize(rel);
  if (normalized.startsWith('..' + sep) || normalized === '..') return false;
  if (normalized.startsWith(sep)) return false;
  return true;
}

export type InstallResult = { slug: string; name: string; version: string };

/**
 * Install a theme from an uploaded zip buffer.
 *
 * Steps:
 *  1. Size check on the compressed payload.
 *  2. Locate `theme.json`, validate it, derive the destination slug.
 *  3. Refuse to overwrite existing themes (admins must delete first — keeps
 *     accidental overwrites and version downgrades from being silent).
 *  4. Sum uncompressed sizes (zip-bomb guard) before writing anything.
 *  5. Extract entries one at a time, validating each path is safely scoped.
 *  6. Sync the DB so the new theme shows up in the registry immediately.
 */
export async function installFromZip(buffer: Buffer): Promise<InstallResult> {
  if (buffer.length === 0) throw new Error('Empty upload');
  if (buffer.length > MAX_ZIP_BYTES) throw new Error(`Theme zip exceeds ${MAX_ZIP_BYTES} bytes`);

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error('Invalid zip file');
  }

  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error('Zip is empty');

  const prefix = detectPrefix(entries.map((e) => e.entryName));
  const stripped = entries.map((e) => ({
    raw: e,
    rel: prefix && e.entryName.startsWith(prefix) ? e.entryName.slice(prefix.length) : e.entryName,
  }));

  const manifestEntry = stripped.find((e) => e.rel === 'theme.json');
  if (!manifestEntry) throw new Error('Zip is missing theme.json at the top level');

  let manifest: z.infer<typeof installManifestSchema>;
  try {
    const parsed = JSON.parse(manifestEntry.raw.getData().toString('utf8'));
    manifest = installManifestSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid theme.json: ${err instanceof Error ? err.message : 'parse error'}`);
  }

  const slug = manifest.slug;
  const dest = join(THEMES_DIR, slug);
  if (existsSync(dest)) throw new Error(`A theme with slug "${slug}" is already installed; delete it first`);

  // Sum uncompressed sizes before writing — stops zip bombs from filling disk.
  let total = 0;
  for (const e of stripped) {
    if (e.raw.isDirectory) continue;
    total += e.raw.header.size;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Theme uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`);
    }
  }

  if (!existsSync(THEMES_DIR)) mkdirSync(THEMES_DIR, { recursive: true });
  mkdirSync(dest, { recursive: true });

  try {
    for (const e of stripped) {
      if (e.raw.isDirectory || e.rel === '') continue;
      if (!isSafeRelative(e.rel)) throw new Error(`Unsafe path in zip: ${e.rel}`);
      const outPath = join(dest, e.rel);
      // Defense-in-depth: even after isSafeRelative, verify the resolved path
      // is inside `dest`. Catches symlink/encoding tricks AdmZip might miss.
      const resolvedOut = resolve(outPath);
      if (!resolvedOut.startsWith(resolve(dest) + sep) && resolvedOut !== resolve(dest)) {
        throw new Error(`Unsafe path in zip: ${e.rel}`);
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, e.raw.getData());
    }

    // Lint every `.eta` file the zip dropped under `templates/`. A theme with
    // any of the failure modes catalogued in `lint.ts` (issue #5) would
    // otherwise install cleanly and explode at first render — the user would
    // see a SyntaxError pointing at compiled JS, with no obvious connection
    // back to the upload. Catching it here keeps the failure local to the
    // upload action and rolls back automatically via the catch below.
    const lintIssues = lintTemplatesDir(join(dest, 'templates'));
    if (lintIssues.length > 0) {
      throw new Error(`Theme templates have errors:\n\n${formatLintIssues(lintIssues)}`);
    }
  } catch (err) {
    // Roll back partial extraction on any error so the dir doesn't end up
    // half-populated and confuse the registry on next scan.
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }

  await syncThemes();
  clearRenderCache();
  return { slug, name: manifest.name, version: manifest.version };
}

/**
 * Uninstall a theme.
 *
 * Refuses to delete:
 *   - bundled themes (currently `default`) — they are part of the codebase
 *   - the currently active theme — switch first to avoid a blank site
 */
export async function uninstallTheme(slug: string): Promise<void> {
  if (slug === DEFAULT_THEME_SLUG) throw new Error('Cannot delete the bundled default theme');
  const active = await getActiveThemeSlug();
  if (active === slug) throw new Error('Cannot delete the active theme — activate another theme first');

  const dest = join(THEMES_DIR, slug);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  await db.delete(schema.themes).where(eq(schema.themes.slug, slug));
  clearRenderCache();
}

/**
 * Convenience used by the admin UI to switch the active theme — wraps
 * `setActiveTheme` so renders pick up the new theme on the next request.
 */
export async function activateTheme(slug: string): Promise<void> {
  await setActiveTheme(slug);
  clearRenderCache();
}