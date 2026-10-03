import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getUserBySession, clearSessionCookie } from './lib/auth.ts';
import { getInstallState } from './lib/install.ts';
import { shouldTrack, recordPageview, clientIp } from './lib/analytics.ts';
import './lib/banner.ts';
// Side-effect import: fire-and-forget release check. Opt out with ZYPHORA_NO_UPDATE_CHECK=1.
import './lib/update-check.ts';

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  const state = await getInstallState();
  const isInstallPath = path === '/install' || path.startsWith('/install/');
  // Asset paths bypass the install gate so the installer's own styles/scripts load in dev.
  const isAssetPath =
    path.startsWith('/_astro/') ||
    path.startsWith('/_image') ||
    path === '/favicon.ico' ||
    path === '/favicon.png' ||
    path === '/robots.txt';

  if (state === 'installed' && isInstallPath) {
    return new Response('Not found', { status: 404 });
  }

  if (state !== 'installed' && !isInstallPath && !isAssetPath) {
    return ctx.redirect('/install');
  }

  // Session lookup is skipped until installed: the DB may not exist yet.
  ctx.locals.user = null;
  ctx.locals.sessionId = null;

  if (state === 'installed') {
    const sessionId = ctx.cookies.get(SESSION_COOKIE)?.value;
    if (sessionId) {
      const user = await getUserBySession(sessionId);
      if (user) {
        ctx.locals.user = user;
        ctx.locals.sessionId = sessionId;
      } else {
        clearSessionCookie(ctx);
      }
    }
  }

  const needsAuth = path.startsWith('/admin') && path !== '/admin/login';

  if (needsAuth && !ctx.locals.user) {
    const redirectTo = encodeURIComponent(path + url.search);
    return ctx.redirect(`/admin/login?redirect=${redirectTo}`);
  }

  if (state !== 'installed') return next();

  const response = await next();

  // Tracking is decided after render (real status, page-set `trackedPostId`) and the
  // write is not awaited, so page latency never depends on the analytics insert.
  try {
    const headers = ctx.request.headers;
    const userAgent = headers.get('user-agent') ?? '';
    const track = await shouldTrack({
      method: ctx.request.method,
      path,
      status: response.status,
      contentType: response.headers.get('content-type'),
      userAgent,
      dnt: headers.get('dnt'),
      gpc: headers.get('sec-gpc'),
      purpose: headers.get('sec-purpose') ?? headers.get('purpose'),
      user: ctx.locals.user,
    });
    if (track) {
      void recordPageview({
        // Canonical path, so `/posts/Foo`, `/posts/foo/` and `/posts/%66oo` count as one row.
        path: ctx.locals.trackedPath ?? path,
        postId: ctx.locals.trackedPostId ?? null,
        referer: headers.get('referer'),
        selfHost: url.hostname,
        userAgent,
        ip: clientIp(ctx),
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[analytics] tracking decision failed:', err instanceof Error ? err.message : err);
  }

  return response;
});
