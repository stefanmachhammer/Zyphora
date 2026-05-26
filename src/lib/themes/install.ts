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
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, normalize, resolve, sep, dirname } from 'node:path';
import { z } from 'zod';
import { db, schema } from '../../db/client.ts';
import { eq } from 'drizzle-orm';
import { THEMES_DIR, DEFAULT_THEME_SLUG, readManifest, syncThemes } from './registry.ts';
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
export type UpdateResult = {
  slug: string;
  name: string;
  fromVersion: string | null;
  toVersion: string;
};

type ParsedManifest = z.infer<typeof installManifestSchema>;
type StrippedEntry = { raw: AdmZip.IZipEntry; rel: string };

/**
 * Parse and validate an uploaded zip buffer without writing anything.
 * Returns the entries (with any single wrapper dir stripped) and the
 * parsed `theme.json`. Throws human-readable errors for every rejection
 * case so callers can surface them verbatim in the admin UI.
 */
function parseThemeZip(buffer: Buffer): { stripped: StrippedEntry[]; manifest: ParsedManifest } {
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

  // Normalize entry names to POSIX separators. The zip spec mandates `/`, but
  // some Windows zip tools (and adm-zip on Windows hosts) surface backslashes,
  // which Linux treats as literal filename characters — files would land at
  // `themes/<slug>/templates\index.eta` instead of `templates/index.eta`.
  const entryNames = entries.map((e) => e.entryName.replace(/\\/g, '/'));

  const prefix = detectPrefix(entryNames);
  const stripped: StrippedEntry[] = entries.map((e, i) => {
    const name = entryNames[i]!;
    return {
      raw: e,
      rel: prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name,
    };
  });

  const manifestEntry = stripped.find((e) => e.rel === 'theme.json');
  if (!manifestEntry) throw new Error('Zip is missing theme.json at the top level');

  let manifest: ParsedManifest;
  try {
    const parsed = JSON.parse(manifestEntry.raw.getData().toString('utf8'));
    manifest = installManifestSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid theme.json: ${err instanceof Error ? err.message : 'parse error'}`);
  }

  return { stripped, manifest };
}

/**
 * Extract validated zip entries into a fresh destination directory.
 *
 * Caller must ensure `dest` does not yet exist. On any failure (zip bomb,
 * unsafe path, lint error) the partially-extracted directory is removed
 * before the error is re-thrown — `dest` is either fully populated and
 * lint-clean or absent.
 *
 * Steps:
 *  1. Sum uncompressed sizes (zip-bomb guard).
 *  2. Extract each entry, validating that its resolved path stays inside dest.
 *  3. Lint the resulting `templates/` dir so render-time failures surface
 *     here instead of on the next page render.
 */
function extractZipToDir(stripped: StrippedEntry[], dest: string): void {
  let total = 0;
  for (const e of stripped) {
    if (e.raw.isDirectory) continue;
    total += e.raw.header.size;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Theme uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`);
    }
  }

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
    // upload/update action.
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
}

/**
 * Install a theme from an uploaded zip buffer.
 *
 * Refuses to overwrite existing themes — admins must delete first or call
 * `updateFromZip` to replace an existing install in place. The hard
 * separation keeps accidental overwrites and silent downgrades from
 * happening through the install path.
 */
export async function installFromZip(buffer: Buffer): Promise<InstallResult> {
  const { stripped, manifest } = parseThemeZip(buffer);
  const slug = manifest.slug;
  const dest = join(THEMES_DIR, slug);
  if (existsSync(dest)) throw new Error(`A theme with slug "${slug}" is already installed; delete it first or use Update`);

  if (!existsSync(THEMES_DIR)) mkdirSync(THEMES_DIR, { recursive: true });
  extractZipToDir(stripped, dest);

  await syncThemes();
  clearRenderCache();
  return { slug, name: manifest.name, version: manifest.version };
}

/**
 * Update an already-installed theme by replacing its directory with a fresh
 * zip extraction.
 *
 * The update is "stage then swap":
 *   1. Extract+lint the new zip into a hidden staging dir under THEMES_DIR
 *      (same volume → rename is fast and stays atomic-ish on Windows).
 *   2. Move the live dir aside to a hidden backup.
 *   3. Move staging into the live slot.
 *   4. Delete the backup.
 *
 * If step 3 fails, the backup is moved back so the previous install is
 * restored. The render cache is cleared on success so the active theme
 * picks up the new templates on the next request.
 *
 * Refuses:
 *   - bundled themes (their source of truth is the codebase, not uploads)
 *   - mismatched slugs (the zip's `theme.json` slug must equal the target)
 *   - missing target (caller should `installFromZip` instead)
 */
export async function updateFromZip(slug: string, buffer: Buffer): Promise<UpdateResult> {
  if (slug === DEFAULT_THEME_SLUG) {
    throw new Error('Cannot update the bundled default theme — it ships with the codebase');
  }
  const dest = join(THEMES_DIR, slug);
  if (!existsSync(dest)) throw new Error(`Theme "${slug}" is not installed`);

  const { stripped, manifest } = parseThemeZip(buffer);
  if (manifest.slug !== slug) {
    throw new Error(
      `Zip slug "${manifest.slug}" does not match target "${slug}". To install a new theme, delete this one and use the upload form.`,
    );
  }

  const prevManifest = readManifest(slug);
  const fromVersion = prevManifest?.version ?? null;

  // Stage extraction inside THEMES_DIR so the eventual rename is same-volume.
  // The dot prefix keeps `scanThemes` from picking the staging dir up if a
  // request lands mid-update (registry skips dot-prefixed entries).
  const staging = join(THEMES_DIR, `.staging-${slug}-${randomUUID()}`);
  extractZipToDir(stripped, staging);

  // Swap. We move the current install aside first so we can roll back if the
  // staging→live rename fails (rare on the same volume, but possible if a
  // file inside is locked on Windows).
  const backup = join(THEMES_DIR, `.backup-${slug}-${randomUUID()}`);
  try {
    renameSync(dest, backup);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  try {
    renameSync(staging, dest);
  } catch (err) {
    // Restore the previous install. If even the rollback fails the live dir
    // is gone; surface both errors so the admin can recover manually.
    try {
      renameSync(backup, dest);
    } catch (restoreErr) {
      throw new Error(
        `Failed to swap in new theme (${err instanceof Error ? err.message : String(err)}) ` +
          `and failed to restore previous theme (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}). ` +
          `Previous install is at ${backup}.`,
      );
    }
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  rmSync(backup, { recursive: true, force: true });

  await syncThemes();
  clearRenderCache();
  return { slug, name: manifest.name, fromVersion, toVersion: manifest.version };
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