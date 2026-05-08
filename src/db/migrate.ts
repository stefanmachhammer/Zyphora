import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client.ts';

migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied.');