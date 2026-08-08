/**
 * Theme rendering pipeline. `renderTheme()` resolves the active theme + template
 * path, runs Eta, and returns a `Response` for the Astro page.
 *
 * Eta (not Astro components) because themes are uploaded at runtime, whereas
 * Astro components compile through Vite at build time. Eta's `cache` is on in
 * prod (no per-request disk hit) and off in dev (edits show up on reload).
 */

import { Eta } from 'eta';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActiveTheme } from './registry.ts';
import { getSetting } from '../settings.ts';
import { getRecaptchaConfig } from '../recaptcha.ts';
import { applyFilters, doAction } from './hooks.ts';
import { lintTemplatesDir, formatLintIssues, type EtaLintIssue } from './lint.ts';
import type {
  RenderContext,
  SitePost,
  SiteComment,
  CommentFormState,
  AuthFormState,
  SiteUser,
  ThemeRecord,
} from './types.ts';

const isProd = import.meta.env?.PROD ?? process.env.NODE_ENV === 'production';

/** One Eta instance per theme dir, lazily built. Cached in prod, fresh in dev. */
const etaCache = new Map<string, Eta>();

/** Lint result per theme slug. Cached in prod; bypassed in dev so edits re-lint. */
const lintCache = new Map<string, EtaLintIssue[]>();

/**
 * Thrown when a theme's templates fail the Eta lint pass. Carries the raw issue
 * list for structured use; the message pre-formats them for log scrapers.
 */
export class EtaTemplateError extends Error {
  override readonly name = 'EtaTemplateError';
  readonly issues: EtaLintIssue[];
  constructor(themeSlug: string, issues: EtaLintIssue[]) {
    super(`Theme "${themeSlug}" has invalid Eta templates:\n\n${formatLintIssues(issues)}`);
    this.issues = issues;
  }
}

/**
 * Lint the active theme's templates, throwing on any issue — turns a later
 * cryptic Eta SyntaxError into an upfront message naming the file + line.
 */
function ensureThemeLintsClean(theme: ThemeRecord): void {
  const cached = isProd ? lintCache.get(theme.slug) : undefined;
  const issues = cached ?? lintTemplatesDir(join(theme.dir, 'templates'));
  if (isProd) lintCache.set(theme.slug, issues);
  if (issues.length > 0) throw new EtaTemplateError(theme.slug, issues);
}

function getEta(theme: ThemeRecord): Eta {
  if (isProd) {
    const hit = etaCache.get(theme.slug);
    if (hit) return hit;
  }
  const eta = new Eta({
    views: join(theme.dir, 'templates'),
    cache: isProd,
    // useWith exposes context fields as locals (`<%= site.title %>` without `it.`).
    useWith: true,
    autoEscape: true,
  });
  etaCache.set(theme.slug, eta);
  return eta;
}

/**
 * Resolve the template file for a route key. A manifest override wins, but a
 * missing override file falls back to convention so a partial override is safe.
 */
type TemplateKey = 'index' | 'post' | 'notFound' | 'search' | 'login' | 'register';

function templateFileFor(theme: ThemeRecord, key: TemplateKey): string {
  const defaults = {
    index: 'index.eta',
    post: 'post.eta',
    notFound: '404.eta',
    search: 'search.eta',
    login: 'login.eta',
    register: 'register.eta',
  } as const;
  // `templates` is typed loosely so themes can override newer keys (login/
  // register) without extending the Zod schema; existsSync catches typos.
  const override = (theme.templates as Record<string, string | undefined> | undefined)?.[key];
  if (override && existsSync(join(theme.dir, 'templates', override))) return override;
  // Search falls back to index.eta when no dedicated results template ships —
  // index can render the same `posts` list and check `search?.query`.
  if (key === 'search' && !existsSync(join(theme.dir, 'templates', defaults.search))) {
    return defaults.index;
  }
  return defaults[key];
}

