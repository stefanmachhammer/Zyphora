/**
 * Type definitions for the theme runtime.
 *
 * A "theme" is a directory under `themes/<slug>/` containing a `theme.json`
 * manifest, an `assets/` folder served at `/themes/<slug>/...`, and `templates/`
 * full of Eta templates that render the public site.
 */

/**
 * Shape of a theme's `theme.json` file. The file is the source of truth for
 * presentational metadata; the DB row mirrors a subset for fast lookups.
 *
 * `templates` lets a theme override which file backs each route. Defaults
 * resolved by the renderer are `index.eta`, `post.eta`, `404.eta`.
 */
export type ThemeManifest = {
  slug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  templates?: {
    index?: string;
    post?: string;
    notFound?: string;
  };
};

/**
 * In-memory representation of an installed theme — manifest + DB metadata +
 * the resolved absolute directory on disk. Returned from the registry.
 */
export type ThemeRecord = ThemeManifest & {
  bundled: boolean;
  installedAt: Date;
  active: boolean;
  dir: string;
};

/**
 * Public-facing post shape passed into theme templates.
 *
 * `contentHtml` is only populated for the single-post view; list views omit it
 * to keep the payload light.
 */
export type SitePost = {
  slug: string;
  title: string;
  excerpt: string | null;
  contentHtml?: string;
  publishedAt: Date | null;
  authorName: string | null;
};

/**
 * Public-facing comment shape passed into theme templates. Plain text only —
 * `content` is HTML-stripped server-side in lib/comments.ts before storage,
 * and the template is expected to escape it on render.
 */
export type SiteComment = {
  id: string;
  authorName: string;
  authorUrl: string | null;
  content: string;
  createdAt: Date;
};

/**
 * Sticky-form payload used when a comment submission fails validation. The
 * page re-renders with the user's previous values (so they don't have to
 * retype) and a per-field error map keyed by the form field name.
 */
export type CommentFormState = {
  values: {
    authorName?: string;
    authorEmail?: string;
    authorUrl?: string;
    content?: string;
  };
  errors: Record<string, string>;
};

/**
 * The object passed to every theme template. Templates can rely on every
 * field being present (helpers like `assetUrl` and `url.post` keep theme
 * authors from hand-stitching URLs that may change).
 */
export type RenderContext = {
  site: {
    title: string;
    description: string;
  };
  theme: {
    slug: string;
    assetUrl: (path: string) => string;
  };
  url: {
    pathname: string;
    home: string;
    post: (slug: string) => string;
    admin: string;
  };
  posts?: SitePost[];
  post?: SitePost;
  comments?: SiteComment[];
  /** Present only when the previous request was a failed comment submission. */
  commentForm?: CommentFormState;
  /** True after a successful comment POST so the template can show a banner. */
  commentSubmitted?: boolean;
  year: number;
};