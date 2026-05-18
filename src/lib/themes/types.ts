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
    /** Optional. Themes that don't ship a search template fall back to index.eta. */
    search?: string;
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
  // Per-post comment toggle. Only populated on the single-post view; list
  // views omit it. Themes should hide the comment form and the existing-
  // comments section when false; the route enforces it server-side either way.
  commentsEnabled?: boolean;
};

/**
 * Public-facing comment shape passed into theme templates. `content` is the
 * raw plain-text comment body; `contentHtml` is the same text escaped and
 * with `\n` converted to `<br>`, ready for `<%~ %>` in templates. The route
 * renders `contentHtml` so theme authors don't have to escape inline.
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
 * Minimal, public-safe shape of the signed-in user passed into theme
 * templates. Themes use this to render "Hi, <name>" + a logout link and to
 * branch on auth state. We deliberately omit the password hash and any other
 * server-only fields so a template can't accidentally leak them.
 */
export type SiteUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

/**
 * Sticky-form state for the public auth pages (`/login`, `/register`).
 *
 * On a failed submission the route re-renders the same template with the
 * user's previous values pre-filled and a per-field error map keyed by form
 * field name (e.g. `email`, `password`, `displayName`). A top-level `error`
 * carries form-wide messages like "Invalid email or password." that aren't
 * tied to a specific field.
 *
 * Themes can ignore `errors` entirely and just render `error` — the per-field
 * map is purely additive for themes that want inline messages.
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
 * The object passed to every theme template. Templates can rely on every
 * field being present (helpers like `assetUrl` and `url.post` keep theme
 * authors from hand-stitching URLs that may change).
 */
export type RenderContext = {
  site: {
    title: string;
    description: string;
    /**
     * Absolute or root-relative URL for the site favicon, or `null` when no
     * favicon has been uploaded. Themes are expected to emit a `<link rel="icon">`
     * when this is set and skip the tag otherwise — letting the browser fall
     * back to its no-favicon glyph rather than 404'ing on a phantom link.
     */
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
  /**
   * The currently-signed-in user, or `null` for anonymous visitors. Always
   * present (vs. `undefined`) so templates can write `<% if (currentUser) %>`
   * without worrying about the key being missing.
   */
  currentUser: SiteUser | null;
  /**
   * Present on `/login` and `/register` when re-rendering after a failed
   * submission, or with empty defaults on the first GET. Themes use this to
   * pre-fill the form and surface inline errors.
   */
  authForm?: AuthFormState;
  /**
   * Where the auth pages will send the user after a successful login or
   * registration. Themes round-trip this through a hidden input so the
   * destination survives the POST. Always a same-origin path.
   */
  authRedirect?: string;
  /**
   * Set after a successful comment POST so the template can show a banner.
   * `'pending'` means the comment is queued for moderation; `'approved'` means
   * it was auto-published and is already visible in the list below.
   */
  commentSubmitted?: 'pending' | 'approved' | null;
  /**
   * Present on the search route. `query` is the trimmed user input; `total`
   * lets templates show "N results for X" without re-counting `posts.length`.
   * Themes that ship a `search.eta` use this; themes without one fall back to
   * `index.eta`, which can also check for `search?.query` if it wants to
   * render the same results inline.
   */
  search?: {
    query: string;
    total: number;
  };
  year: number;
};