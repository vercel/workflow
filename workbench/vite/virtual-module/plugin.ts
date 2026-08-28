import { fileURLToPath } from 'node:url';
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
  const helper = fileURLToPath(new URL('./helper.ts', import.meta.url));
  let databaseUrl = 'before-build-start';
  return {
    name: 'workbench:virtual-env',
    buildStart() {
      databaseUrl = 'postgres://virtual';
    },
    resolveId(source, importer) {
      if (source === id) return resolved;
      if (source === './helper.ts' && importer === resolved) return helper;
    },
    load(loadId) {
      if (loadId === resolved) {
        return `import { appendDatabaseName } from './helper.ts';\nexport const env = { DATABASE_URL: appendDatabaseName('${databaseUrl}', '/raw') };`;
      }
    },
    transform(code, transformId) {
      if (transformId === resolved) {
        return code.replace("'/raw'", "'/transformed'");
      }
    },
  };
}
