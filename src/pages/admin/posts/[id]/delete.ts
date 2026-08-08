/**
 * Delete-post endpoint — POST-only so a stray GET (prefetch, accidental
 * navigation) can't destroy data. Reuses `canEditPost` so authors can only
 * delete posts they could also edit.
 */
import type { APIRoute } from 'astro';
import { db, schema } from '../../../../db/client.ts';
import { eq } from 'drizzle-orm';
import { canEditPost } from '../../../../lib/auth.ts';
import { deletePostById } from '../../../../lib/posts.ts';

export const POST: APIRoute = async (ctx) => {
  const { id } = ctx.params;
  if (!id) return ctx.redirect('/admin/posts');

  const postRows = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
  const post = postRows[0];
  if (!post) return ctx.redirect('/admin/posts');

  if (!canEditPost(ctx.locals.user, post)) {
    return new Response('Forbidden', { status: 403 });
  }

  await deletePostById(id);
  return ctx.redirect('/admin/posts');
};