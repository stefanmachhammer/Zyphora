/**
 * Post create/update/delete + the form-validation schema and unique-slug helper.
 *
 * Two invariants enforced here that the rest of the app relies on:
 *  1. `posts.contentHtml` is always run through `sanitizeHtml()` before
 *     storage. The public site renders it raw, so this is the only thing
 *     keeping stored XSS off the page. Never bypass.
 *  2. Slugs are unique. Use `uniqueSlug()` for any write that touches `slug`.
 */
import { db, schema } from '../db/client.ts';
import { eq, and, ne } from 'drizzle-orm';
import { slugify } from './slug.ts';
import { sanitizeHtml } from './sanitize.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Zod schema for the post form. Used by `new` and `[id]` admin pages so they
 * share validation rules and error messages.
 */
export const postFormSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  slug: z.string().trim().max(80).optional(),
  excerpt: z.string().trim().max(500).optional(),
  contentHtml: z.string().default(''),
  status: z.enum(['draft', 'published']).default('draft'),
  category: z.enum(['news', 'travel', 'gadgets', 'reviews']).default('news'),
  // HTML checkboxes only submit when checked; the admin pages translate
  // "field present" → true, "absent" → false before handing off to zod, so
  // the schema just needs to accept the resulting boolean.
  commentsEnabled: z.boolean().default(true),
  // Tri-state moderation override: `null` = inherit site default,
  // `true` = force moderation, `false` = auto-approve. The admin form
  // posts a string ('default' | 'require' | 'auto') which the pages
  // translate before validating.
  moderateComments: z.union([z.boolean(), z.null()]).default(null),
});

export type PostFormInput = z.infer<typeof postFormSchema>;

/**
 * Pick an unused slug, suffixing `-2`, `-3`, … until we find one.
 * `excludeId` lets a post keep its current slug during an update — without it,
 * "edit and save without changing the slug" would always think it's a clash.
 */
async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let n = 1;
  // Probe `base`, `base-2`, `base-3`, … until we find one no other post owns.
  // Cheap because slugs are unique-indexed; in practice this loop almost
  // always exits on the first iteration.
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

/** Insert a new post. Returns the generated id. Sanitizes the HTML on the way in. */
export async function createPost(input: PostFormInput, authorId: string) {
  // Prefer an explicit slug; fall back to deriving one from the title.
  const baseSlug = slugify(input.slug && input.slug.length > 0 ? input.slug : input.title);
  const slug = await uniqueSlug(baseSlug);
  const id = randomUUID();
  const now = new Date();
  // Stamp publishedAt only when we're publishing now; drafts stay null.
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
 * Update an existing post. The `prevStatus`/`prevPublishedAt` args let us
 * preserve the original publish date when toggling draft↔published↔draft —
 * republishing a post shouldn't reset its `publishedAt` if it was already
 * published before.
 */
export async function updatePost(id: string, input: PostFormInput, prevStatus: 'draft' | 'published', prevPublishedAt: Date | null) {
  // Resolve the slug, excluding this post from the uniqueness check so an
  // unchanged slug doesn't collide with itself.
  const baseSlug = slugify(input.slug && input.slug.length > 0 ? input.slug : input.title);
  const slug = await uniqueSlug(baseSlug, id);
  const now = new Date();
  // publishedAt rules: keep the original date if the post was already
  // published (republishing shouldn't move the date), stamp `now` on first
  // publish, clear it when reverting to draft.
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