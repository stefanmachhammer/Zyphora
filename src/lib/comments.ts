import { db, schema } from '../db/client.ts';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import DOMPurify from 'isomorphic-dompurify';
import type { Comment } from '../db/schema.ts';

export const commentFormSchema = z.object({
  postId: z.string().uuid({ message: 'Invalid post.' }),
  authorName: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  authorEmail: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  authorUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
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

// DOMPurify with an empty allowlist, not a regex: a single-pass regex can be tricked by
// nested tags like `<scr<script>ipt>` into reassembling the markup it removed.
function stripHtml(s: string): string {
  const text = DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  return text
    // `&amp;` must decode last or `&amp;lt;` double-unescapes to `<`. DOMPurify emits
    // `&nbsp;` as literal U+00A0, hence both replaces.
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

type CreateMeta = {
  ipAddress?: string;
  userAgent?: string;
  initialStatus?: 'pending' | 'approved';
};

export async function createComment(
  input: CommentFormInput,
  meta: CreateMeta = {},
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const id = randomUUID();
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

export async function getApprovedComments(postId: string): Promise<Comment[]> {
  return await db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.postId, postId), eq(schema.comments.status, 'approved')))
    .orderBy(asc(schema.comments.createdAt));
}

export type ModerationRow = Comment & {
  postTitle: string | null;
  postId: string;
};

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

  return await ordered;
}

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
    .groupBy(schema.comments.status);

  const out = { pending: 0, approved: 0, spam: 0, trash: 0 };
  for (const r of rows) {
    if (r.status in out) out[r.status as keyof typeof out] = Number(r.count);
  }
  return out;
}

export async function setCommentStatus(
  id: string,
  status: 'pending' | 'approved' | 'spam' | 'trash',
): Promise<void> {
  await db.update(schema.comments).set({ status }).where(eq(schema.comments.id, id));
}

export async function deleteComment(id: string): Promise<void> {
  await db.delete(schema.comments).where(eq(schema.comments.id, id));
}