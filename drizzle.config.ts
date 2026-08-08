import type { Config } from 'drizzle-kit';

// drizzle-kit needs DB credentials only for `db:push` and `db:studio`. Migration
// generation (`db:generate`) reads schema.ts directly and doesn't connect.
// Settings are read from the same env vars as the runtime client so there's a
// single source of truth.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    database: process.env.DB_NAME ?? 'zyphora',
  },
} satisfies Config;
