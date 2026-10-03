// Must precede the boot guard: printBanner() reads it synchronously (TDZ).
const noColor = Boolean(process.env.NO_COLOR);

// Symbol.for survives dev-server HMR re-evaluating this module: one print per process.
const BANNER_PRINTED = Symbol.for('zyphora.banner.printed');
const globalScope = globalThis as unknown as Record<symbol, boolean>;

if (!globalScope[BANNER_PRINTED]) {
  globalScope[BANNER_PRINTED] = true;
  printBanner();
}

function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

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

function printBanner(): void {
  const bold = noColor ? '' : '\x1b[1m';
  const dim = noColor ? '' : '\x1b[2m';
  const reset = noColor ? '' : '\x1b[0m';

  const pink: [number, number, number] = [255, 71, 195];
  const cyan: [number, number, number] = [88, 217, 255];

  const zyphora = [
    '███████╗██╗   ██╗██████╗ ██╗  ██╗ ██████╗ ██████╗  █████╗ ',
    '╚══███╔╝╚██╗ ██╔╝██╔══██╗██║  ██║██╔═══██╗██╔══██╗██╔══██╗',
    '  ███╔╝  ╚████╔╝ ██████╔╝███████║██║   ██║██████╔╝███████║',
    ' ███╔╝    ╚██╔╝  ██╔═══╝ ██╔══██║██║   ██║██╔══██╗██╔══██║',
    '███████╗   ██║   ██║     ██║  ██║╚██████╔╝██║  ██║██║  ██║',
    '╚══════╝   ╚═╝   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
  ];

  const subtitle = 'C  O  N  T  E  N  T   M  A  N  A  G  E  M  E  N  T   S  Y  S  T  E  M';
  const tagline = 'the self-hosted Astro CMS  ·  crafted with care';

  console.log();
  for (const line of zyphora) {
    console.log('  ' + gradient(line, pink, cyan));
  }
  console.log();
  console.log('  ' + bold + gradient(subtitle, cyan, pink) + reset);
  console.log('  ' + dim + tagline + reset);
  console.log();
}