/**
 * Demo posts seed.
 *
 * Idempotent — keyed off slug. Re-running on a DB that already has these
 * posts is a no-op. Safe to run after `db:seed` (which only seeds the admin
 * + settings, never posts).
 *
 * Authorship resolves to the bootstrap admin (or `SEED_ADMIN_EMAIL`). If no
 * admin exists yet, the script bails — run `db:seed` first.
 */
import { db, schema } from './client.ts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { slugify } from '../lib/slug.ts';
import { sanitizeHtml } from '../lib/sanitize.ts';

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@zyphora.local';

const authorRows = await db.select().from(schema.users).where(eq(schema.users.email, adminEmail)).limit(1);
const author = authorRows[0];
if (!author) {
  console.error(`No user found for ${adminEmail}. Run \`npm run db:seed\` first.`);
  process.exit(1);
}

// daysAgo is relative to "now" so re-running keeps a sensible chronology
// without us needing to hardcode dates.
type Category = 'news' | 'travel' | 'gadgets' | 'reviews';
type DemoPost = { title: string; excerpt: string; contentHtml: string; daysAgo: number; category: Category };

const demoPosts: DemoPost[] = [
  {
    title: 'Welcome to Zyphora',
    excerpt: 'A self-hosted, WordPress-style CMS built on Astro — fast SSR, MySQL, and a tiny admin you can actually understand.',
    contentHtml: `
      <p>Zyphora is a small, opinionated content engine. Posts are written in a TipTap editor, stored in MySQL, sanitized server-side, and rendered through swappable Eta themes.</p>
      <h2>What ships in the box</h2>
      <ul>
        <li>Server-rendered public site with cookie-session auth for the admin.</li>
        <li>Drag-and-drop theme installs (zip uploads) with a hooks API.</li>
        <li>A single-binary deployment story — one Node process, one .db file.</li>
      </ul>
      <p>This post (and the others below) was created by the demo seed script. Edit or delete them from the admin once you've had a look around.</p>
    `,
    daysAgo: 0,
    category: 'news',
  },
  {
    title: 'Designing the dark mode toggle',
    excerpt: 'How the default theme picks a palette, avoids first-paint flash, and keeps the slider switch accessible.',
    contentHtml: `
      <p>The toggle in the header is a sun/moon slider switch. Underneath, three things have to line up:</p>
      <ol>
        <li>An inline blocking script in <code>&lt;head&gt;</code> reads <code>localStorage</code> and <code>prefers-color-scheme</code> and stamps <code>data-theme</code> on <code>&lt;html&gt;</code> before first paint. No flash.</li>
        <li>The CSS keeps a single set of design tokens on <code>:root</code> and overrides them under <code>[data-theme="dark"]</code> — components stay token-driven, so one selector themes the whole site.</li>
        <li>The button uses <code>role="switch"</code> with <code>aria-checked</code> reflecting the rendered theme. Click flips relative to what's actually on screen, not relative to a hidden mode value.</li>
      </ol>
      <blockquote>The cheapest accessibility win is a focus ring that's actually visible in both palettes.</blockquote>
    `,
    daysAgo: 2,
    category: 'gadgets',
  },
  {
    title: 'Themes are runtime, plugins are not',
    excerpt: 'Why uploadable themes get to ship Eta templates but never executable JavaScript — and what that buys us.',
    contentHtml: `
      <p>Themes in Zyphora are zip bundles you upload from the admin. Each is a small directory of Eta templates plus a manifest. They're loaded at runtime — there's no rebuild step.</p>
      <p>What themes <em>cannot</em> do is execute server-side JavaScript. We don't dynamically import code from theme zips. That'd be remote code execution by design.</p>
      <p>Plugins, when they happen, will be a separate decision with their own threat model. For now, hooks (<code>addFilter</code>, <code>applyFilters</code>, <code>addAction</code>, <code>doAction</code>) are wired by core code only — and that's enough to do useful work.</p>
    `,
    daysAgo: 5,
    category: 'reviews',
  },
  {
    title: 'A tour of the admin',
    excerpt: 'Sessions, role-based gates, and the form-POST pattern that keeps the admin progressive-enhancement friendly.',
    contentHtml: `
      <p>The admin lives at <code>/admin</code>. Auth is a server-side session keyed off a 24-byte random cookie — not a JWT. That keeps revocation trivial and avoids the usual JWT footguns.</p>
      <p>Every mutation is a plain HTML form POST handled in the page's frontmatter. After a successful write, we redirect with <code>?saved=1</code> and surface a small banner. No client-side state machine, no data-fetching framework. Works without JS.</p>
      <p>Roles: <code>admin</code> can manage users, <code>editor</code> can edit any post, <code>author</code> can only edit their own.</p>
    `,
    daysAgo: 9,
    category: 'gadgets',
  },
  {
    title: 'Why MySQL, and how to scale it',
    excerpt: 'A familiar workhorse database, utf8mb4 throughout, and what changes when you need more than one application node.',
    contentHtml: `
      <p>MySQL is the workhorse here: a familiar daemon, predictable operational tooling, and utf8mb4 everywhere so titles and content can carry emoji and non-BMP characters without a fight.</p>
      <p>The day you need horizontal scaling, the application's session table needs to move out — Redis is the obvious next step — but the database itself happily accepts more reader replicas without a schema change. The data layer is fully async, so swapping in a serverless MySQL driver later is a one-file change in <code>db/client.ts</code>.</p>
    `,
    daysAgo: 14,
    category: 'reviews',
  },
  {
    title: 'Sanitization is the whole story',
    excerpt: 'Rich-text editors are great until someone pastes a script tag. Here is how the content pipeline stays safe.',
    contentHtml: `
      <p>The TipTap editor produces HTML. That HTML is then run through <code>sanitizeHtml()</code> (a DOMPurify allowlist) <strong>before</strong> it touches the database.</p>
      <p>The public template renders post content with <code>set:html</code> / <code>&lt;%~ %&gt;</code> — raw, unescaped output. That's only safe because the bytes hit DOMPurify on the way <em>in</em>. If you ever add another field that holds rich HTML, route it through the same sanitizer. There are no exceptions.</p>
    `,
    daysAgo: 21,
    category: 'news',
  },
  {
    title: 'Hello, world',
    excerpt: 'The very first post — left here so the empty-state on the homepage is something you have to actively delete to see.',
    contentHtml: `
      <p>If you're reading this, the seed script worked. Welcome.</p>
      <p>Open the admin, write a real post, and delete this one when you're ready.</p>
    `,
    daysAgo: 30,
    category: 'travel',
  },
];

