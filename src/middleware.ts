import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getUserBySession, clearSessionCookie } from './lib/auth.ts';

export const onRequest = defineMiddleware(async (ctx, next) => {
  const sessionId = ctx.cookies.get(SESSION_COOKIE)?.value;
  ctx.locals.user = null;
  ctx.locals.sessionId = null;

  if (sessionId) {
    const user = await getUserBySession(sessionId);
    if (user) {
      ctx.locals.user = user;
      ctx.locals.sessionId = sessionId;
    } else {
      clearSessionCookie(ctx);
    }
  }

  const url = new URL(ctx.request.url);
  const path = url.pathname;
  const needsAuth = path.startsWith('/admin') && path !== '/admin/login';

  if (needsAuth && !ctx.locals.user) {
    const redirectTo = encodeURIComponent(path + url.search);
    return ctx.redirect(`/admin/login?redirect=${redirectTo}`);
  }

  return next();
});