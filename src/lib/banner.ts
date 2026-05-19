/**
 * Console boot banner — prints a colorful "Stefan Machhammer" watermark
 * once, at server startup.
 *
 * Wired in as a side-effect import from `src/middleware.ts`, which Astro
 * loads exactly once when it boots the SSR server. Doing it that way means
 * the watermark lands in the terminal before the first request is served
 * (and not, say, on every HTTP request).
 *
 * Idempotency note: in dev, Vite/HMR can re-evaluate modules under a fresh
 * identity. We stash a flag on globalThis under `Symbol.for(...)` (which is
 * keyed by string, so it survives re-imports) to make sure repeated module
 * evaluation never re-prints the banner.
 *
 * Color note: this uses 24-bit (true-color) ANSI escapes. Every modern
 * terminal supports them; on the rare terminal that doesn't, the underlying
 * characters still render — they just won't be colored. We also respect the
 * `NO_COLOR` env convention (https://no-color.org) for users who explicitly
 * opt out of ANSI styling.
 */

// Respect the NO_COLOR convention (https://no-color.org). If set, strip ANSI.
// Declared *before* the boot guard below so the call to `printBanner()` —
// which closes over `noColor` — doesn't trip the temporal dead zone.
const noColor = Boolean(process.env.NO_COLOR);

// Process-wide guard. `Symbol.for` is keyed by string so this survives even
// when the module is re-evaluated under a different module identity (e.g.
// during dev-server HMR), keeping the banner to a single print per process.
const BANNER_PRINTED = Symbol.for('zyphora.banner.printed');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

if (!globalScope[BANNER_PRINTED]) {
  globalScope[BANNER_PRINTED] = true;
  printBanner();
}

/**
 * Wrap `text` in a 24-bit ANSI foreground color escape, then reset.
 * Returns the bare text if colors are disabled via NO_COLOR.
 */
function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/**
 * Linearly interpolate a per-character RGB gradient across `text`,
 * blending from `start` to `end`. Single-char strings get the start color.
 *
 * Implementation notes:
 *  - We spread into `[...text]` so multi-byte glyphs (the block/box-drawing
 *    characters used in the figlet art) count as one logical character.
 *  - `t` is the 0..1 position along the gradient; we round each channel to
 *    the nearest integer since ANSI true-color expects 0–255 ints.
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
  // ANSI control codes used directly so we don't add a runtime dependency
  // on `chalk` / `kleur` just for one boot message.
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';

  // Gradient endpoints — hot pink → sky cyan. Picked to read as "neon" on
  // both dark and light terminal themes.
  const pink: [number, number, number] = [255, 71, 195];
  const cyan: [number, number, number] = [88, 217, 255];

  // "STEFAN" in the ANSI Shadow figlet font, hand-pasted so we don't have
  // to ship a runtime figlet dependency just for a startup banner. Each
  // entry is one row of the six-row glyph.
  const stefan = [
    '███████╗████████╗███████╗███████╗ █████╗ ███╗   ██╗',
    '██╔════╝╚══██╔══╝██╔════╝██╔════╝██╔══██╗████╗  ██║',
    '███████╗   ██║   █████╗  █████╗  ███████║██╔██╗ ██║',
    '╚════██║   ██║   ██╔══╝  ██╔══╝  ██╔══██║██║╚██╗██║',
    '███████║   ██║   ███████╗██║     ██║  ██║██║ ╚████║',
    '╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝',
  ];

  // The surname rendered in the same figlet font would overflow most
  // terminals (~80 cols), so we render it as a spaced subtitle instead.
  const surname = 'M  A  C  H  H  A  M  M  E  R';
  const tagline = 'ZyphoraCMS  ·  crafted with care';

  // Leading blank line gives breathing room above whatever Astro/Node has
  // already logged (port, env, etc.) by the time we get here.
  console.log();
  for (const line of stefan) {
    console.log('  ' + gradient(line, pink, cyan));
  }
  console.log();
  // Flip the gradient direction on the subtitle so it visually mirrors the
  // figlet above — a tiny detail that makes the whole block feel composed.
  console.log('  ' + bold + gradient(surname, cyan, pink) + reset);
  console.log('  ' + dim + tagline + reset);
  console.log();
}