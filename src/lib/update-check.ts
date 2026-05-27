/**
 * Update check — pings the GitHub releases API at server startup and, if a
 * newer version of ZyphoraCMS is available, prints a one-time notice to the
 * terminal.
 *
 * Wired in as a side-effect import from `src/middleware.ts`, mirroring the
 * `banner.ts` pattern. The HTTP call is fire-and-forget — never awaited at
 * module top level — so it does not delay server boot. The notification
 * lands in the terminal below the existing boot logs once the request
 * resolves (typically well under a second).
 *
 * Opt-outs and safety:
 *  - `ZYPHORA_NO_UPDATE_CHECK=1` skips the network call entirely. Useful
 *    for air-gapped deploys, CI, or operators who don't want a daily ping
 *    to api.github.com from each running server.
 *  - `NO_COLOR` strips ANSI styling, per https://no-color.org.
 *  - A 3s `AbortController` timeout means a slow/unreachable GitHub never
 *    leaves the request dangling.
 *  - Any error (network, rate limit, malformed response, unparseable
 *    version) is swallowed silently. A startup health check must never
 *    spam the operator's console.
 *  - The process-wide `Symbol.for` guard prevents Vite/HMR re-imports
 *    from triggering repeated network calls during development.
 */
import { VERSION } from './version.ts';

// Hardcoded repo coordinates. If the project is ever forked or moved,
// this is the single source of truth for where "latest release" lives.
const REPO = 'stefanmachhammer/Zyphora';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 3000;

// Process-wide guard. `Symbol.for` is keyed by string so the flag survives
// even when this module is re-evaluated under a fresh identity during dev
// HMR, keeping the check (and any printed notice) to once per process.
const CHECKED = Symbol.for('zyphora.update.checked');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

const noColor = Boolean(process.env.NO_COLOR);
const optedOut = process.env.ZYPHORA_NO_UPDATE_CHECK === '1';

if (!globalScope[CHECKED] && !optedOut) {
  globalScope[CHECKED] = true;
  // `void` discards the promise on purpose — awaiting here would block
  // module evaluation, which in turn would block Astro's server boot
  // behind a third-party HTTP request. Errors are handled inside.
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
 * Parse a version string like `"1.2.3"` or `"v1.2.3-rc.1"` into its parts.
 * Returns null for anything that doesn't look like semver — callers treat
 * null as "skip the comparison" rather than guessing.
 *
 * We hand-roll this instead of depending on the `semver` package because
 * the only operation we need is "is A newer than B"; pulling in a 50 kB
 * dependency for two compares is not worth it.
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
 * Compare two parsed semvers. Returns >0 if `a` is newer, <0 if `b` is
 * newer, 0 if equal.
 *
 * Pre-release semantics follow the spec: a pre-release sorts *before* the
 * same base version (so `1.2.0-rc.1 < 1.2.0`). When both sides are
 * pre-releases of the same base, we fall back to lexicographic compare —
 * imperfect for cases like `rc.10` vs `rc.2`, but good enough for the
 * "is there something newer to upgrade to" question this module answers.
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
 * Fetch the latest release from GitHub and, if it's newer than the running
 * version, print a notice. All failure modes (network down, non-2xx, JSON
 * shape mismatch, unparseable tag) exit silently — the operator should
 * never see a stack trace just because GitHub had a hiccup.
 */
async function checkForUpdate(): Promise<void> {
  const current = parseVersion(VERSION);
  if (!current) return;

  let latestTag: string;
  let releaseUrl: string;
  try {
    // AbortController wires Node's `fetch` timeout. Without it, a hung
    // socket would leave the promise (and a file descriptor) pending for
    // the lifetime of the process.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers: {
        // GitHub's recommended Accept header for the REST API.
        Accept: 'application/vnd.github+json',
        // Identifying ourselves is good API etiquette and helps GitHub
        // attribute traffic in case of debugging.
        'User-Agent': `ZyphoraCMS/${VERSION}`,
      },
    });
    clearTimeout(timer);

    if (!res.ok) return;
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!json.tag_name) return;
    latestTag = json.tag_name;
    // Prefer the URL GitHub returns; fall back to the canonical tag URL
    // if the response shape is missing it for some reason.
    releaseUrl = json.html_url ?? `https://github.com/${REPO}/releases/tag/${latestTag}`;
  } catch {
    // Network error, abort, parse failure — swallow and move on. No log.
    return;
  }

  const latest = parseVersion(latestTag);
  if (!latest) return;
  // Strictly newer only. We never want to nag users who are running a
  // newer dev build than what's on GitHub (e.g. local clone ahead of main).
  if (compareVersion(latest, current) <= 0) return;

  printUpdateNotice(VERSION, latestTag, releaseUrl);
}

/**
 * Wrap `text` in a 24-bit ANSI foreground color escape, then reset.
 * Returns the bare text if colors are disabled via NO_COLOR. Mirrors the
 * tiny helper in `banner.ts` rather than sharing it, to keep both modules
 * self-contained and trivially deletable.
 */
function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/**
 * Print the "update available" notice. Kept to three lines so it stays
 * legible in a tailing pager (no box-drawing borders, no multi-paragraph
 * walls of ANSI). The third line tells the operator how to silence the
 * check if they don't want it.
 */
function printUpdateNotice(current: string, latest: string, url: string): void {
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';
  // Amber for the marker so it visually reads as a soft warning (not an
  // error), cyan for the new version to echo the banner's accent color.
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
