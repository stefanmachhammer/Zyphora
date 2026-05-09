/**
 * Static asset endpoint for themes.
 *
 * Serves files from `themes/<slug>/assets/` at the URL `/themes/<slug>/<path>`.
 * Only files under the theme's `assets/` directory are exposed — templates,
 * `theme.json`, and any other internals stay private.
 *
 * Path-safety rules:
 *  - the slug must match the same lowercase-alphanumeric pattern the registry
 *    uses (so a malicious URL can't smuggle `..` through the slug)
 *  - the resolved path must stay inside the theme's assets dir (defense
 *    against URL-encoded `..` segments)
 */

import type { APIRoute } from 'astro';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { THEMES_DIR } from '../../../lib/themes/registry.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const isProd = import.meta.env?.PROD ?? process.env.NODE_ENV === 'production';

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

export const GET: APIRoute = async ({ params }) => {
  const theme = params.theme;
  const path = params.path;
  if (!theme || !path || !SLUG_RE.test(theme)) return notFound();

  const assetsRoot = resolve(join(THEMES_DIR, theme, 'assets'));
  const target = resolve(join(assetsRoot, path));

  // Defense against `..` segments smuggled through the wildcard.
  if (target !== assetsRoot && !target.startsWith(assetsRoot + sep)) return notFound();
  if (!existsSync(target) || !statSync(target).isFile()) return notFound();

  const data = await readFile(target);
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  return new Response(data, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': isProd ? 'public, max-age=3600' : 'no-cache',
    },
  });
};