/**
 * Boundary-checked path prefix test: matches the prefix itself and
 * `<prefix>/...`, `<prefix>#...`, `<prefix>?...` — but not `/docsomething`.
 */
export const hasPathPrefix = (url: string, prefix: string) =>
  url === prefix ||
  url.startsWith(`${prefix}/`) ||
  url.startsWith(`${prefix}#`) ||
  url.startsWith(`${prefix}?`);

export const replacePathPrefix = (
  url: string,
  prefix: string,
  replacement: string
) => `${replacement}${url.slice(prefix.length)}`;
