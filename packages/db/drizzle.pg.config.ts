import { defineConfig } from 'drizzle-kit';

// The Postgres side of the database (DECISIONS.md, D-015 and D-051), for self-hosting.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.pg.ts',
  out: './migrations-pg',
  strict: true,
});
