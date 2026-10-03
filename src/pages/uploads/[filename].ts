// Astro only serves `public/` files present at build time; post-deploy uploads would 404 without this.
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

  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'public, max-age=31536000, immutable',
    // Stops a non-HTML upload being sniffed into an executable document.
    'x-content-type-options': 'nosniff',
  };
  // SVG navigated to directly runs inline <script> same-origin; `sandbox` kills
  // that while leaving <img> embedding untouched.
  if (ext === '.svg') {
    headers['content-security-policy'] = 'sandbox';
  }
  return new Response(body, { status: 200, headers });
};
