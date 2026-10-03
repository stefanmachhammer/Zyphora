import { VERSION } from './version.ts';

const REPO = 'stefanmachhammer/Zyphora';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 3000;

// Symbol.for survives dev-server HMR re-evaluating this module.
const CHECKED = Symbol.for('zyphora.update.checked');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

const noColor = Boolean(process.env.NO_COLOR);
const optedOut = process.env.ZYPHORA_NO_UPDATE_CHECK === '1';

if (!globalScope[CHECKED] && !optedOut) {
  globalScope[CHECKED] = true;
  // Not awaited: a top-level await here would block server boot on a GitHub call.
  void checkForUpdate();
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

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

// A pre-release sorts before its base; two pre-releases compare lexicographically
// (rc.10 < rc.2 — acceptable for an "is there an upgrade" check).
function compareVersion(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

async function checkForUpdate(): Promise<void> {
  const current = parseVersion(VERSION);
  if (!current) return;

  let latestTag: string;
  let releaseUrl: string;
  try {
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
    return;
  }

  const latest = parseVersion(latestTag);
  if (!latest) return;
  if (compareVersion(latest, current) <= 0) return;

  printUpdateNotice(VERSION, latestTag, releaseUrl);
}

function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function printUpdateNotice(current: string, latest: string, url: string): void {
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';
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
