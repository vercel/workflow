// Unreserved URL characters only. A route prefix is both a URL segment and a
// directory name below `app/`, so anything that needs escaping in either place
// (dynamic segments like `[slug]`, spaces, `%`, `:`) is rejected rather than
// silently producing a route that cannot be addressed.
const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

// The error names the public option because that is where nearly every prefix
// comes from, but it does not claim the caller used `withWorkflow()`: the
// builder validates its own config too, and a custom integration can set the
// field directly.
function invalid(prefix: string, reason: string): Error {
  return new Error(
    `Invalid workflow route prefix ${JSON.stringify(prefix)}: ${reason}. ` +
      '`workflows.experimentalRoutePrefix` expects a path such as "/ship".'
  );
}

function assertPathShape(prefix: string, trimmed: string): void {
  // `//host/path` carries no scheme, so the `://` test alone would let a URL
  // through and silently reinterpret its host as the first path segment.
  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    throw invalid(prefix, 'expected a path, not a URL');
  }
  if (/[?#]/.test(trimmed)) {
    throw invalid(prefix, 'a query string or fragment is not part of a path');
  }
  if (trimmed.includes('\\')) {
    throw invalid(prefix, 'path segments are separated by "/"');
  }
}

function assertSegment(prefix: string, segment: string): void {
  if (segment === '') {
    throw invalid(prefix, 'it contains an empty path segment');
  }
  if (segment === '.' || segment === '..') {
    throw invalid(prefix, 'relative path segments are not allowed');
  }
  // Next.js opts `_`-prefixed folders and everything below them out of
  // routing, so such a prefix would build and then answer 404 for every queue
  // delivery and webhook.
  if (segment.startsWith('_')) {
    throw invalid(
      prefix,
      `the segment ${JSON.stringify(segment)} starts with "_", which Next.js excludes from routing`
    );
  }
  if (!SEGMENT_PATTERN.test(segment)) {
    throw invalid(
      prefix,
      `the segment ${JSON.stringify(segment)} may only contain letters, numbers, ".", "_", "~" or "-"`
    );
  }
}

/**
 * Normalizes the experimental workflow route prefix to a leading slash with no
 * trailing slash (`ship/` -> `/ship`), or undefined when no prefix is
 * configured. Undefined is preserved rather than collapsed to `''` so callers
 * can keep emitting exactly what they emitted before this option existed.
 */
export function normalizeWorkflowRoutePrefix(
  prefix: string | undefined
): string | undefined {
  if (prefix === undefined || prefix === null) {
    return undefined;
  }
  if (typeof prefix !== 'string') {
    throw invalid(String(prefix), 'expected a string');
  }

  const trimmed = prefix.trim();
  if (trimmed === '' || trimmed === '/') {
    return undefined;
  }
  assertPathShape(prefix, trimmed);

  const segments = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  for (const segment of segments) {
    assertSegment(prefix, segment);
  }

  return `/${segments.join('/')}`;
}

/**
 * The prefix as a path fragment relative to a directory (`/ship` -> `ship`),
 * for joining below `app/` or `public/`. Returns `''` when there is no prefix,
 * which `path.join` drops, so unprefixed layouts keep their exact paths.
 */
export function workflowRoutePrefixDirectory(
  prefix: string | undefined
): string {
  // Nullish rather than `=== undefined`, matching `normalizeWorkflowRoutePrefix`:
  // both are reachable from untyped `next.config.js`.
  return prefix ? prefix.replace(/^\/+/, '') : '';
}

/**
 * The base path the workflow runtime resolves its own URLs against: Next.js'
 * `basePath` (which moves the whole app) followed by the workflow route prefix
 * (which moves only the workflow routes). Returns undefined when neither is
 * set, so generated route files stay byte-identical to what they were before
 * either option was used.
 */
export function joinWorkflowBasePath(
  basePath: string | undefined,
  routePrefix: string | undefined
): string | undefined {
  const joined = `${basePath ?? ''}${routePrefix ?? ''}`;
  return joined === '' ? undefined : joined;
}
