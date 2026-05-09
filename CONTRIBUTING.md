# Contributing to ZyphoraCMS

Thanks for taking an interest. This file covers how to file issues, send pull requests, and the conventions that keep the codebase predictable.

By participating in this project you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting bugs

Before opening a bug report, please:

1. Check that the bug isn't already in [issues](https://github.com/ceqox-software/ZyphoraCMS/issues).
2. Confirm you're on Node `>=22.12.0` and the latest `main`.
3. Include steps to reproduce, the expected behaviour, and what actually happened. A minimal repro saves everyone time.

For template / theme bugs, paste the relevant snippet of the `.eta` template along with the error. Eta's tokenizer is finicky around `<%` / `%>` substrings — see [#5](https://github.com/ceqox-software/ZyphoraCMS/issues/5).

## Requesting features

Open an issue with the `enhancement` flavour. Describe the use case before the implementation — "I want to do X, currently I have to do Y" beats "add a button that does Z." That makes scope easier to discuss.

Big features (plugins, comments moderation, analytics, email — see the README roadmap) deserve a short design discussion in the issue before code. We'd rather agree on a sketch than throw away a finished PR.

## Setting up locally

Quick path:

```sh
npm install
npm run db:migrate
npm run db:seed         # creates admin@zyphora.local / changeme123
npm run db:seed-posts   # optional demo content
npm run dev             # http://localhost:4321
```

The full quick-start, scripts table, env vars, and project layout live in the [README](./README.md).

## Sending a pull request

1. Fork and create a branch off `main`. Branch names like `feature/comments` or `fix/eta-tokenizer-comments` are fine — match the imperative mood of the commit you'll write.
2. Keep the PR focused. One feature or one fix per PR.
3. Write commit subjects in the imperative mood (`Add post categories…`, `Fix Eta parse error…`), under ~72 characters. Add a body only if the change isn't self-evident.
4. Run `npm run astro -- check` before opening the PR. Type errors should be zero; the `await db.…` `ts(80007)` hints are intentional (see the data layer notes below).
5. If you touched the schema, include the generated migration (`./drizzle/`) and verify it applies cleanly to a fresh DB.
6. Update the README and any affected docs in the same PR. Don't leave docs for "later."

PR descriptions should answer: **what changed, why, and how to verify**. A bullet list is fine.

## Coding conventions

These aren't preferences — they're invariants other code relies on. Breaking them silently breaks unrelated things.

- **Imports keep `.ts` / `.tsx` extensions.** The seed and migrate scripts run under `node --experimental-strip-types` and need them. Mixed style across the codebase becomes noise fast.
- **`await db.…` is intentional.** Drizzle's better-sqlite3 driver is synchronous, so `astro check` flags the awaits as `ts(80007)` hints. Keep them — they're forward-compat for libsql / Postgres. Do not strip them.
- **Sanitize before storing rich HTML.** Anything that lands in `posts.contentHtml` (or any future field rendered with `<%~ %>` / `set:html`) goes through `sanitizeHtml()` in `src/lib/sanitize.ts` first. The public site renders post HTML raw, and that's only safe because of the on-write sanitization.
- **Comment content is plain text.** No Markdown, no HTML — strip on input, escape on render.
- **Slug uniqueness goes through `uniqueSlug()`** in `src/lib/posts.ts`. Don't write directly to `posts.slug`.
- **Don't roll your own session / cookie logic.** Use the helpers in `src/lib/auth.ts`. Cookie attributes and TTLs need to stay consistent.
- **Settings reads / writes go through `src/lib/settings.ts`.** It handles upsert; the table has no defaults.
- **Authorization is per-action.** Roles: `admin`, `editor`, `author`. `admin` can manage users; `editor` and `admin` can edit any post; `author` only their own; `admin` and `editor` can moderate comments. Helpers live in `src/lib/auth.ts`.
- **Forms are plain HTML POSTs** handled in the page's frontmatter. We don't use Astro Server Actions. After a successful mutation, redirect with a query param (`?saved=1`, `?created=1`, `?comment=pending`) to surface a banner.
- **Comments in code are sparse.** Add one only when the *why* is non-obvious. Don't restate what the code does.

## Working with themes

Themes are runtime — they're not bundled by Vite. They're directories of Eta templates plus a `theme.json`, loaded at request time.

A few load-bearing rules:

- **Templates are Eta with `autoEscape: true`.** Use `<%= %>` for escaped output, `<%~ %>` only for trusted raw HTML (sanitized on the way in).
- **Don't put template-tag substrings inside Eta comments.** Things like `<%=`, `<%~`, `<br>`, `%>`, regex like `/>/g` written inside a `<% /* … */ %>` block can confuse the tokenizer and break the rest of the template. The safe pattern: keep heavy escape / regex logic in the route or a helper, pass pre-rendered HTML to the template, and use `<%~ ctx.someHtml %>`.
- **Themes can ship templates and assets, never executable JavaScript.** Uploaded JS would be RCE-by-design. The hooks API (`src/lib/themes/hooks.ts`) is the extension point — wired by core code only.
- **Asset paths use `theme.assetUrl('foo.css')`.** Don't hardcode `/themes/<slug>/...` in templates.

If you're adding a hook, register it in `src/lib/themes/render.ts` so themes can filter it. New hooks deserve a one-line note in the README hooks list.

## Database changes

- Schema lives in `src/db/schema.ts`. Generate migrations with `npm run db:generate`, apply with `npm run db:migrate`.
- Migrations are SQL files in `./drizzle/` plus snapshots in `./drizzle/meta/`. Both are committed.
- `drizzle-kit` occasionally re-emits previously-applied tables when its meta is out of sync (see [#1](https://github.com/ceqox-software/ZyphoraCMS/issues/1)). If your generated migration includes a `CREATE TABLE` you didn't ask for, hand-trim it before applying — and mention it in the PR.
- Seed scripts (`db:seed`, `db:seed-posts`) must stay idempotent. Re-running them on a populated DB should never destroy work.

## Tests

There's no test runner installed yet. Until that changes, contributors are on the hook for manual verification — list the steps you ran in the PR description. If you want to land tests, that's its own discussion (pick a runner and propose it in an issue first).

## Anything else

If something here is wrong, out of date, or missing, open a PR against this file. The point is to keep the bar low for new contributors.