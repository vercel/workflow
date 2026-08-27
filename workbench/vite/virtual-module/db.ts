// Stands in for a workspace package consumed as raw TypeScript source that
// assumes it is always processed through Vite (e.g. `@workspace/db` in
// vercel/workflow#3859). The `.js` specifier below is the TypeScript
// NodeNext convention: the file on disk is `.ts`.
import { env } from 'virtual:env/server';

export function getDatabaseUrl(): string {
  return env.DATABASE_URL;
}
