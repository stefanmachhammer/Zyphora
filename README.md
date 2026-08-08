# Zyphora

A self-hosted CMS built on Astro. SSR public site, admin panel at `/admin`, MySQL + Drizzle, session-cookie auth, a TipTap block editor, and a runtime theme system with a hooks API.

## Stack

- **Astro 7** with Node adapter (`output: 'server'`)
- **MySQL** via `mysql2` + **Drizzle ORM**
- **React** island for the **TipTap** rich-text editor
- **Eta** templates for runtime themes
- Argon2 password hashing (`@node-rs/argon2`)
- HTML sanitization with DOMPurify
- Zod for form validation

## Features

### Authoring
- **Posts** — draft/publish workflow, slug auto-generation, rich-text editor (headings, lists, blockquotes, code blocks, links, inline code)
- **Categories** — built-in `news`, `travel`, `gadgets`, `reviews` with a per-post select in the editor
- **Media library** — upload images, video, and PDFs (10 MB limit) stored under `public/uploads/` with metadata in MySQL
- **Users & roles** — four system roles (`admin`, `editor`, `author`, `subscriber`) plus custom roles with per-permission grants, managed from the admin
- **Comments** — per-post comments on the public site with a moderation queue in the admin and optional Google reCAPTCHA v2 spam protection
- **Settings** — site title/description, active theme, reCAPTCHA keys, password change

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
- Full-text search at `/search`
- Visitor accounts — public login/register pages; self-signups land in the `subscriber` role
- Drafts are never exposed publicly

## Requirements

- Node `>=22.12.0`
- MySQL 8+ (any flavor: MySQL Community Edition, MariaDB, Amazon RDS, PlanetScale via the standard driver, etc.)

## Quick start

You need a running MySQL 8+ server with an empty database (Zyphora won't create or drop databases).

### Web installer (default)

No env vars, no CLI scripts:

```sh
npm install
npm run dev             # http://localhost:4321 — the installer takes over
```

Every request is funneled to `/install` until the CMS is set up. The wizard collects your DB credentials (tests the connection, then writes them to `.env`), applies migrations, seeds the system roles, and creates your admin account from a form. When it finishes you're logged in and `/install` disappears.

### Headless / scripted deploys

Set the DB env vars and run the CLI scripts directly — they share their logic with the installer, so the end state is identical:

```sh
export DB_HOST=localhost
export DB_PORT=3306        # optional, defaults to 3306
export DB_USER=zyphora
export DB_PASS=...
export DB_NAME=zyphora
```

```sh
npm install
npm run db:migrate
npm run db:seed         # creates system roles + admin@zyphora.local / changeme123
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
| `npm run db:migrate`     | Apply pending migrations to the configured MySQL database    |
| `npm run db:seed`        | Idempotent — seeds system roles, first admin, default settings |
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
│   ├── admin/         dashboard, posts CRUD, media, comments, themes, users, roles, settings
│   ├── install/       first-run web installer (DB credentials, migrate, seed, admin account)
│   ├── posts/[slug]   public post detail
│   ├── themes/[…]     theme asset serving
│   ├── search.astro   public full-text search
│   ├── login.astro    visitor login (register.astro for signups)
│   └── index.astro    public home (post list)
└── styles/
themes/
└── default/           bundled theme (theme.json + Eta templates + assets)
drizzle/               generated SQL migrations
public/                static assets and uploads (uploads gitignored)
```

## Configuration

Database connection — written to `.env` by the web installer, or set manually for headless deploys. The server boots without them (so the installer can run); anything that actually touches the DB fails with a clear error until they're present:

| Variable    | Default | Description                                              |
| ----------- | ------- | -------------------------------------------------------- |
| `DB_HOST`   | —       | MySQL host                                               |
| `DB_PORT`   | `3306`  | MySQL port                                               |
| `DB_USER`   | —       | MySQL user                                               |
| `DB_PASS`   | —       | MySQL password                                           |
| `DB_NAME`   | —       | MySQL database / schema                                  |

Seed script (all optional):

| Variable              | Default               | Description                          |
| --------------------- | --------------------- | ------------------------------------ |
| `SEED_ADMIN_EMAIL`    | `admin@zyphora.local` | First admin email (seed script)      |
| `SEED_ADMIN_PASSWORD` | `changeme123`         | First admin password (seed script)   |
| `SEED_ADMIN_NAME`     | `Admin`               | First admin display name             |

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

Sessions currently live in MySQL alongside everything else. The app server itself is stateless (modulo connection pooling), so multiple app nodes can point at the same MySQL primary — but for horizontal scaling where every login/logout round-trip would otherwise hit the DB, moving sessions to Redis is the obvious next step.

## Roadmap

Major work on deck:

- **Plugins** — uploadable plugin system on top of the existing hooks registry. Themes will stay runtime-template-only; plugins get their own threat model and a clear extension API.
- **Analytics** — built-in, privacy-first pageview tracking with a top-posts dashboard, referrer breakdown, and per-post stats. No third-party cookies.
- **Email** — outbound SMTP for transactional notifications (new comment, password reset, mentions) and an admin section for templates and delivery logs.
- **Default theme** — keep iterating: pagination, tags, author pages, archives by category, OG/Twitter card metadata.

Smaller items still on the list:

- Pages (vs. posts) with hierarchy
- Tags (categories already shipped)
- RSS / Atom feed
- Image resizing and responsive `srcset`
- Pluggable storage adapter (S3, R2) for media