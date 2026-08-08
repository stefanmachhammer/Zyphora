/**
 * Console boot banner — prints the "Zyphora CMS" watermark once at startup.
 * Side-effect imported from `src/middleware.ts`, which Astro evaluates once on
 * SSR boot. Uses 24-bit ANSI color and honors NO_COLOR (https://no-color.org).
 */

// Declared before the boot guard so printBanner()'s closure over it is initialized.
const noColor = Boolean(process.env.NO_COLOR);

// Process-wide guard. `Symbol.for` is string-keyed, so it survives dev-server
// HMR re-evaluating this module under a fresh identity — one print per process.
const BANNER_PRINTED = Symbol.for('zyphora.banner.printed');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

if (!globalScope[BANNER_PRINTED]) {
  globalScope[BANNER_PRINTED] = true;
  printBanner();
}

/** Wrap `text` in a 24-bit ANSI color escape (bare text when NO_COLOR). */
function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/**
 * Per-character RGB gradient across `text`, from `start` to `end`. Spreads via
 * `[...text]` so multi-byte figlet glyphs count as one character.
 */
function gradient(
  text: string,
  start: [number, number, number],
  end: [number, number, number],
): string {
  const chars = [...text];
  const n = chars.length;
  return chars
    .map((ch, i) => {
      const t = n <= 1 ? 0 : i / (n - 1);
      const r = Math.round(start[0] + (end[0] - start[0]) * t);
      const g = Math.round(start[1] + (end[1] - start[1]) * t);
      const b = Math.round(start[2] + (end[2] - start[2]) * t);
      return rgb(r, g, b, ch);
    })
    .join('');
}

/** Print the watermark. Invoked at most once per process. */
function printBanner(): void {
  // Raw ANSI codes to avoid a chalk/kleur dependency for one boot message.
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';

  // Gradient endpoints: hot pink → sky cyan, readable on dark and light themes.
  const pink: [number, number, number] = [255, 71, 195];
  const cyan: [number, number, number] = [88, 217, 255];

  // "ZYPHORA" in the ANSI Shadow figlet font, hand-pasted (no runtime figlet
  // dependency). One string per glyph row.
  const zyphora = [
    '███████╗██╗   ██╗██████╗ ██╗  ██╗ ██████╗ ██████╗  █████╗ ',
    '╚══███╔╝╚██╗ ██╔╝██╔══██╗██║  ██║██╔═══██╗██╔══██╗██╔══██╗',
    '  ███╔╝  ╚████╔╝ ██████╔╝███████║██║   ██║██████╔╝███████║',
    ' ███╔╝    ╚██╔╝  ██╔═══╝ ██╔══██║██║   ██║██╔══██╗██╔══██║',
    '███████╗   ██║   ██║     ██║  ██║╚██████╔╝██║  ██║██║  ██║',
    '╚══════╝   ╚═╝   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
  ];

  // Spaced subtitle instead of a second figlet block (which would overflow ~80 cols).
  const subtitle = 'C  O  N  T  E  N  T   M  A  N  A  G  E  M  E  N  T   S  Y  S  T  E  M';
  const tagline = 'the self-hosted Astro CMS  ·  crafted with care';

  console.log();
  for (const line of zyphora) {
    console.log('  ' + gradient(line, pink, cyan));
  }
  console.log();
  // Reversed gradient so the subtitle mirrors the figlet above.
  console.log('  ' + bold + gradient(subtitle, cyan, pink) + reset);
  console.log('  ' + dim + tagline + reset);
  console.log();
}