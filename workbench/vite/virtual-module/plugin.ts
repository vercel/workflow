import type { Plugin } from 'vite';

/**
 * Regression fixture for vercel/workflow#3859: a plugin that serves a module
 * id nothing on disk can satisfy, standing in for real-world plugins like
 * `@vite-env/core` (`virtual:env/server`).
 *
 * `./db.ts` imports it and a step reaches `./db.ts`, so the dev steps bundle —
 * which inlines project-local step dependencies — can only be built if the
 * builder can ask Vite to resolve and load this id.
 */
export function virtualEnv(): Plugin {
  const id = 'virtual:env/server';
  const resolved = `\0${id}`;
  return {
    name: 'workbench:virtual-env',
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(loadId) {
      if (loadId === resolved) {
        return `export const env = { DATABASE_URL: 'postgres://virtual' };`;
      }
    },
  };
}
