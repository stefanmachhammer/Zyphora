/**
 * Runtime file server for `/uploads/<filename>`.
 *
 * With `output: 'server'`, Astro's static layer only serves files present under
 * `public/` at build time — media uploaded after deploy would 404. This route
 * streams it from `UPLOADS_DIR` at request time.
 *
 * Path-traversal safe: rejects `..`/separators and resolve-checks the final path.
 */
import type { APIRoute } from 'astro';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { UPLOADS_DIR } from '../../lib/media.ts';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const GET: APIRoute = ({ params }) => {
  const filename = params.filename;
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  const filePath = join(UPLOADS_DIR, filename);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(UPLOADS_DIR) + sep)) {
    return new Response('Not found', { status: 404 });
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return new Response('Not found', { status: 404 });
  }

  const ext = extname(filename).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const body = readFileSync(resolved);

  // Uploads are user-supplied and same-origin, so response headers matter for XSS.
  const headers: Record<string, string> = {
    'content-type': mime,
    // Filenames are random UUIDs, so the content at a URL never changes.
    'cache-control': 'public, max-age=31536000, immutable',
    // Prevent MIME-sniffing a non-HTML upload into an executable document.
    'x-content-type-options': 'nosniff',
  };
  // SVG opened as a top-level navigation runs inline <script> same-origin. A bare
  // `sandbox` CSP disables scripts/same-origin in that document context (killing the
  // XSS) while leaving <img>/<link rel=icon> embedding untouched. SVG-only so it
  // doesn't affect the inline PDF viewer or media playback.
  if (ext === '.svg') {
    headers['content-security-policy'] = 'sandbox';
  }
  return new Response(body, { status: 200, headers });
};
