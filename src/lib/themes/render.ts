/**
 * Theme rendering pipeline.
 *
 * Public pages call `renderTheme()` with a template name + a context object;
 * we look up the active theme, resolve the template path, run Eta, and return
 * a `Response` ready to be returned from the Astro page.
 *
 * Why Eta and not Astro components: themes need to be uploadable at runtime,
 * and Astro components compile through Vite at build time. Eta is a small
 * runtime template engine with includes/layouts and a PHP-template feel.
 *
 * Caching: Eta's `cache` option is enabled in production so we don't hit the
 * disk on every request. In dev we keep it off so theme edits show up
 * immediately on reload.
 */

import { Eta } from 'eta';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActiveTheme } from './registry.ts';
import { getSetting } from '../settings.ts';
import { applyFilters, doAction } from './hooks.ts';
import type { RenderContext, SitePost, SiteComment, CommentFormState, ThemeRecord } from './types.ts';

const isProd = import.meta.env?.PROD ?? process.env.NODE_ENV === 'production';

/** One Eta instance per theme dir, lazily built. Cached in prod, fresh in dev. */
const etaCache = new Map<string, Eta>();

function getEta(theme: ThemeRecord): Eta {
  if (isProd) {
    const hit = etaCache.get(theme.slug);
    if (hit) return hit;
  }
  const eta = new Eta({
    views: join(theme.dir, 'templates'),
    cache: isProd,
    // useWith exposes context fields as locals inside templates (e.g. `<%= site.title %>`
    // works without a `it.` prefix). Matches the WordPress template-tag feel.
    useWith: true,
    autoEscape: true,
  });
  etaCache.set(theme.slug, eta);
  return eta;
}

/**
 * Resolve the file name a theme exposes for a given route key. A manifest can
 * override defaults; if the override file is missing on disk we fall back to
 * the convention so a partial override doesn't break the site.
 */
function templateFileFor(theme: ThemeRecord, key: 'index' | 'post' | 'notFound'): string {
  const defaults = { index: 'index.eta', post: 'post.eta', notFound: '404.eta' } as const;
  const override = theme.templates?.[key];
  if (override && existsSync(join(theme.dir, 'templates', override))) return override;
  return defaults[key];
}

type RenderInput = {
  template: 'index' | 'post' | 'notFound';
  pathname: string;
  posts?: SitePost[];
  post?: SitePost;
  comments?: SiteComment[];
  commentForm?: CommentFormState;
  commentSubmitted?: 'pending' | 'approved' | null;
  status?: number;
};

/**
 * Render the active theme's template for `template` and return a Response.
 *
 * Returns a 503 with a plain-text error if no theme is installed at all —
 * that's a broken install, not a normal request, so we don't try to be cute.
 */
export async function renderTheme(input: RenderInput): Promise<Response> {
  const theme = await resolveActiveTheme();
  if (!theme) {
    return new Response('No theme installed', { status: 503, headers: { 'content-type': 'text/plain' } });
  }

  const [siteTitle, siteDescription] = await Promise.all([
    getSetting('site_title', 'Zyphora'),
    getSetting('site_description', ''),
  ]);

  // Filters let core code (and, eventually, plugins) transform values before
  // they hit a template — e.g. wrap `the_content` with shortcodes, prepend a
  // newsletter form to `post_excerpt`, etc.
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
    site: { title: siteTitle, description: siteDescription },
    theme: {
      slug: theme.slug,
      assetUrl: (path: string) => `/themes/${theme.slug}/${path.replace(/^\/+/, '')}`,
    },
    url: {
      pathname: input.pathname,
      home: '/',
      post: (slug: string) => `/posts/${slug}`,
      admin: '/admin',
    },
    posts,
    post,
    comments: input.comments,
    commentForm: input.commentForm,
    commentSubmitted: input.commentSubmitted,
    year: new Date().getFullYear(),
  };

  const file = templateFileFor(theme, input.template);
  const eta = getEta(theme);
  // Eta's renderAsync supports both sync and async helpers in templates.
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
}