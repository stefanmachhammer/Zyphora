/// <reference path="../.astro/types.d.ts" />

/**
 * Augments `Astro.locals` with the per-request fields populated by
 * `src/middleware.ts`. Keeping the types here means any `.astro` file can
 * read `Astro.locals.user` without an import.
 */
declare namespace App {
  interface Locals {
    user: import('./lib/auth.ts').SessionUser | null;
    sessionId: string | null;
    /**
     * Set by `/posts/[slug]` on a successful render so the analytics
     * middleware can attribute the page view to a post id (unset elsewhere).
     */
    trackedPostId?: string | null;
    /**
     * Canonical public path for the rendered page (e.g. `/posts/<slug>` from
     * the stored slug) so case/encoding/trailing-slash variants of one URL
     * aggregate as a single row in the analytics report.
     */
    trackedPath?: string;
  }
}