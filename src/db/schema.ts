

/**
 * Drizzle schema — the single source of truth for the SQLite layout.
 *
 * Migrations in `./drizzle/` are generated from this file via `npm run db:generate`
 * and applied by `npm run db:migrate`. Don't edit produced SQL by hand unless
 * you know exactly what you're doing — re-running generate after a manual
 * edit will overwrite it.
 *
 * Type aliases at the bottom (`User`, `NewPost`, etc.) are inferred from the
 * tables and re-exported so other modules don't need to import drizzle to
 * type their function signatures.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Authoring accounts. `role` is a slug into the `roles` table — no enum here
// so admins can define custom roles. Validity is enforced at the application
// layer (the admin UI only exposes existing role slugs); we deliberately skip
// a hard FK to keep the migration that introduced the roles table simple.
// `passwordHash` is Argon2 (see lib/auth.ts), never anything else.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('author'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// Role definitions. `permissions` is a JSON-encoded array of permission keys
// (see PERMISSION_KEYS in lib/auth.ts) — `text({ mode: 'json' })` handles the
// (de)serialization. `system: true` marks the three built-in roles so the
// admin UI prevents them from being renamed or deleted (which would otherwise
// risk locking everyone out of the CMS).
export const roles = sqliteTable('roles', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  permissions: text('permissions', { mode: 'json' }).$type<string[]>().notNull().default([]),
  system: integer('system', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// Server-side session records keyed by the random token in the
// `zyphora_session` cookie. Cascades on user delete so removing a user
// implicitly logs out their open sessions.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

// Posts — the only content type currently. `contentHtml` is post-sanitization
// HTML (see lib/sanitize.ts); `slug` is uniquified by lib/posts.ts before
// insert. Drafts are filtered out of public queries everywhere.
export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  excerpt: text('excerpt'),
  contentHtml: text('content_html').notNull().default(''),
  status: text('status', { enum: ['draft', 'published'] }).notNull().default('draft'),
  category: text('category', { enum: ['news', 'travel', 'gadgets', 'reviews'] }).notNull().default('news'),
  // Per-post comment toggle. Defaults to true so existing posts and the
  // common case ("comments on") need no extra clicks; flip to false in the
  // admin to suppress the comment form and hide the section from templates.
  // Existing approved comments are kept in the DB regardless — disabling is
  // a display/intake switch, not a delete.
  commentsEnabled: integer('comments_enabled', { mode: 'boolean' }).notNull().default(true),
  // Per-post moderation override. `null` means "inherit the site-wide
  // `require_comment_moderation` setting" (the common case). `true` forces
  // moderation on this post regardless of the site default; `false` makes new
  // comments auto-approve. Kept tri-state on purpose: a boolean with a default
  // can't distinguish "I picked the site default" from "I unchecked the box."
  moderateComments: integer('moderate_comments', { mode: 'boolean' }),
  authorId: text('author_id').notNull().references(() => users.id),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// Uploaded files. The bytes themselves live under `public/uploads/`; this
// table only holds metadata. `filename` is the random UUID name on disk;
// `originalName` is what the user uploaded.
export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// Generic key/value site settings (e.g. `site_title`, `active_theme`).
// All access goes through lib/settings.ts so upserts stay consistent.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Theme registry — kept in sync with what's actually on disk under `themes/`.
// `bundled` marks themes that ship in-repo (e.g. `default`) so they can't be
// uninstalled from the admin UI.
export const themes = sqliteTable('themes', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  author: text('author'),
  description: text('description'),
  bundled: integer('bundled', { mode: 'boolean' }).notNull().default(false),
  installedAt: integer('installed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// Guest comments on posts. Stored as plain text — `content` is HTML-stripped
// in lib/comments.ts before insert and escaped on render. Cascades on post
// delete so removing a post removes its discussion. Every new comment lands
// in `pending` and only appears publicly once a moderator approves it.
export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorName: text('author_name').notNull(),
  authorEmail: text('author_email').notNull(),
  authorUrl: text('author_url'),
  content: text('content').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'spam', 'trash'] }).notNull().default('pending'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
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
