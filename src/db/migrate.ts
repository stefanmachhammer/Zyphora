/**
 * Migration runner — CLI entry point for `npm run db:migrate`. Shares
 * `runMigrations()` with the web installer via `src/lib/install-ops.ts`.
 * Idempotent — drizzle-kit tracks applied migrations in its own table.
 */
import { runMigrations } from '../lib/install-ops.ts';

await runMigrations();
console.log('Migrations applied.');
// Explicit exit — the mysql2 pool keeps the event loop alive otherwise.
process.exit(0);
