/**
 * Migration runner — CLI entry point for `npm run db:migrate`.
 *
 * Delegates to `runMigrations()` in `src/lib/install-ops.ts` so the web
 * installer can apply migrations from inside the running Astro server
 * without duplicating logic. Idempotent — safe to re-run; drizzle-kit
 * tracks applied migrations in its own bookkeeping table.
 *
 * Calls `process.exit(0)` at the end because the mysql2 pool keeps the
 * event loop alive otherwise (idle connections waiting to be reused).
 */
import { runMigrations } from '../lib/install-ops.ts';

await runMigrations();
console.log('Migrations applied.');
process.exit(0);
