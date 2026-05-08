import { db, schema } from '../db/client.ts';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { APIContext } from 'astro';
import type { User } from '../db/schema.ts';

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

export type Role = 'admin' | 'editor' | 'author';

export function canManageUsers(user: User | null): boolean {
  return user?.role === 'admin';
}

export function canEditPost(user: User | null, post: { authorId: string }): boolean {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'editor') return true;
  return user.id === post.authorId;
}

export function newUserId(): string {
  return randomUUID();
}