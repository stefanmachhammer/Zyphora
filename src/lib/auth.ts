import { db, schema } from '../db/client.ts';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { APIContext } from 'astro';
import type { User } from '../db/schema.ts';

// Stored verbatim in roles.permissions; renaming or removing an entry orphans existing role rows.
export const PERMISSION_KEYS = [
  'manage_users',
  'manage_roles',
  'manage_posts_any',
  'manage_posts_own',
  'manage_media',
  'manage_themes',
  'manage_settings',
  'view_analytics',
] as const;
export type Permission = typeof PERMISSION_KEYS[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_users: 'Manage users',
  manage_roles: 'Manage roles',
  manage_posts_any: 'Edit any post',
  manage_posts_own: 'Edit own posts',
  manage_media: 'Manage media',
  manage_themes: 'Manage themes',
  manage_settings: 'Manage site settings',
  view_analytics: 'View analytics',
};

export type SessionUser = User & { permissions: ReadonlySet<string> };

export const SESSION_COOKIE = 'zyphora_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

export async function createSession(userId: string) {
  const id = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function deleteSession(id: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

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

export async function purgeExpiredSessions() {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}

export function setSessionCookie(ctx: APIContext, sessionId: string, expiresAt: Date) {
  ctx.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(ctx: APIContext) {
  ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
}

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

export function canViewAnalytics(user: SessionUser | null): boolean {
  return hasPermission(user, 'view_analytics');
}

export function canCreatePost(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_posts_own') || hasPermission(user, 'manage_posts_any');
}

export function hasAnyPermission(user: SessionUser | null): boolean {
  return !!user && user.permissions.size > 0;
}

export function canEditPost(user: SessionUser | null, post: { authorId: string }): boolean {
  if (!user) return false;
  if (user.permissions.has('manage_posts_any')) return true;
  return user.permissions.has('manage_posts_own') && user.id === post.authorId;
}

// Not manage_posts_own: the queue exposes every commenter's email and IP across all posts.
export function canModerateComments(user: SessionUser | null): boolean {
  return hasPermission(user, 'manage_posts_any');
}

export function newUserId(): string {
  return randomUUID();
}