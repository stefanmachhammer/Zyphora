/**
 * Local-filesystem media storage.
 *
 * Files land in `public/uploads/` (gitignored) with random UUID names so the
 * original filename can't influence the URL or be guessed. To swap to S3/R2
 * later, replace the three exported functions below (`saveUpload`,
 * `deleteUpload`, `publicUrl`) — every call site goes through them, so the
 * rest of the codebase won't need to change.
 *
 * MIME allowlist + 10 MB cap are intentionally simple. If you grow this list,
 * keep an eye on SVG (it can carry script — DOMPurify is not run on uploads).
 */
import { mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPLOADS_DIR = join(process.cwd(), 'public', 'uploads');

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // ICO has two MIME types in the wild — `image/x-icon` is the de-facto
  // browser-sent value, `image/vnd.microsoft.icon` is what IANA registered.
  // Allow both so favicon uploads work regardless of how the browser labels
  // the file.
  'image/x-icon', 'image/vnd.microsoft.icon',
  'application/pdf',
  'video/mp4', 'video/webm',
]);

const MAX_BYTES = 10 * 1024 * 1024;

// `recursive: true` makes mkdirSync idempotent — no error if the dir exists.
mkdirSync(UPLOADS_DIR, { recursive: true });

export type SavedFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Persist an uploaded `File` to the uploads dir, applying size + MIME limits.
 * Returns the generated filename + metadata; the caller is responsible for
 * inserting the matching `media` row.
 *
 * The extension is sanitized (lowercased, alphanumeric only) before being
 * appended to a fresh UUID so a malicious filename can't smuggle anything
 * surprising onto disk or into URLs.
 */
export async function saveUpload(file: File): Promise<SavedFile> {
  // Reject anything outside the size + MIME policy before touching disk.
  if (file.size === 0) throw new Error('Empty file');
  if (file.size > MAX_BYTES) throw new Error('File exceeds 10 MB limit');
  if (!ALLOWED_MIME.has(file.type)) throw new Error(`Unsupported file type: ${file.type}`);

  // Build a safe on-disk name: random UUID + scrubbed extension. The user's
  // original filename never participates in the path or the public URL.
  const ext = extname(file.name) || '';
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const filename = `${randomUUID()}${safeExt}`;

  // Write the bytes; caller persists the matching `media` row.
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(join(UPLOADS_DIR, filename), buffer);
  return { filename, mimeType: file.type, sizeBytes: file.size };
}

/** Best-effort delete of a stored file. Missing files are silently ignored. */
export async function deleteUpload(filename: string) {
  try {
    await unlink(join(UPLOADS_DIR, filename));
  } catch {
    // file may already be gone — ignore
  }
}

/** Public URL for a stored file. Astro serves `public/` at the site root. */
export function publicUrl(filename: string): string {
  return `/uploads/${filename}`;
}