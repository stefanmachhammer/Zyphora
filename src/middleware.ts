/**
 * Global middleware — runs on every request before the page handler.
 *
 * Two responsibilities:
 *   1. Resolve the session cookie into `Astro.locals.user` (or null).
 *      Pages downstream can read this without re-querying.
 *   2. Gate `/admin/*` (except `/admin/login`) behind authentication, with
 *      a redirect that preserves the original path so the user lands back
 *      where they were trying to go after logging in.
 *
 * Authorization (role checks for actions like "delete user") is per-page,
 * not here — middleware only handles "is anyone logged in?".
 */
import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getUserBySession, clearSessionCookie } from './lib/auth.ts';
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
  // Resolve the session cookie into a user record. Default to "anonymous";
  // we only flip these fields if the cookie validates.
  const sessionId = ctx.cookies.get(SESSION_COOKIE)?.value;
  ctx.locals.user = null;
  ctx.locals.sessionId = null;

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

  // Gate `/admin/*` behind authentication. The login page itself is exempt
  // (otherwise users could never get in).
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  const needsAuth = path.startsWith('/admin') && path !== '/admin/login';

  if (needsAuth && !ctx.locals.user) {
    // Round-trip the original URL through `?redirect=` so post-login lands
    // the user back where they were trying to go.
    const redirectTo = encodeURIComponent(path + url.search);
    return ctx.redirect(`/admin/login?redirect=${redirectTo}`);
  }

  return next();
});