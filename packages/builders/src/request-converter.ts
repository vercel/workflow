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
  const sourceMapMarker = '\n//# sourceMappingURL=';
  const sourceMapIndex = content.lastIndexOf(sourceMapMarker);
  const routeCode =
    sourceMapIndex === -1 ? content : content.slice(0, sourceMapIndex);
  const sourceMap = sourceMapIndex === -1 ? '' : content.slice(sourceMapIndex);
  const wrappedRouteCode = routeCode.replace(pattern, replacement);
  if (wrappedRouteCode === routeCode) {
    throw new Error(errorMessage);
  }
  return wrappedRouteCode + sourceMap;
}

export { NORMALIZE_REQUEST_CODE, replaceGeneratedRouteExport };
