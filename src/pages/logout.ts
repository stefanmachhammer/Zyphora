/**
 * Public logout endpoint — drops the session row, clears the cookie, then
 * sends the visitor back to the home page.
 *
 * Mirrors `/admin/logout` but lands on `/` instead of the admin login (this
 * one is reached from the public site's nav, where dropping into the admin
 * card would be jarring). `GET = POST` for the same reason as the admin
 * variant: a stale session navigating here via the back button should still
 * log out cleanly.
 */
import type { APIRoute } from 'astro';
import { deleteSession, clearSessionCookie } from '../lib/auth.ts';

export const POST: APIRoute = async (ctx) => {
  if (ctx.locals.sessionId) await deleteSession(ctx.locals.sessionId);
  clearSessionCookie(ctx);
  return ctx.redirect('/');
};

export const GET = POST;
