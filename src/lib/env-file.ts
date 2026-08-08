/**
 * Minimal .env loader and writer. Loads keys into `process.env` without
 * overriding already-set vars (real env always wins, like dotenv's
 * `override: false`). Hand-rolled rather than a dotenv dependency because the
 * installer must *write* the file too, and keeping read/write in one module
 * keeps their semantics in lockstep.
 *
 * Supported syntax (intentionally small):
 *   KEY=value             — bare
 *   KEY="value with =# "  — double-quoted (escapes: \\ and \")
 *   KEY='value'           — single-quoted (literal, no escapes)
 *   # comment             — full-line comment
 *
 * `export KEY=`, multi-line, `${interpolation}`, and inline comments are
 * deliberately unsupported.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_ENV_PATH = resolve(process.cwd(), '.env');

// Process-wide guard against re-loading when Vite/HMR re-evaluates this module.
// `Symbol.for` so the flag survives module re-identification (as in lib/banner.ts).
const LOADED = Symbol.for('zyphora.envfile.loaded');
const globalScope = globalThis as unknown as Record<symbol, boolean>;
if (!globalScope[LOADED]) {
  globalScope[LOADED] = true;
  loadEnvFile();
}

/**
 * Read `path` and populate `process.env` for any keys not already set. A
 * missing/unreadable file is silently ignored (deploys that inject env vars
 * directly don't need a `.env`).
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
    // Don't clobber real env vars.
    if (!(key in process.env) || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

/**
 * Update or insert the given keys, preserving all other lines (comments,
 * ordering, unrelated keys) verbatim. Writes atomically via `.tmp` + rename so
 * a crash can't leave a half-written `.env`. Mode 0o600 since it holds DB
 * credentials (advisory on Windows).
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
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      // Malformed line — leave as-is rather than let it break the installer.
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

  // Append keys not already in the file.
  for (const [key, value] of remaining) {
    out.push(`${key}=${encodeValue(value)}`);
  }

  const text = out.join('\n').replace(/\n+$/, '') + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Parse a `.env` body into a plain object. Exposed for tests and non-side-effect reads. */
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
 * Quote-aware value decoder. Strips matching quotes; unescapes `\\` and `\"`
 * in the double-quoted form. Unquoted values are literal — no inline `# comment`
 * stripping, because passwords can legitimately contain `#`.
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
 * Inverse of `decodeValue`. Double-quotes (with backslash escaping) any value
 * containing whitespace, quotes, `#`, `$`, or backslashes; plain values pass
 * through unquoted.
 */
function encodeValue(value: string): string {
  if (value === '') return '""';
  if (/[\s"'`$\\#]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return value;
}
