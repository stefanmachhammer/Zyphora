import { db, schema } from '../db/client.ts';
import { eq, and, ne } from 'drizzle-orm';
import { slugify } from './slug.ts';
import { sanitizeHtml } from './sanitize.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const postFormSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  slug: z.string().trim().max(80).optional(),
  excerpt: z.string().trim().max(500).optional(),
  contentHtml: z.string().default(''),
  status: z.enum(['draft', 'published']).default('draft'),
});

export type PostFormInput = z.infer<typeof postFormSchema>;

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (true) {
    const existing = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(excludeId ? and(eq(schema.posts.slug, slug), ne(schema.posts.id, excludeId)) : eq(schema.posts.slug, slug))
      .get();
    if (!existing) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

export async function createPost(input: PostFormInput, authorId: string) {
  const baseSlug = slugify(input.slug && input.slug.length > 0 ? input.slug : input.title);
  const slug = await uniqueSlug(baseSlug);
  const id = randomUUID();
  const now = new Date();
  const publishedAt = input.status === 'published' ? now : null;

  await db.insert(schema.posts).values({
    id,
    slug,
    title: input.title,
    excerpt: input.excerpt ?? null,
    contentHtml: sanitizeHtml(input.contentHtml),
    status: input.status,
    authorId,
    publishedAt,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updatePost(id: string, input: PostFormInput, prevStatus: 'draft' | 'published', prevPublishedAt: Date | null) {
  const baseSlug = slugify(input.slug && input.slug.length > 0 ? input.slug : input.title);
  const slug = await uniqueSlug(baseSlug, id);
  const now = new Date();
  const publishedAt =
    input.status === 'published'
      ? prevStatus === 'published' && prevPublishedAt
        ? prevPublishedAt
        : now
      : null;

  await db
    .update(schema.posts)
    .set({
      slug,
      title: input.title,
      excerpt: input.excerpt ?? null,
      contentHtml: sanitizeHtml(input.contentHtml),
      status: input.status,
      publishedAt,
      updatedAt: now,
    })
    .where(eq(schema.posts.id, id));
}

export async function deletePostById(id: string) {
  await db.delete(schema.posts).where(eq(schema.posts.id, id));
}