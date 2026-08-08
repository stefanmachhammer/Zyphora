/**
 * Drizzle schema — single source of truth for the MySQL layout. Migrations in
 * `./drizzle/` are generated from this file (`npm run db:generate`); re-running
 * generate overwrites hand-edited SQL.
 *
 * Column-length conventions: UUID v4 IDs are 36 chars (canonical form); emails
 * 254 (RFC 5321 cap). utf8mb4 is set at the connection level (see `db/client.ts`),
 * so emoji / non-BMP characters round-trip without per-column overrides.
 */
import { mysqlTable, varchar, text, mediumtext, int, boolean, timestamp, json } from 'drizzle-orm/mysql-core';

// `role` is a slug into `roles` (not an enum, so admins can define custom
// roles); validity is enforced in the app layer, no hard FK by design.
// `passwordHash` is Argon2 (see lib/auth.ts), never anything else.
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('author'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// `permissions` is a JSON array of permission keys (see PERMISSION_KEYS in
// lib/auth.ts), stored in MySQL's native `json` type. `system: true` marks the
// built-in roles so the admin UI blocks renaming/deleting them (which could
// otherwise lock everyone out).
export const roles = mysqlTable('roles', {
  slug: varchar('slug', { length: 32 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  permissions: json('permissions').$type<string[]>().notNull().default([]),
  system: boolean('system').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Keyed by the random token in the `zyphora_session` cookie. Cascades on user
// delete so removing a user logs out their open sessions.
export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
});

// `contentHtml` is post-sanitization HTML (see lib/sanitize.ts); `slug` is
// uniquified by lib/posts.ts before insert.
export const posts = mysqlTable('posts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 200 }).notNull(),
  excerpt: varchar('excerpt', { length: 500 }),
  // mediumtext rather than `text` so long-form posts don't bump the 64 KB cap.
  contentHtml: mediumtext('content_html').notNull(),
  status: varchar('status', { length: 16, enum: ['draft', 'published'] }).notNull().default('draft'),
  category: varchar('category', { length: 16, enum: ['news', 'travel', 'gadgets', 'reviews'] }).notNull().default('news'),
  // Display/intake switch, not a delete — existing comments stay in the DB.
  commentsEnabled: boolean('comments_enabled').notNull().default(true),
  // Tri-state override: null inherits the site `require_comment_moderation`
  // setting, true forces moderation, false auto-approves. A defaulted boolean
  // couldn't distinguish "picked the site default" from "unchecked the box."
  moderateComments: boolean('moderate_comments'),
  authorId: varchar('author_id', { length: 36 }).notNull().references(() => users.id),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Metadata only — the bytes live under `public/uploads/`. `filename` is the
// random UUID name on disk; `originalName` is what the user uploaded.
export const media = mysqlTable('media', {
  id: varchar('id', { length: 36 }).primaryKey(),
  filename: varchar('filename', { length: 255 }).notNull(),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 127 }).notNull(),
  sizeBytes: int('size_bytes').notNull(),
  uploadedBy: varchar('uploaded_by', { length: 36 }).notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Key/value site settings. Access goes through lib/settings.ts. `value` is
// plain text — callers JSON-encode structured values themselves.
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
});

// Mirrors what's on disk under `themes/`. `bundled` marks in-repo themes
// (e.g. `default`) so they can't be uninstalled from the admin UI.
export const themes = mysqlTable('themes', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  author: varchar('author', { length: 100 }),
  description: varchar('description', { length: 500 }),
  bundled: boolean('bundled').notNull().default(false),
  installedAt: timestamp('installed_at').notNull().defaultNow(),
});

// `content` is HTML-stripped in lib/comments.ts before insert and escaped on
// render. Cascades on post delete. New comments default to `pending` and only
// appear publicly once a moderator approves them.
export const comments = mysqlTable('comments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  postId: varchar('post_id', { length: 36 }).notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorName: varchar('author_name', { length: 80 }).notNull(),
  authorEmail: varchar('author_email', { length: 254 }).notNull(),
  authorUrl: varchar('author_url', { length: 500 }),
  content: text('content').notNull(),
  status: varchar('status', { length: 16, enum: ['pending', 'approved', 'spam', 'trash'] }).notNull().default('pending'),
  // IPv6 addresses can reach 45 chars in canonical form; IPv4 fits comfortably.
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Media = typeof media.$inferSelect;
export type Theme = typeof themes.$inferSelect;
export type NewTheme = typeof themes.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
