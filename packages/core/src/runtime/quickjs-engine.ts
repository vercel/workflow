/**
 * Registers the QuickJS workflow engine (see `quickjs-loader.ts`). Imported by
 * `@workflow/core/runtime`; the per-workflow inline entries do not import it.
 */
import { registerQuickJSEngine } from './quickjs-loader.js';

registerQuickJSEngine({
  spec8: () => import('./spec8/quickjs-entrypoint.js'),
  spec9: () => import('./spec9/quickjs-entrypoint.js'),
  runtime: () => import('./quickjs-runtime.js'),
});