const now = Date.now();
let inserted = 0;
let skipped = 0;

for (const post of demoPosts) {
  const slug = slugify(post.title);
  // Slug is the idempotency key — if it already exists, skip silently.
  // We deliberately don't update existing rows, because re-running shouldn't
  // clobber edits a user has made to seeded content.
  const existing = await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.slug, slug)).limit(1);
  if (existing.length > 0) {
    skipped += 1;
    continue;
  }
  const publishedAt = new Date(now - post.daysAgo * 24 * 60 * 60 * 1000);
  await db.insert(schema.posts).values({
    id: randomUUID(),
    slug,
    title: post.title,
    excerpt: post.excerpt,
    contentHtml: sanitizeHtml(post.contentHtml.trim()),
    status: 'published',
    category: post.category,
    authorId: author.id,
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  });
  inserted += 1;
}

// One-time backfill for rows seeded before `category` existed: only touch
// rows still on the schema default ('news') so user edits to category aren't
// clobbered. Idempotent — once corrected, subsequent runs find nothing to do.
let recategorized = 0;
for (const post of demoPosts) {
  if (post.category === 'news') continue;
  const slug = slugify(post.title);
  const rows = await db
    .select({ id: schema.posts.id, category: schema.posts.category })
    .from(schema.posts)
    .where(eq(schema.posts.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row || row.category !== 'news') continue;
  await db.update(schema.posts).set({ category: post.category }).where(eq(schema.posts.id, row.id));
  recategorized += 1;
}

console.log(`Demo posts: ${inserted} inserted, ${skipped} already existed, ${recategorized} recategorized.`);
process.exit(0);