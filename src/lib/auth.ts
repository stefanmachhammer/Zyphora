/**
 * Authentication primitives — password hashing, session lifecycle, cookie
 * helpers, and the small role-check predicates used by admin pages.
 *
 * Session model: server-side opaque tokens stored in the `sessions` table.
 * Tokens are 24 random bytes (base64url), so collisions are not a concern.
 * Cookies are HttpOnly + SameSite=Lax + Secure-in-prod. Sessions are stored
 * in SQLite rather than as signed JWTs because that's simpler for a
 * single-node deploy; horizontally-scaled deploys would want to move sessions
 * to Redis or switch to a stateless token strategy first.
 *
 * Always go through these helpers when touching cookies — rolling your own
 * elsewhere risks drift in TTL / cookie attributes (HttpOnly, SameSite,
 * Secure-in-prod) and would silently weaken auth.
 */
import { db, schema } from '../db/client.ts';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { APIContext } from 'astro';
import type { User } from '../db/schema.ts';

export const SESSION_COOKIE = 'zyphora_session';
// 30 days. Matches typical "remember me" defaults; expired sessions are
// purged lazily by `getUserBySession` so a fresh login always gets a clean TTL.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/** Hash a plaintext password with Argon2id (default parameters from @node-rs/argon2). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Verify a plaintext password against a stored Argon2 hash. Constant-time. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/**
 * Create a new session for `userId` and return the opaque token + its expiry.
 * The caller is responsible for setting the cookie via `setSessionCookie`.
 */
export async function createSession(userId: string) {
  const id = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

/** Drop a single session row by id (used on logout and on stale lookups). */
export async function deleteSession(id: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

/**
 * Resolve a session token to its user. Returns null for unknown or expired
 * sessions; expired rows are deleted as a side effect so the table doesn't
 * grow forever even without a separate sweeper running.
 */
export async function getUserBySession(sessionId: string): Promise<User | null> {
  const row = await db
    .select({ user: schema.users, session: schema.sessions })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, sessionId))
    .get();

  if (!row) return null;
  if (row.session.expiresAt.getTime() < Date.now()) {
    await deleteSession(sessionId);
    return null;
  }
  return row.user;
}

/**
 * Bulk-delete expired sessions. Not wired to a schedule yet — `getUserBySession`
 * cleans up on access, which is enough for low traffic. Exported so a future
 * cron / startup hook can call it.
 */
export async function purgeExpiredSessions() {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}

/** Write the session cookie. Always use this — keeps attributes in one place. */
export function setSessionCookie(ctx: APIContext, sessionId: string, expiresAt: Date) {
  ctx.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    expires: expiresAt,
  });
}

/** Remove the session cookie (logout, or on a session that no longer exists). */
export function clearSessionCookie(ctx: APIContext) {
  ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
}

export type Role = 'admin' | 'editor' | 'author';

/** Only admins can create/modify users. */
export function canManageUsers(user: User | null): boolean {
  return user?.role === 'admin';
}

/**
 * Editorial authorization for posts.
 * - admins and editors can edit any post
 * - authors can edit only their own
 */
export function canEditPost(user: User | null, post: { authorId: string }): boolean {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'editor') return true;
  return user.id === post.authorId;
}

/**
 * Moderation rights for the comment queue. Authors don't get to moderate —
 * they can only edit their own posts, and giving them queue access would
 * surface every commenter's email and IP across every post in the system.
 */
export function canModerateComments(user: User | null): boolean {
  return user?.role === 'admin' || user?.role === 'editor';
}

/** Centralized so we can swap the ID strategy (e.g. ULID) in one place later. */
export function newUserId(): string {
  return randomUUID();
}