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

/**
 * The full set of permission keys the CMS understands. Adding a new entry
 * here is the only place permissions are declared — `lib/auth.ts` checks
 * against these strings, the admin UI renders a checkbox per entry, and
 * `roles.permissions` stores any subset of them. Removing or renaming an
 * entry is a breaking change for stored role rows.
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
 * The user record as it lives on `Astro.locals.user`: the DB row plus the
 * resolved permission set. Middleware (via `getUserBySession`) joins the
 * user's role row once per request so downstream pages can check
 * `hasPermission(...)` without further queries.
 */
export type SessionUser = User & { permissions: ReadonlySet<string> };

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
 *
 * Joins the role row in the same query so the returned `SessionUser` carries
 * its resolved permission set — pages can then call `hasPermission` without
 * a follow-up DB hit. A left-join is used so a user whose role slug went
 * stale (role deleted out from under them) still resolves with an empty
 * permission set instead of failing the lookup outright.
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

/** True iff the user's role grants `key`. Anonymous → always false. */
export function hasPermission(user: SessionUser | null, key: Permission): boolean {
  return !!user && user.permissions.has(key);
}

/** Gate: the user can create/modify users. Backed by `manage_users`. */
export function canManageUsers(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_users');
}

/** Gate: the user can create/modify custom roles. Backed by `manage_roles`. */
export function canManageRoles(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_roles');
}

/**
 * Editorial authorization for a specific post.
 * - `manage_posts_any` → can edit any post
 * - `manage_posts_own` + ownership → can edit only their own
 */
export function canEditPost(user: SessionUser | null, post: { authorId: string }): boolean {
  if (!user) return false;
  if (user.permissions.has('manage_posts_any')) return true;
  return user.permissions.has('manage_posts_own') && user.id === post.authorId;
}

/**
 * Moderation rights for the comment queue. Gated on `manage_posts_any` —
 * if you can edit any post, you can moderate the discussion on it. Authors
 * (own-posts-only) deliberately don't qualify: queue access would surface
 * every commenter's email and IP across every post in the system.
 */
export function canModerateComments(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_posts_any');
}

/** Centralized so we can swap the ID strategy (e.g. ULID) in one place later. */
export function newUserId(): string {
  return randomUUID();
}