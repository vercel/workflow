const NORMALIZE_REQUEST_CODE = `
async function normalizeRequest(request) {
  const options = {
    method: request.method,
    headers: new Headers(request.headers)
  };
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) {
    options.body = await request.arrayBuffer();
  }
  return new Request(request.url, options);
}
`;

function replaceGeneratedRouteExport(
  content: string,
  pattern: RegExp,
  replacement: string,
  errorMessage: string
) {
  const replacedContent = content.replace(pattern, replacement);
  if (replacedContent !== content) {
    return replacedContent;
  }

  const sourceMapMarker = '\n//# sourceMappingURL=';
  const sourceMapIndex = content.lastIndexOf(sourceMapMarker);
  if (sourceMapIndex === -1) {
    throw new Error(errorMessage);
  }

  const routeCode = content.slice(0, sourceMapIndex);
  const sourceMap = content.slice(sourceMapIndex);
  const wrappedRouteCode = routeCode.replace(pattern, replacement);
  if (wrappedRouteCode === routeCode) {
    throw new Error(errorMessage);
  }
  return wrappedRouteCode + sourceMap;
}

export { NORMALIZE_REQUEST_CODE, replaceGeneratedRouteExport };
