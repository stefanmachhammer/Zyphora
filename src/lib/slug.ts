/**
 * Convert a free-form string into a URL-safe slug: NFKD-fold accents to their
 * base letter ("café" → "cafe"), collapse non-alphanumerics to dashes, trim,
 * cap at 80 chars (matches the form schema), fall back to "untitled".
 *
 * Uniqueness is the caller's problem — see `uniqueSlug()` in `src/lib/posts.ts`.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining diacritical marks (U+0300–U+036F), escaped so the regex
    // is unaffected by source-file encoding.
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '') || 'untitled';
}