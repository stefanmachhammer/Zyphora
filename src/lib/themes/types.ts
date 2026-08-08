/**
 * Type definitions for the theme runtime. A theme is `themes/<slug>/` with a
 * `theme.json` manifest, an `assets/` folder (served at `/themes/<slug>/...`),
 * and `templates/` of Eta templates that render the public site.
 */

/**
 * Shape of a theme's `theme.json` (source of truth; the DB row mirrors a subset).
 * `templates` overrides which file backs each route; renderer defaults are
 * `index.eta`, `post.eta`, `404.eta`.
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
    /** Optional. Themes that don't ship a search template fall back to index.eta. */
    search?: string;
  };
};

/** Installed theme: manifest + DB metadata + absolute on-disk dir. From the registry. */
export type ThemeRecord = ThemeManifest & {
  bundled: boolean;
  installedAt: Date;
  active: boolean;
  dir: string;
};

/**
 * Public-facing post passed into templates. `contentHtml` is populated only on
 * the single-post view; list views omit it.
 */
export type SitePost = {
  slug: string;
  title: string;
  excerpt: string | null;
  contentHtml?: string;
  publishedAt: Date | null;
  authorName: string | null;
  // Per-post comment toggle (single-post view only). Themes hide the form when
  // false; the route enforces it server-side regardless.
  commentsEnabled?: boolean;
};

/**
 * Public-facing comment passed into templates. `content` is the raw plain-text
 * body; `contentHtml` is it escaped with `\n`→`<br>`, ready for `<%~ %>`.
 */
export type SiteComment = {
  id: string;
  authorName: string;
  authorUrl: string | null;
  content: string;
  contentHtml: string;
  createdAt: Date;
};

/**
 * Sticky-form payload for a failed comment submission: the previous values
 * plus a per-field error map keyed by form field name.
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
 * Public-safe shape of the signed-in user for templates. Omits the password
 * hash and other server-only fields so a template can't leak them.
 */
export type SiteUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

/**
 * Sticky-form state for the auth pages (`/login`, `/register`) after a failed
 * submission: pre-filled `values`, a per-field `errors` map, and a form-wide
 * `error` (e.g. "Invalid email or password."). Themes may render just `error`
 * and ignore the additive per-field map.
 */
export type AuthFormState = {
  values: {
    email?: string;
    displayName?: string;
  };
  errors: Record<string, string>;
  error?: string;
};

/**
 * The object passed to every theme template. Helpers like `assetUrl` and
 * `url.post` keep authors from hand-stitching URLs that may change.
 */
export type RenderContext = {
  site: {
    title: string;
    description: string;
    /** Favicon URL, or `null` if none uploaded. Themes emit `<link rel="icon">` only when set. */
    faviconUrl: string | null;
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
    search: (q: string) => string;
  };
  posts?: SitePost[];
  post?: SitePost;
  comments?: SiteComment[];
  /** Present only when the previous request was a failed comment submission. */
  commentForm?: CommentFormState;
  /** Signed-in user, or `null` for anonymous. Always present so `if (currentUser)` is safe. */
  currentUser: SiteUser | null;
  /** On `/login` and `/register`: pre-fill values and inline errors (empty on first GET). */
  authForm?: AuthFormState;
  /** Same-origin post-auth redirect path; themes round-trip it through a hidden input. */
  authRedirect?: string;
  /**
   * Set after a successful comment POST for a banner: `'pending'` = queued for
   * moderation, `'approved'` = already visible below.
   */
  commentSubmitted?: 'pending' | 'approved' | null;
  /**
   * reCAPTCHA v2 site key, or `null` when unconfigured. Themes render the widget
   * only when non-null; the server verifier also short-circuits when keys are
   * missing, so ignoring this field just yields unprotected comments.
   */
  recaptchaSiteKey: string | null;
  /**
   * Present on the search route. `total` lets templates show "N results" without
   * re-counting `posts`. Themes without `search.eta` fall back to `index.eta`.
   */
  search?: {
    query: string;
    total: number;
  };
  year: number;
};