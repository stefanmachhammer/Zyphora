/**
 * Convert a free-form string into a URL-safe slug.
 *
 * Steps:
 *   1. NFKD-normalize and strip combining marks so accented characters
 *      collapse to their base letter (e.g. "café" → "cafe").
 *   2. Replace anything outside `[a-z0-9]` with a single dash.
 *   3. Trim leading/trailing dashes.
 *   4. Cap at 80 chars to keep URLs reasonable and match the form schema.
 *   5. Fall back to "untitled" so we never return an empty string.
 *
 * Uniqueness is the caller's problem — see `uniqueSlug()` in `src/lib/posts.ts`.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    // Combining diacritical marks block (U+0300–U+036F) — written as explicit
    // escapes so the regex stays correct regardless of source-file encoding.
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '') || 'untitled';
}