/**
 * Update check — pings the GitHub releases API at startup and prints a one-time
 * notice if a newer version exists. Side-effect imported from `src/middleware.ts`
 * (like `banner.ts`); fire-and-forget so it never delays boot.
 *
 * Opt-outs / safety: `ZYPHORA_NO_UPDATE_CHECK=1` skips the network call
 * (air-gapped/CI); `NO_COLOR` strips ANSI; a 3s abort timeout bounds a slow
 * GitHub; all errors are swallowed; the `Symbol.for` guard blocks HMR re-runs.
 */
import { VERSION } from './version.ts';

// Single source of truth for where "latest release" lives.
const REPO = 'stefanmachhammer/Zyphora';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 3000;

// Process-wide guard; string-keyed `Symbol.for` survives dev-HMR re-evaluation.
const CHECKED = Symbol.for('zyphora.update.checked');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

const noColor = Boolean(process.env.NO_COLOR);
const optedOut = process.env.ZYPHORA_NO_UPDATE_CHECK === '1';

if (!globalScope[CHECKED] && !optedOut) {
  globalScope[CHECKED] = true;
  // `void`: don't await — that would block server boot on a third-party HTTP call.
  void checkForUpdate();
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release suffix without the leading `-`, or null for a final release. */
  pre: string | null;
}

/**
 * Parse `"1.2.3"` / `"v1.2.3-rc.1"` into parts; null for non-semver (callers
 * skip the comparison). Hand-rolled to avoid the `semver` dependency for one compare.
 */
function parseVersion(input: string): SemVer | null {
  const m = input.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? null,
  };
}

/**
 * Compare two semvers: >0 if `a` newer, <0 if `b` newer, 0 if equal.
 * Per spec a pre-release sorts before its base (`1.2.0-rc.1 < 1.2.0`); two
 * pre-releases of one base fall back to lexicographic (imperfect for `rc.10`
 * vs `rc.2`, fine for the "is there an upgrade" question here).
 */
function compareVersion(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

/**
 * Fetch the latest release and print a notice if it's newer. Every failure
 * mode (network, non-2xx, bad JSON, unparseable tag) exits silently.
 */
async function checkForUpdate(): Promise<void> {
  const current = parseVersion(VERSION);
  if (!current) return;

  let latestTag: string;
  let releaseUrl: string;
  try {
    // Bounds a hung socket that would otherwise leave the request pending forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `ZyphoraCMS/${VERSION}`,
      },
    });
    clearTimeout(timer);

    if (!res.ok) return;
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!json.tag_name) return;
    latestTag = json.tag_name;
    releaseUrl = json.html_url ?? `https://github.com/${REPO}/releases/tag/${latestTag}`;
  } catch {
    return; // swallow — no log
  }

  const latest = parseVersion(latestTag);
  if (!latest) return;
  // Strictly newer only, so a local build ahead of GitHub isn't nagged.
  if (compareVersion(latest, current) <= 0) return;

  printUpdateNotice(VERSION, latestTag, releaseUrl);
}

/** Wrap `text` in a 24-bit ANSI color escape (bare text when NO_COLOR). Twin of banner.ts's, kept separate so each module is deletable. */
function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** Print the three-line "update available" notice. */
function printUpdateNotice(current: string, latest: string, url: string): void {
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';
  // Amber marker reads as a soft warning; cyan version echoes the banner accent.
  const amber = (s: string) => rgb(255, 184, 88, s);
  const cyan = (s: string) => rgb(88, 217, 255, s);

  console.log();
  console.log(
    `  ${amber('▲')} ${bold}ZyphoraCMS update available${reset}  ${dim}${current}${reset} → ${cyan(latest)}`,
  );
  console.log(`    ${dim}${url}${reset}`);
  console.log(`    ${dim}Set ZYPHORA_NO_UPDATE_CHECK=1 to silence this notice.${reset}`);
  console.log();
}
