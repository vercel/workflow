const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
]);

/**
 * Globals a module-level declaration must not shadow: a step named after one
 * of these would silently replace it for every other function in the file.
 */
const GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'Array',
  'Blob',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'FormData',
  'Headers',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'global',
  'globalThis',
  'module',
  'process',
  'queueMicrotask',
  'require',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'window',
  // Names the migrated code imports from `workflow` / `workflow/api`.
  'createHook',
  'getStepMetadata',
  'getWorkflowMetadata',
  'getWritable',
  'sleep',
  'start',
  'FatalError',
  'RetryableError',
  'workflowFetch',
]);

/**
 * Turn an Inngest step or function ID such as `send-welcome-email` into a
 * camelCase identifier (`sendWelcomeEmail`). Returns `undefined` when the ID
 * has no usable characters.
 */
export function camelCaseIdentifier(id: string): string | undefined {
  const parts = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  let name = parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join('');
  if (/^[0-9]/.test(name)) name = `step${name}`;
  return name;
}

/**
 * Allocates module-level names that collide with nothing the file already
 * uses, nothing allocated before, no reserved word and no common global.
 */
export class NameAllocator {
  private readonly taken: Set<string>;

  constructor(usedIdentifiers: Iterable<string>) {
    this.taken = new Set(usedIdentifiers);
  }

  isFree(name: string): boolean {
    return !this.taken.has(name) && !RESERVED.has(name) && !GLOBALS.has(name);
  }

  reserve(name: string): void {
    this.taken.add(name);
  }

  allocate(base: string, suffix = 'Step'): string {
    let candidate = base;
    if (!this.isFree(candidate)) candidate = `${base}${suffix}`;
    let n = 2;
    while (!this.isFree(candidate)) {
      candidate = `${base}${suffix}${n++}`;
    }
    this.taken.add(candidate);
    return candidate;
  }
}
