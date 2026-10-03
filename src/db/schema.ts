import { mysqlTable, varchar, char, text, mediumtext, int, boolean, timestamp, json, index } from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('author'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const roles = mysqlTable('roles', {
  slug: varchar('slug', { length: 32 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  permissions: json('permissions').$type<string[]>().notNull().default([]),
  system: boolean('system').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
});

export const posts = mysqlTable('posts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 200 }).notNull(),
  excerpt: varchar('excerpt', { length: 500 }),
  contentHtml: mediumtext('content_html').notNull(),
  status: varchar('status', { length: 16, enum: ['draft', 'published'] }).notNull().default('draft'),
  category: varchar('category', { length: 16, enum: ['news', 'travel', 'gadgets', 'reviews'] }).notNull().default('news'),
  commentsEnabled: boolean('comments_enabled').notNull().default(true),
  // Nullable on purpose: null inherits the site `require_comment_moderation` setting.
  moderateComments: boolean('moderate_comments'),
  authorId: varchar('author_id', { length: 36 }).notNull().references(() => users.id),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const media = mysqlTable('media', {
  id: varchar('id', { length: 36 }).primaryKey(),
  filename: varchar('filename', { length: 255 }).notNull(),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 127 }).notNull(),
  sizeBytes: int('size_bytes').notNull(),
  uploadedBy: varchar('uploaded_by', { length: 36 }).notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
});

export const themes = mysqlTable('themes', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  author: varchar('author', { length: 100 }),
  description: varchar('description', { length: 500 }),
  bundled: boolean('bundled').notNull().default(false),
  installedAt: timestamp('installed_at').notNull().defaultNow(),
});

export const comments = mysqlTable('comments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  postId: varchar('post_id', { length: 36 }).notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorName: varchar('author_name', { length: 80 }).notNull(),
  authorEmail: varchar('author_email', { length: 254 }).notNull(),
  authorUrl: varchar('author_url', { length: 500 }),
  content: text('content').notNull(),
  status: varchar('status', { length: 16, enum: ['pending', 'approved', 'spam', 'trash'] }).notNull().default('pending'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const pageviews = mysqlTable(
  'pageviews',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    path: varchar('path', { length: 500 }).notNull(),
    postId: varchar('post_id', { length: 36 }).references(() => posts.id, { onDelete: 'set null' }),
    referrerHost: varchar('referrer_host', { length: 255 }),
    // Salted SHA-256 of (salt, UTC day, IP, UA) — never store the raw IP/UA here.
    visitorHash: char('visitor_hash', { length: 64 }).notNull(),
    device: varchar('device', { length: 16, enum: ['desktop', 'mobile', 'tablet'] }).notNull(),
    // No defaultNow(): MySQL's now() uses the session time zone while Drizzle
    // reads/writes UTC wall-clock, so a DB default would be offset.
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    index('pageviews_created_at_idx').on(t.createdAt),
    index('pageviews_post_id_idx').on(t.postId),
  ],
);

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
export type Pageview = typeof pageviews.$inferSelect;
export type NewPageview = typeof pageviews.$inferInsert;
