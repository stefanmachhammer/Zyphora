import type { APIRoute } from 'astro';
import { db, schema } from '../../../../db/client.ts';
import { eq } from 'drizzle-orm';
import { canEditPost } from '../../../../lib/auth.ts';
import { deletePostById } from '../../../../lib/posts.ts';

export const POST: APIRoute = async (ctx) => {
  const { id } = ctx.params;
  if (!id) return ctx.redirect('/admin/posts');

  const post = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).get();
  if (!post) return ctx.redirect('/admin/posts');

  if (!canEditPost(ctx.locals.user, post)) {
    return new Response('Forbidden', { status: 403 });
  }

  await deletePostById(id);
  return ctx.redirect('/admin/posts');
};