// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

// mysql2 is treated as a server-only external so Vite doesn't try to bundle
// it for the client. (better-sqlite3 needed the same treatment for the same
// reason — native bindings can't be bundled.)
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  vite: {
    optimizeDeps: { exclude: ['mysql2'] },
    ssr: { external: ['mysql2'] },
  },
});
