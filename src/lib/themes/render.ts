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

const etaCache = new Map<string, Eta>();

const lintCache = new Map<string, EtaLintIssue[]>();

export class EtaTemplateError extends Error {
  override readonly name = 'EtaTemplateError';
  readonly issues: EtaLintIssue[];
  constructor(themeSlug: string, issues: EtaLintIssue[]) {
    super(`Theme "${themeSlug}" has invalid Eta templates:\n\n${formatLintIssues(issues)}`);
    this.issues = issues;
  }
}

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
  // Loose cast so themes can override keys the Zod schema doesn't list (login/register).
  const override = (theme.templates as Record<string, string | undefined> | undefined)?.[key];
  if (override && existsSync(join(theme.dir, 'templates', override))) return override;
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
  search?: { query: string; total: number };
  currentUser?: SiteUser | null;
  authForm?: AuthFormState;
  authRedirect?: string;
  status?: number;
};

export async function renderTheme(input: RenderInput): Promise<Response> {
  const theme = await resolveActiveTheme();
  if (!theme) {
    return new Response('No theme installed', { status: 503, headers: { 'content-type': 'text/plain' } });
  }

  ensureThemeLintsClean(theme);

  const [siteTitle, siteDescription, favicon, recaptcha] = await Promise.all([
    getSetting('site_title', 'Zyphora'),
    getSetting('site_description', ''),
    getSetting('favicon_url', ''),
    getRecaptchaConfig(),
  ]);

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
      search: (q: string) => `/search?${new URLSearchParams({ q }).toString()}`,
    },
    posts,
    post,
    comments: input.comments,
    commentForm: input.commentForm,
    commentSubmitted: input.commentSubmitted,
    search: input.search,
    // Callers may pass the full `Astro.locals.user` (password hash etc.); only
    // these four fields may reach a template.
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

export function clearRenderCache(): void {
  etaCache.clear();
  lintCache.clear();
}