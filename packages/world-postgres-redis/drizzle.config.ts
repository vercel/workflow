import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://world:world@localhost:5432/world',
  },
  schema: './src/drizzle/schema.ts',
  out: './src/drizzle/migrations',
});
