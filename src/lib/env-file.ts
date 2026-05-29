/**
 * Minimal .env loader and writer.
 *
 * Reads a `.env` file from the project root at module-import time and merges
 * any keys it defines into `process.env` — but only for keys that aren't
 * already set, so a real environment variable (Docker, systemd, shell export)
 * always wins over the file. This mirrors dotenv's `override: false` default.
 *
 * We hand-roll the parser because the installer needs to *write* the file too
 * (after the user enters DB credentials in the web UI). Sharing a single tiny
 * module keeps read and write semantics in lockstep — no dotenv dependency
 * just to support five keys.
 *
 * Supported syntax (intentionally small):
 *   KEY=value             — bare values
 *   KEY="value with =# "  — double-quoted (escapes: \\ and \")
 *   KEY='value'           — single-quoted (no escapes; treated literally)
 *   # comment             — full-line comment
 *
 * `export KEY=value`, multi-line strings, variable interpolation (`${OTHER}`),
 * and inline comments after a value are deliberately not supported. A full
 * dotenv-compatible parser is a separate ask if the project ever grows into
 * needing it.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_ENV_PATH = resolve(process.cwd(), '.env');

// Process-wide guard against re-loading the file when Vite/HMR re-evaluates
// this module during development. Same `Symbol.for` trick used by
// `lib/banner.ts` so the flag survives module re-identification.
const LOADED = Symbol.for('zyphora.envfile.loaded');
const globalScope = globalThis as unknown as Record<symbol, boolean>;
if (!globalScope[LOADED]) {
  globalScope[LOADED] = true;
  loadEnvFile();
}

/**
 * Read `path` and populate `process.env` for any keys not already set.
 * Missing or unreadable files are silently ignored — production deploys that
 * inject env vars directly (Docker, systemd, k8s) don't need a `.env` to exist.
 */
export function loadEnvFile(path: string = DEFAULT_ENV_PATH): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    // Don't clobber real env vars — they're the source of truth in any
    // environment that has them.
    if (!(key in process.env) || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

/**
 * Update or insert the given keys in the `.env` file, preserving all other
 * lines (comments, ordering, unrelated keys) verbatim.
 *
 * Writes atomically via a `.tmp` sibling + rename so a crash mid-write can
 * never leave a half-written `.env` that locks the operator out. File mode is
 * set to 0o600 since the file typically holds database credentials; on
 * Windows the mode bits are advisory but the call is harmless.
 */
export function writeEnvVars(updates: Record<string, string>, path: string = DEFAULT_ENV_PATH): void {
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = '';
  }
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Pass through blanks and comments untouched.
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      // Malformed line — leave as-is rather than throwing; we never want a
      // weird stray line in someone's .env to break the installer.
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      out.push(`${key}=${encodeValue(remaining.get(key)!)}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }

  // Append any keys that weren't present in the file yet.
  for (const [key, value] of remaining) {
    out.push(`${key}=${encodeValue(value)}`);
  }

  const text = out.join('\n').replace(/\n+$/, '') + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Parse a `.env` body into a plain object. Exposed for tests and the
 * occasional non-side-effect read; the side-effect import above handles the
 * normal load case.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeValue(line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Quote-aware value decoder. Strips matching surrounding quotes and, for the
 * double-quoted form, unescapes `\\` and `\"`. Anything unquoted is taken as
 * a literal string — we deliberately don't strip inline `# comment` tails
 * because passwords can legitimately contain `#`.
 */
function decodeValue(raw: string): string {
  if (raw.length === 0) return '';
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (raw.length >= 2 && first === '"' && last === '"') {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (raw.length >= 2 && first === "'" && last === "'") {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Inverse of `decodeValue`. Wraps in double quotes (with backslash escaping)
 * whenever the value contains characters that would otherwise change its
 * meaning on read: whitespace, quotes, `#`, `$`, or backslashes. Plain
 * alphanumeric values pass through unquoted to keep simple files readable.
 */
function encodeValue(value: string): string {
  if (value === '') return '""';
  if (/[\s"'`$\\#]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return value;
}
