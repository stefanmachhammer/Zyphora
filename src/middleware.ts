/**
 * Global middleware — runs on every request before the page handler.
 *
 * Three responsibilities, in order:
 *   1. Gate the entire site behind the web installer until the CMS has
 *      been set up. A fresh checkout with no `.env` boots cleanly, but
 *      every request that isn't to `/install/*` redirects there until
 *      DB credentials are written and the bootstrap admin exists. Once
 *      installed, `/install/*` returns 404 to keep stray visitors out.
 *   2. Resolve the session cookie into `Astro.locals.user` (or null).
 *      Pages downstream can read this without re-querying.
 *   3. Gate `/admin/*` (except `/admin/login`) behind authentication, with
 *      a redirect that preserves the original path so the user lands back
 *      where they were trying to go after logging in.
 *
 * Authorization (role checks for actions like "delete user") is per-page,
 * not here — middleware only handles "is anyone logged in?".
 */
import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getUserBySession, clearSessionCookie } from './lib/auth.ts';
import { getInstallState } from './lib/install.ts';
// Side-effect import: prints the boot watermark exactly once when Astro
// loads the middleware module at server startup. The module self-guards
// against duplicate prints during dev HMR.
import './lib/banner.ts';
// Side-effect import: kicks off a one-shot, fire-and-forget check against
// the GitHub releases API and prints a notice if a newer version of the
// CMS is available. Same dev-HMR guard as the banner. Opt out with
// ZYPHORA_NO_UPDATE_CHECK=1.
import './lib/update-check.ts';

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // ── Install gate ────────────────────────────────────────────────
  // Run before anything else. If the CMS hasn't been fully set up,
  // funnel every request to /install; if it has been set up, /install
  // itself is locked away. This keeps the wizard from leaking onto a
  // running site and keeps a fresh checkout reachable without env vars.
  //
  // Asset paths (Vite-emitted JS/CSS, favicons, the on-demand image
  // optimizer) bypass the gate so the installer page's own styles and
  // scripts actually load when middleware runs for them in dev mode.
  const state = await getInstallState();
  const isInstallPath = path === '/install' || path.startsWith('/install/');
  const isAssetPath =
    path.startsWith('/_astro/') ||
    path.startsWith('/_image') ||
    path === '/favicon.ico' ||
    path === '/favicon.png' ||
    path === '/robots.txt';

  if (state === 'installed' && isInstallPath) {
    // No second-chance reruns. The operator can wipe `.env` (or drop the
    // admin user) on the server to retry, but we won't expose the wizard
    // to a random visitor.
    return new Response('Not found', { status: 404 });
  }

  if (state !== 'installed' && !isInstallPath && !isAssetPath) {
    // Send the user to the wizard. The installer page itself decides
    // which step to render based on `getInstallState()`.
    return ctx.redirect('/install');
  }

  // ── Session resolution ──────────────────────────────────────────
  // Resolve the session cookie into a user record. Default to "anonymous";
  // we only flip these fields if the cookie validates. When we're inside
  // the installer flow the DB may not be ready yet, so skip this entirely
  // — `Astro.locals.user` stays null and the installer pages don't read it.
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
        // Cookie present but stale/expired — clear it so the browser stops
        // sending it on every subsequent request.
        clearSessionCookie(ctx);
      }
    }
  }

  // ── Admin auth gate ─────────────────────────────────────────────
  // Gate `/admin/*` behind authentication. The login page itself is exempt
  // (otherwise users could never get in).
  const needsAuth = path.startsWith('/admin') && path !== '/admin/login';

  if (needsAuth && !ctx.locals.user) {
    // Round-trip the original URL through `?redirect=` so post-login lands
    // the user back where they were trying to go.
    const redirectTo = encodeURIComponent(path + url.search);
    return ctx.redirect(`/admin/login?redirect=${redirectTo}`);
  }

  return next();
});
