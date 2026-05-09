# ZyphoraCMS

A self-hosted CMS built on Astro. SSR public site, admin panel at `/admin`, SQLite + Drizzle, session-cookie auth, a TipTap block editor, and a runtime theme system with a hooks API.

## Stack

- **Astro 6** with Node adapter (`output: 'server'`)
- **SQLite** via `better-sqlite3` + **Drizzle ORM**
- **React** island for the **TipTap** rich-text editor
- **Eta** templates for runtime themes
- Argon2 password hashing (`@node-rs/argon2`)
- HTML sanitization with DOMPurify
- Zod for form validation

## Features

### Authoring
- **Posts** — draft/publish workflow, slug auto-generation, rich-text editor (headings, lists, blockquotes, code blocks, links, inline code)
- **Categories** — built-in `news`, `travel`, `gadgets`, `reviews` with a per-post select in the editor
- **Media library** — upload images, video, and PDFs (10 MB limit) stored under `public/uploads/` with metadata in SQLite
- **Users & roles** — `admin`, `editor`, `author`; admins manage users, editors edit any post, authors edit only their own
- **Settings** — site title/description, active theme, password change

### Admin UI
- **Collapsible sidebar** — full or rail mode, persisted per-user via cookie
- **View site** — one-click open of the public site in a new tab
- Form-POST mutations throughout — works without JavaScript, plays nicely with progressive enhancement

### Themes
- **Runtime theme system** — themes are folders of Eta templates plus a `theme.json` manifest, loaded at request time (no rebuild needed)
- **Uploadable themes** — drop a zip in the admin; install/uninstall from the Themes page. Bundled themes can't be uninstalled.
- **Hooks API** — `addFilter` / `applyFilters` / `addAction` / `doAction` with priorities, wired by core for `the_title`, `the_content`, `posts_list`, and `post_render`
- **Security** — themes ship templates and assets only. JavaScript inside theme zips is never loaded server-side; that would be RCE-by-design.

### Bundled default theme
- **Dark / light slider switch** in the header with no first-paint flash (inline blocking script reads `localStorage` + `prefers-color-scheme`)
- **Featured grid** of image cards on the homepage with a hover effect
- **Tabbed category section** — News / Travel / Gadgets / Reviews with horizontal swipe transitions and full keyboard navigation
- Responsive header with a hamburger nav at narrow widths
- Token-driven CSS — components use design tokens so dark mode is one selector

### Public site
- Server-rendered post list at `/` and post detail at `/posts/[slug]`
- Drafts are never exposed publicly

## Requirements

- Node `>=22.12.0`

## Quick start

```sh
npm install
npm run db:migrate
npm run db:seed         # creates admin@zyphora.local / changeme123
npm run db:seed-posts   # optional: ~7 demo posts spread across categories
npm run dev             # http://localhost:4321
```

Then visit [http://localhost:4321/admin/login](http://localhost:4321/admin/login) and sign in. Change the password in **Settings → Change your password** immediately.

You can override the seed credentials with environment variables:

```sh
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=secret SEED_ADMIN_NAME="Your Name" npm run db:seed
```

Both seed scripts are idempotent — re-running them is safe.

## Scripts

| Command                  | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `npm run dev`            | Start the dev server at `http://localhost:4321`              |
| `npm run build`          | Build to `./dist/` (Node standalone server)                  |
| `npm run preview`        | Run the production build locally                             |
| `npm run db:generate`    | Generate a new Drizzle migration from `schema.ts`            |
| `npm run db:migrate`     | Apply pending migrations to `./data/zyphora.db`              |
| `npm run db:seed`        | Idempotent — creates first admin and default settings        |
| `npm run db:seed-posts`  | Idempotent — inserts ~7 demo posts spread across categories  |
| `npm run db:studio`      | Open the Drizzle Studio DB browser                           |

There is no test runner, linter, or formatter installed by default. `npm run astro -- check` runs the Astro / TypeScript checker.

## Project layout

```
src/
├── components/        React islands (TipTap editor)
├── db/                Drizzle schema, client, migrate / seed scripts
├── layouts/           AdminLayout, SiteLayout
├── lib/               auth, posts, media, settings, sanitize, slug
│   └── themes/        registry, install, render, hooks (WP-style)
├── middleware.ts      session lookup + admin route guard
├── pages/
│   ├── admin/         dashboard, posts CRUD, media, themes, users, settings
│   ├── posts/[slug]   public post detail
│   ├── themes/[…]     theme asset serving
│   └── index.astro    public home (post list)
└── styles/
themes/
└── default/           bundled theme (theme.json + Eta templates + assets)
drizzle/               generated SQL migrations
public/                static assets and uploads (uploads gitignored)
data/                  SQLite database file (gitignored)
```

## Configuration

Environment variables (all optional):

| Variable                | Default                  | Description                          |
| ----------------------- | ------------------------ | ------------------------------------ |
| `DATABASE_PATH`         | `./data/zyphora.db`      | SQLite file location                 |
| `DATABASE_URL`          | `file:./data/zyphora.db` | Used by `drizzle-kit` only           |
| `SEED_ADMIN_EMAIL`      | `admin@zyphora.local`    | First admin email (seed script)      |
| `SEED_ADMIN_PASSWORD`   | `changeme123`            | First admin password (seed script)   |
| `SEED_ADMIN_NAME`       | `Admin`                  | First admin display name             |

## Themes

A theme is a directory under `themes/<slug>/` containing:

- `theme.json` — manifest (`slug`, `name`, `version`, `author`, `description`)
- `templates/*.eta` — at minimum `index.eta` (post list) and `post.eta` (single post); `404.eta` is optional
- `assets/` — anything served at `/themes/<slug>/<path>` (CSS, JS, images, fonts)

Templates render against a typed `RenderContext` (see `src/lib/themes/types.ts`) and emit content through the hooks pipeline. Post HTML is sanitized server-side on write, so the templates can render it raw with `<%~ post.contentHtml %>`.

To install a third-party theme, zip the folder so `theme.json` is at the top level (or under a single wrapper directory) and upload from **Admin → Themes**. Zip-slip and zip-bomb guards apply (5 MB compressed / 25 MB uncompressed).

## Production

```sh
npm run build
node ./dist/server/entry.mjs
```

The built server is a standalone Node process. Place it behind a reverse proxy (nginx, Caddy) and serve `public/uploads/` either from the same Node server (default) or from a static file server / CDN.

Single-node only at the moment — sessions live in SQLite. For horizontal scaling, the session table needs to move (Redis is the obvious next step) and the database itself can swap to Postgres or libsql.

## Roadmap

Major work on deck:

- **Plugins** — uploadable plugin system on top of the existing hooks registry. Themes will stay runtime-template-only; plugins get their own threat model and a clear extension API.
- **Comments** — per-post comments on the public site, plus a moderation queue and spam controls in a dedicated admin section.
- **Analytics** — built-in, privacy-first pageview tracking with a top-posts dashboard, referrer breakdown, and per-post stats. No third-party cookies.
- **Email** — outbound SMTP for transactional notifications (new comment, password reset, mentions) and an admin section for templates and delivery logs.
- **Default theme** — keep iterating: search, pagination, tags, author pages, archives by category, OG/Twitter card metadata.

Smaller items still on the list:

- Pages (vs. posts) with hierarchy
- Tags (categories already shipped)
- RSS / Atom feed
- Image resizing and responsive `srcset`
- Pluggable storage adapter (S3, R2) for media