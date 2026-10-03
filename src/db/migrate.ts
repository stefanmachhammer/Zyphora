import { runMigrations } from '../lib/install-ops.ts';

await runMigrations();
console.log('Migrations applied.');
process.exit(0);
