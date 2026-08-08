/**
 * Authentication primitives — password hashing, session lifecycle, cookie
 * helpers, and the role-check predicates used by admin pages.
 *
 * Sessions are server-side opaque tokens (24 random bytes, base64url) in the
 * `sessions` MySQL table rather than signed JWTs — simpler for a single-node
 * deploy; scaling out would want Redis or a stateless token strategy first.
 * Always go through the cookie helpers here so TTL and cookie attributes
 * (HttpOnly, SameSite, Secure-in-prod) stay consistent.
 */
import { db, schema } from '../db/client.ts';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { APIContext } from 'astro';
import type { User } from '../db/schema.ts';

/**
 * The full set of permission keys the CMS understands — the single place
 * permissions are declared. The admin UI renders a checkbox per entry and
 * `roles.permissions` stores any subset. Renaming/removing an entry is a
 * breaking change for stored role rows.
 */
export const PERMISSION_KEYS = [
  'manage_users',
  'manage_roles',
  'manage_posts_any',
  'manage_posts_own',
  'manage_media',
  'manage_themes',
  'manage_settings',
] as const;
export type Permission = typeof PERMISSION_KEYS[number];

/** Human-readable labels for the role-edit checkboxes. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_users: 'Manage users',
  manage_roles: 'Manage roles',
  manage_posts_any: 'Edit any post',
  manage_posts_own: 'Edit own posts',
  manage_media: 'Manage media',
  manage_themes: 'Manage themes',
  manage_settings: 'Manage site settings',
};

/**
 * The user record on `Astro.locals.user`: the DB row plus its resolved
 * permission set (joined once per request by `getUserBySession`, so pages can
 * check `hasPermission(...)` without further queries).
 */
export type SessionUser = User & { permissions: ReadonlySet<string> };

export const SESSION_COOKIE = 'zyphora_session';
// 30 days; expired sessions are purged lazily by `getUserBySession`.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Constant-time verify against a stored Argon2 hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/**
 * Create a session for `userId` and return the opaque token + expiry.
 * Caller must set the cookie via `setSessionCookie`.
 */
export async function createSession(userId: string) {
  const id = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

/** Drop a single session row by id (logout, stale lookups). */
export async function deleteSession(id: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

/**
 * Resolve a session token to its user, or null if unknown/expired. Expired
 * rows are deleted as a side effect (lazy cleanup, no separate sweeper).
 *
 * Left-joins the role row so a user whose role was deleted still resolves
 * (with an empty permission set) instead of failing the lookup.
 */
export async function getUserBySession(sessionId: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      user: schema.users,
      session: schema.sessions,
      rolePermissions: schema.roles.permissions,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .leftJoin(schema.roles, eq(schema.roles.slug, schema.users.role))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() < Date.now()) {
    await deleteSession(sessionId);
    return null;
  }
  const permissions: ReadonlySet<string> = new Set(row.rolePermissions ?? []);
  return { ...row.user, permissions };
}

/**
 * Bulk-delete expired sessions. Not scheduled yet — `getUserBySession` cleans
 * up on access; exported for a future cron / startup hook.
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

/** True iff the user's role grants `key`. Anonymous → always false. */
export function hasPermission(user: SessionUser | null, key: Permission): boolean {
  return !!user && user.permissions.has(key);
}

export function canManageUsers(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_users');
}

export function canManageRoles(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_roles');
}

export function canManageMedia(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_media');
}

export function canManageSettings(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_settings');
}

export function canManageThemes(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_themes');
}

/** Either post permission qualifies — a new post's author is always the current user. */
export function canCreatePost(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_posts_own') || hasPermission(user, 'manage_posts_any');
}

/**
 * True for any staff account (holds at least one permission). Fences the admin
 * dashboard off from permission-less self-registered subscribers.
 */
export function hasAnyPermission(user: SessionUser | null): boolean {
  return !!user && user.permissions.size > 0;
}

/** `manage_posts_any` edits any post; `manage_posts_own` edits only own posts. */
export function canEditPost(user: SessionUser | null, post: { authorId: string }): boolean {
  if (!user) return false;
  if (user.permissions.has('manage_posts_any')) return true;
  return user.permissions.has('manage_posts_own') && user.id === post.authorId;
}

/**
 * Comment-queue moderation, gated on `manage_posts_any`. Authors (own-posts-only)
 * deliberately don't qualify: the queue exposes every commenter's email and IP
 * across all posts.
 */
export function canModerateComments(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_posts_any');
}

/** Centralized so we can swap the ID strategy (e.g. ULID) in one place later. */
export function newUserId(): string {
  return randomUUID();
}