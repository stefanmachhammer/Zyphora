/**
 * CMS version, read once from `package.json` and cached as a constant (the
 * admin sidebar displays it; no per-request disk read). Path is resolved
 * relative to this file, not cwd, so it works from repo root or `dist/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Two levels up from src/lib/ (and from dist/server/, whose shape Astro mirrors).
const pkgPath = join(here, '..', '..', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const VERSION: string = pkg.version;
