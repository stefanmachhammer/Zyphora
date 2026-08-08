/**
 * Public logout — drops the session row, clears the cookie, redirects to `/`
 * (unlike `/admin/logout` which lands on the admin login). `GET = POST` so a
 * stale session reaching here via the back button still logs out.
 */
import type { APIRoute } from 'astro';
import { deleteSession, clearSessionCookie } from '../lib/auth.ts';

export const POST: APIRoute = async (ctx) => {
  if (ctx.locals.sessionId) await deleteSession(ctx.locals.sessionId);
  clearSessionCookie(ctx);
  return ctx.redirect('/');
};

export const GET = POST;
