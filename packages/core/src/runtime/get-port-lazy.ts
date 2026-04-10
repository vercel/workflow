/**
 * Lazy loader for getPort that prevents bundlers (Turbopack, esbuild)
 * from statically tracing @workflow/utils/get-port and its filesystem
 * operations (readdir, readFile, readlink) into the flow route bundle.
 *
 * Uses createRequire with a dynamically constructed specifier so the
 * dependency is invisible to bundler static analysis.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let _getPort: (() => Promise<number | undefined>) | undefined;

export async function getPortLazy(): Promise<number | undefined> {
  if (!_getPort) {
    try {
      // Construct specifier at runtime to defeat bundler static analysis.
      const spec = ['@workflow/utils', 'get-port'].join('/');
      // Use process.cwd()-based createRequire for CJS/ESM compatibility.
      // import.meta.url is unavailable in CJS re-bundled outputs.
      const _require = createRequire(
        pathToFileURL(process.cwd() + '/package.json').href
      );
      const mod = _require(spec);
      _getPort = mod.getPort;
    } catch {
      // Module not available (e.g., in a browser or minimal bundle)
      _getPort = async () => undefined;
    }
  }
  return _getPort!();
}
