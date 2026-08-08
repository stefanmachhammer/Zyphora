/**
 * Global middleware — runs on every request. Three responsibilities in order:
 * install gate, session resolution, and the `/admin/*` auth gate.
 * Authorization (role checks) is per-page — this only handles "is anyone logged in?".
 */
import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getUserBySession, clearSessionCookie } from './lib/auth.ts';
import { getInstallState } from './lib/install.ts';
import './lib/banner.ts';
// Fire-and-forget check of the GitHub releases API. Opt out with ZYPHORA_NO_UPDATE_CHECK=1.
import './lib/update-check.ts';

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // ── Install gate ────────────────────────────────────────────────
  // Until setup completes, funnel every request to /install; once installed,
  // /install is locked away. Asset paths bypass so the installer's own
  // styles/scripts load in dev mode.
  const state = await getInstallState();
  const isInstallPath = path === '/install' || path.startsWith('/install/');
  const isAssetPath =
    path.startsWith('/_astro/') ||
    path.startsWith('/_image') ||
    path === '/favicon.ico' ||
    path === '/favicon.png' ||
    path === '/robots.txt';

  if (state === 'installed' && isInstallPath) {
    // No reruns via the web. To retry, wipe `.env` (or the admin user) on the server.
    return new Response('Not found', { status: 404 });
  }

  if (state !== 'installed' && !isInstallPath && !isAssetPath) {
    return ctx.redirect('/install');
  }

  // ── Session resolution ──────────────────────────────────────────
  // Skipped until installed: the DB may not be ready, and installer pages
  // don't read `user`.
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
        // Cookie present but stale/expired — clear it.
        clearSessionCookie(ctx);
      }
    }
  }

  // ── Admin auth gate ─────────────────────────────────────────────
  // Gate `/admin/*`; the login page is exempt.
  const needsAuth = path.startsWith('/admin') && path !== '/admin/login';

  if (needsAuth && !ctx.locals.user) {
    // Preserve the original URL so post-login returns the user there.
    const redirectTo = encodeURIComponent(path + url.search);
    return ctx.redirect(`/admin/login?redirect=${redirectTo}`);
  }

  return next();
});