type RenderInput = {
  template: TemplateKey;
  pathname: string;
  posts?: SitePost[];
  post?: SitePost;
  comments?: SiteComment[];
  commentForm?: CommentFormState;
  commentSubmitted?: 'pending' | 'approved' | null;
  /** Populated on the /search route. Themes show "N results for query" from this. */
  search?: { query: string; total: number };
  /** The signed-in user (or null) — typically read from `Astro.locals.user`. */
  currentUser?: SiteUser | null;
  /** Sticky-form state for the /login and /register routes. */
  authForm?: AuthFormState;
  /** Post-auth redirect path that themes round-trip through a hidden input. */
  authRedirect?: string;
  status?: number;
};

/**
 * Render the active theme's template and return a Response. A 503 plain-text
 * error means no theme is installed (a broken install, not a normal request).
 */
export async function renderTheme(input: RenderInput): Promise<Response> {
  const theme = await resolveActiveTheme();
  if (!theme) {
    return new Response('No theme installed', { status: 503, headers: { 'content-type': 'text/plain' } });
  }

  // Lint before Eta sees the templates: one cheap extra pass (dev only; prod
  // caches) buys a real file+line error instead of a compiled-JS SyntaxError.
  ensureThemeLintsClean(theme);

  const [siteTitle, siteDescription, favicon, recaptcha] = await Promise.all([
    getSetting('site_title', 'Zyphora'),
    getSetting('site_description', ''),
    // Empty string == no favicon, so the template drops <link rel="icon">.
    getSetting('favicon_url', ''),
    // Only the site key reaches templates; the secret stays in recaptcha.ts.
    getRecaptchaConfig(),
  ]);

  // Filters let core (and future plugins) transform values before templates
  // see them — e.g. shortcode-expand `the_content`.
  const post = input.post
    ? {
        ...input.post,
        title: await applyFilters('the_title', input.post.title, input.post),
        contentHtml: input.post.contentHtml
          ? await applyFilters('the_content', input.post.contentHtml, input.post)
          : input.post.contentHtml,
      }
    : undefined;

  const posts = input.posts
    ? await applyFilters('posts_list', input.posts, { pathname: input.pathname })
    : undefined;

  const ctx: RenderContext = {
    site: { title: siteTitle, description: siteDescription, faviconUrl: favicon || null },
    theme: {
      slug: theme.slug,
      assetUrl: (path: string) => `/themes/${theme.slug}/${path.replace(/^\/+/, '')}`,
    },
    url: {
      pathname: input.pathname,
      home: '/',
      post: (slug: string) => `/posts/${slug}`,
      admin: '/admin',
      // URLSearchParams escapes q the way /search expects; never hand-roll `?q=`.
      search: (q: string) => `/search?${new URLSearchParams({ q }).toString()}`,
    },
    posts,
    post,
    comments: input.comments,
    commentForm: input.commentForm,
    commentSubmitted: input.commentSubmitted,
    search: input.search,
    // Project down to four public-safe fields: callers can pass the full
    // `Astro.locals.user` (password hash, permissions) without it reaching a
    // template. null (not undefined) so templates can test truthiness directly.
    currentUser: input.currentUser
      ? {
          id: input.currentUser.id,
          email: input.currentUser.email,
          displayName: input.currentUser.displayName,
          role: input.currentUser.role,
        }
      : null,
    authForm: input.authForm,
    authRedirect: input.authRedirect,
    // Expose the site key only when both keys are set — a key without its
    // secret renders a widget that can't verify, so treat that as disabled.
    recaptchaSiteKey: recaptcha.enabled ? recaptcha.siteKey : null,
    year: new Date().getFullYear(),
  };

  const file = templateFileFor(theme, input.template);
  const eta = getEta(theme);
  const html = await eta.renderAsync(file, ctx);

  await doAction('post_render', { template: input.template, theme: theme.slug });

  return new Response(html, {
    status: input.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** Drop the cached Eta instances. Called after a theme is installed/uninstalled. */
export function clearRenderCache(): void {
  etaCache.clear();
  // Drop lint results too, else a reinstalled theme reuses the old slug's cache.
  lintCache.clear();
}