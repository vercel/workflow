// `waitUntil` hands promises to `@vercel/functions` only where the Vercel
// runtime publishes a request context. Tests that observe `waitUntil` through
// a `@vercel/functions` mock import this first to publish one.
(globalThis as Record<symbol, unknown>)[
  Symbol.for('@vercel/request-context')
] ??= {
  get: () => ({}),
};
