import type { APIRoute } from 'astro';
import { deleteSession, clearSessionCookie } from '../../lib/auth.ts';

export const POST: APIRoute = async (ctx) => {
  if (ctx.locals.sessionId) await deleteSession(ctx.locals.sessionId);
  clearSessionCookie(ctx);
  return ctx.redirect('/admin/login');
};

export const GET = POST;