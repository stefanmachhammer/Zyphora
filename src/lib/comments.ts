/**
 * Comments — guest discussion attached to published posts.
 *
 * Two invariants this module enforces that every caller relies on:
 *  1. Comment `content` is plain text. We strip every HTML tag (and the
 *     content of <script>/<style> blocks) on the way in. The public template
 *     escapes on render and converts \n to <br>. Do NOT route comments
 *     through `sanitizeHtml()` — that helper allows a rich HTML allowlist
 *     that's appropriate for trusted post bodies, not for guest input.
 *  2. Every new comment lands in `pending`. A moderator (admin/editor) has
 *     to flip status to `approved` before it shows up publicly.
 *
 * Statuses form a simple workflow: pending → approved (visible) | spam
 * (hidden) | trash (hidden, deletable). Hard delete is only used from
 * trash so a misclick never destroys data unrecoverably.
 */
import { db, schema } from '../db/client.ts';
import { eq, asc, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Comment } from '../db/schema.ts';

/**
 * Zod schema for the public comment form. Trims strings up-front so
 * downstream code doesn't have to think about leading/trailing whitespace.
 *
 * `authorUrl` is normalized: empty string becomes `undefined` (so the DB
 * stores NULL instead of an empty string, and template-side "is there a URL"
 * checks stay simple). Non-empty values must be a real http/https URL —
 * keeping the protocol allowlist tight prevents `javascript:` smuggling
 * if some future template ever forgets to escape an href.
 */
export const commentFormSchema = z.object({
  postId: z.string().uuid({ message: 'Invalid post.' }),
  authorName: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  authorEmail: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  authorUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    // Normalize empty string to undefined so the DB stores NULL.
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .refine(
      (v) => {
        if (!v) return true;
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'Website must be an http(s) URL' },
    ),
  content: z.string().trim().min(1, 'Comment is required').max(5000, 'Comment is too long'),
});

export type CommentFormInput = z.infer<typeof commentFormSchema>;

/**
 * Strip every HTML tag from `s`, including the *contents* of <script> and
 * <style> blocks (otherwise their text would leak through as visible
 * characters). Also collapse HTML entities back to a safe canonical form so
 * that, for example, `&lt;script&gt;` doesn't survive as encoded markup that
 * a browser might re-interpret if some future template mishandles it.
 *
 * Comment text is rendered through Eta's autoEscape, so we don't need
 * sophisticated sanitization — the goal here is just to keep the *stored*
 * value plain text, not pseudo-HTML.
 */
function stripHtml(s: string): string {
  return s
    // Drop script/style tag content entirely.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Drop every other tag.
    .replace(/<[^>]+>/g, '')
    // Decode the most common HTML entities so they round-trip as plain text.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

type CreateMeta = {
  ipAddress?: string;
  userAgent?: string;
  /**
   * Effective intake status. Defaults to `pending` so callers that don't care
   * keep the historical behavior (queue everything). The route layer resolves
   * the per-post override + site-wide default and passes the result here —
   * keeping the policy decision out of this module so `createComment` stays a
   * dumb writer.
   */
  initialStatus?: 'pending' | 'approved';
};

/**
 * Insert a new comment. Returns the generated id and the recorded status so
 * the caller can branch its success banner ("posted" vs "awaiting moderation").
 */
export async function createComment(
  input: CommentFormInput,
  meta: CreateMeta = {},
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const id = randomUUID();
  // Strip HTML from content; trim again post-strip in case removed tags
  // left leading/trailing whitespace.
  const content = stripHtml(input.content).trim();
  const status = meta.initialStatus ?? 'pending';
  await db.insert(schema.comments).values({
    id,
    postId: input.postId,
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    authorUrl: input.authorUrl ?? null,
    content,
    status,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { id, status };
}

/**
 * Approved comments for one post, oldest-first — that's the conventional
 * comment-thread reading order (and matches WordPress's default).
 */
export async function getApprovedComments(postId: string): Promise<Comment[]> {
  return db
    .select()
    .from(schema.comments)
    .where(sql`${schema.comments.postId} = ${postId} AND ${schema.comments.status} = 'approved'`)
    .orderBy(asc(schema.comments.createdAt))
    .all();
}

/** Row shape returned by the moderation listing — comment + post title for context. */
export type ModerationRow = Comment & {
  postTitle: string | null;
  postId: string;
};

/**
 * Admin moderation listing. If `status` is given, filter to it; otherwise
 * return everything. Newest first so the queue surfaces freshly-submitted
 * spam at the top.
 */
export async function getCommentsByStatus(
  status?: 'pending' | 'approved' | 'spam' | 'trash',
): Promise<ModerationRow[]> {
  const baseQuery = db
    .select({
      id: schema.comments.id,
      postId: schema.comments.postId,
      authorName: schema.comments.authorName,
      authorEmail: schema.comments.authorEmail,
      authorUrl: schema.comments.authorUrl,
      content: schema.comments.content,
      status: schema.comments.status,
      ipAddress: schema.comments.ipAddress,
      userAgent: schema.comments.userAgent,
      createdAt: schema.comments.createdAt,
      postTitle: schema.posts.title,
    })
    .from(schema.comments)
    .leftJoin(schema.posts, eq(schema.posts.id, schema.comments.postId));

  const ordered = status
    ? baseQuery.where(eq(schema.comments.status, status)).orderBy(desc(schema.comments.createdAt))
    : baseQuery.orderBy(desc(schema.comments.createdAt));

  return ordered.all();
}

/**
 * Per-status counts for the moderation tabs and the sidebar pending badge.
 * Single SQL query rather than four — cheaper and atomic. Statuses that have
 * never been used still appear in the result with a count of 0 thanks to the
 * default-zero merge below.
 */
export async function getCommentCounts(): Promise<{
  pending: number;
  approved: number;
  spam: number;
  trash: number;
}> {
  const rows = await db
    .select({
      status: schema.comments.status,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(schema.comments)
    .groupBy(schema.comments.status)
    .all();

  const out = { pending: 0, approved: 0, spam: 0, trash: 0 };
  for (const r of rows) {
    if (r.status in out) out[r.status as keyof typeof out] = Number(r.count);
  }
  return out;
}

/** Moderator action — flip a comment to a new workflow state. */
export async function setCommentStatus(
  id: string,
  status: 'pending' | 'approved' | 'spam' | 'trash',
): Promise<void> {
  await db.update(schema.comments).set({ status }).where(eq(schema.comments.id, id));
}

/**
 * Hard delete. Reserved for the trash tab — soft delete (status='trash') is
 * the normal "remove" path so misclicks remain reversible.
 */
export async function deleteComment(id: string): Promise<void> {
  await db.delete(schema.comments).where(eq(schema.comments.id, id));
}