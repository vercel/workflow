import { URL } from 'node:url';
import { afterAll, vi } from 'vitest';

// Vitest 5’s `jsdom` replaces the global `URL` with a subclass of Node’s `URL`.
// Because `@workflow/core` expects the `href` getter directly on `URL.prototype`,
// importing it throws before tests even run. This stub restores Node’s `URL` so
// the package can initialize properly.
vi.stubGlobal('URL', URL);

afterAll(() => {
  vi.unstubAllGlobals();
});
