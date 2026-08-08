/**
 * Post create/update/delete + form-validation schema and unique-slug helper.
 *
 * Two invariants callers rely on:
 *  1. `posts.contentHtml` always passes through `sanitizeHtml()` before storage
 *     — the public site renders it raw, so this is the only thing keeping stored
 *     XSS off the page. Never bypass.
 *  2. Slugs are unique — write `slug` only via `uniqueSlug()`.
 */
import { db, schema } from '../db/client.ts';
import { eq, and, ne } from 'drizzle-orm';
import { slugify } from './slug.ts';
import { sanitizeHtml } from './sanitize.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Shared post-form validation for the `new` and `[id]` admin pages. */
export const postFormSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  slug: z.string().trim().max(80).optional(),
  excerpt: z.string().trim().max(500).optional(),
  contentHtml: z.string().default(''),
  status: z.enum(['draft', 'published']).default('draft'),
  category: z.enum(['news', 'travel', 'gadgets', 'reviews']).default('news'),
  // Admin pages translate the HTML checkbox (present/absent) to a boolean first.
  commentsEnabled: z.boolean().default(true),
  // Tri-state moderation override: null = inherit site default, true = force
  // moderation, false = auto-approve. Pages map their string field before validating.
  moderateComments: z.union([z.boolean(), z.null()]).default(null),
});

export type PostFormInput = z.infer<typeof postFormSchema>;

/**
 * Pick an unused slug, suffixing `-2`, `-3`, … until one is free.
 * `excludeId` lets a post keep its current slug during an update instead of
 * clashing with itself.
 */
async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (true) {
    const existing = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(excludeId ? and(eq(schema.posts.slug, slug), ne(schema.posts.id, excludeId)) : eq(schema.posts.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

/** Insert a new post, sanitizing HTML on the way in. Returns the generated id. */
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
    category: input.category,
    commentsEnabled: input.commentsEnabled,
    moderateComments: input.moderateComments,
    authorId,
    publishedAt,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Update an existing post. `prevStatus`/`prevPublishedAt` preserve the original
 * publish date across draft↔published toggles (republishing must not move it).
 */
export async function updatePost(id: string, input: PostFormInput, prevStatus: 'draft' | 'published', prevPublishedAt: Date | null) {
  const baseSlug = slugify(input.slug && input.slug.length > 0 ? input.slug : input.title);
  const slug = await uniqueSlug(baseSlug, id);
  const now = new Date();
  // Keep the original date when already published; stamp now on first publish;
  // clear when reverting to draft.
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
      category: input.category,
      commentsEnabled: input.commentsEnabled,
      moderateComments: input.moderateComments,
      publishedAt,
      updatedAt: now,
    })
    .where(eq(schema.posts.id, id));
}

/** Hard-delete a post. There is no soft-delete / trash yet. */
export async function deletePostById(id: string) {
  await db.delete(schema.posts).where(eq(schema.posts.id, id));
}