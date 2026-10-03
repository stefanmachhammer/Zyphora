import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_ENV_PATH = resolve(process.cwd(), '.env');

// Symbol.for so the guard survives Vite/HMR re-evaluating this module.
const LOADED = Symbol.for('zyphora.envfile.loaded');
const globalScope = globalThis as unknown as Record<symbol, boolean>;
if (!globalScope[LOADED]) {
  globalScope[LOADED] = true;
  loadEnvFile();
}

export function loadEnvFile(path: string = DEFAULT_ENV_PATH): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env) || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

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

  for (const [key, value] of remaining) {
    out.push(`${key}=${encodeValue(value)}`);
  }

  const text = out.join('\n').replace(/\n+$/, '') + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

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

// Unquoted values are literal: no inline `# comment` stripping, since passwords may contain `#`.
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

function encodeValue(value: string): string {
  if (value === '') return '""';
  if (/[\s"'`$\\#]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return value;
}
