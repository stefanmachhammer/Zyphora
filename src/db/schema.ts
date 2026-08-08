/**
 * Drizzle schema — the single source of truth for the MySQL layout.
 *
 * Migrations in `./drizzle/` are generated from this file via `npm run db:generate`
 * and applied by `npm run db:migrate`. Don't edit produced SQL by hand unless
 * you know exactly what you're doing — re-running generate after a manual
 * edit will overwrite it.
 *
 * Type aliases at the bottom (`User`, `NewPost`, etc.) are inferred from the
 * tables and re-exported so other modules don't need to import drizzle to
 * type their function signatures.
 *
 * Column-length notes:
 *  - Text-IDs that hold a UUID v4 are sized at 36 chars (canonical form).
 *  - Email columns use 254 — the practical RFC 5321 path-length cap.
 *  - Session tokens are 24 random bytes encoded as base64url (~32 chars);
 *    varchar(64) leaves headroom for any future encoding change.
 *  - Post `contentHtml` uses `mediumtext` (~16 MB). Stock `text` caps at 64 KB
 *    which is too small for long posts; sanitized HTML can easily push past it.
 *  - utf8mb4 is set at the connection level (see `db/client.ts`); MySQL 8's
 *    default collation handles emoji and non-BMP characters in titles and
 *    content without us having to override per-column.
 */
import { mysqlTable, varchar, text, mediumtext, int, boolean, timestamp, json } from 'drizzle-orm/mysql-core';

// Authoring accounts. `role` is a slug into the `roles` table — no enum here
// so admins can define custom roles. Validity is enforced at the application
// layer (the admin UI only exposes existing role slugs); we deliberately skip
// a hard FK to keep the migration that introduced the roles table simple.
// `passwordHash` is Argon2 (see lib/auth.ts), never anything else.
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('author'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Role definitions. `permissions` is a JSON array of permission keys (see
// PERMISSION_KEYS in lib/auth.ts) — MySQL's native `json` type stores it as
// a real JSON document and Drizzle (de)serializes on read/write. `system: true`
// marks the three built-in roles so the admin UI prevents them from being
// renamed or deleted (which would otherwise risk locking everyone out of the
// CMS).
export const roles = mysqlTable('roles', {
  slug: varchar('slug', { length: 32 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  permissions: json('permissions').$type<string[]>().notNull().default([]),
  system: boolean('system').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Server-side session records keyed by the random token in the
// `zyphora_session` cookie. Cascades on user delete so removing a user
// implicitly logs out their open sessions.
export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
});

// Posts — the only content type currently. `contentHtml` is post-sanitization
// HTML (see lib/sanitize.ts); `slug` is uniquified by lib/posts.ts before
// insert. Drafts are filtered out of public queries everywhere.
export const posts = mysqlTable('posts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 200 }).notNull(),
  // Excerpt is optional plain text shown above the body on listings.
  excerpt: varchar('excerpt', { length: 500 }),
  // mediumtext rather than `text` so long-form posts don't bump the 64 KB cap.
  contentHtml: mediumtext('content_html').notNull(),
  status: varchar('status', { length: 16, enum: ['draft', 'published'] }).notNull().default('draft'),
  category: varchar('category', { length: 16, enum: ['news', 'travel', 'gadgets', 'reviews'] }).notNull().default('news'),
  // Per-post comment toggle. Defaults to true so existing posts and the
  // common case ("comments on") need no extra clicks; flip to false in the
  // admin to suppress the comment form and hide the section from templates.
  // Existing approved comments are kept in the DB regardless — disabling is
  // a display/intake switch, not a delete.
  commentsEnabled: boolean('comments_enabled').notNull().default(true),
  // Per-post moderation override. `null` means "inherit the site-wide
  // `require_comment_moderation` setting" (the common case). `true` forces
  // moderation on this post regardless of the site default; `false` makes new
  // comments auto-approve. Kept tri-state on purpose: a boolean with a default
  // can't distinguish "I picked the site default" from "I unchecked the box."
  moderateComments: boolean('moderate_comments'),
  authorId: varchar('author_id', { length: 36 }).notNull().references(() => users.id),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Uploaded files. The bytes themselves live under `public/uploads/`; this
// table only holds metadata. `filename` is the random UUID name on disk;
// `originalName` is what the user uploaded.
export const media = mysqlTable('media', {
  id: varchar('id', { length: 36 }).primaryKey(),
  filename: varchar('filename', { length: 255 }).notNull(),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 127 }).notNull(),
  sizeBytes: int('size_bytes').notNull(),
  uploadedBy: varchar('uploaded_by', { length: 36 }).notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Generic key/value site settings (e.g. `site_title`, `active_theme`).
// All access goes through lib/settings.ts so upserts stay consistent.
// `value` is plain text — callers JSON-encode structured values themselves.
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
});

// Theme registry — kept in sync with what's actually on disk under `themes/`.
// `bundled` marks themes that ship in-repo (e.g. `default`) so they can't be
// uninstalled from the admin UI.
export const themes = mysqlTable('themes', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  author: varchar('author', { length: 100 }),
  description: varchar('description', { length: 500 }),
  bundled: boolean('bundled').notNull().default(false),
  installedAt: timestamp('installed_at').notNull().defaultNow(),
});

// Guest comments on posts. Stored as plain text — `content` is HTML-stripped
// in lib/comments.ts before insert and escaped on render. Cascades on post
// delete so removing a post removes its discussion. Every new comment lands
// in `pending` and only appears publicly once a moderator approves it.
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
