/**
 * Banner that defines CJS-style `__filename`/`__dirname` bindings for ESM
 * server bundles. Some bundled dependencies (and the statically injected
 * world package) reference these identifiers, which don't exist in ESM.
 */
export const WORKFLOW_NODE_FILENAME_BANNER =
  "import { fileURLToPath as __wkfFileURLToPath } from 'node:url'; import { dirname as __wkfDirname } from 'node:path'; const __filename = __wkfFileURLToPath(import.meta.url); const __dirname = __wkfDirname(__filename);";

/**
 * Full Node-compat banner for ESM server bundles: `__filename`/`__dirname`
 * bindings plus a working `require` (via `createRequire`) so bundled
 * dependencies that lazily `require()` node builtins (e.g. undici's
 * `require('node:http2')`) keep working. See the SvelteKit and Nitro
 * plugins for the runtime rationale.
 */
export const WORKFLOW_NODE_COMPAT_BANNER = `import { createRequire as __wkfCreateRequire } from 'node:module'; ${WORKFLOW_NODE_FILENAME_BANNER} if (typeof require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }`;
