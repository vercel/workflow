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

/**
 * Streaming variant of `normalizeRequest` for pre-auth request paths
 * (e.g. the public webhook route). The body is passed through as a
 * stream instead of being buffered with `arrayBuffer()`, so requests
 * with an invalid webhook token are rejected without ever consuming the
 * request body. Eagerly buffering before token validation lets
 * unauthenticated attackers force full body buffering on every invalid
 * request (pre-auth resource exhaustion / DoS amplification).
 */
const STREAMING_NORMALIZE_REQUEST_CODE = `
function normalizeRequestStreaming(request) {
  const options = {
    method: request.method,
    headers: new Headers(request.headers)
  };
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) {
    // Do NOT buffer the body here: it must only be consumed after the
    // webhook token has been validated.
    options.body = request.body;
    // Required by Node.js (undici) when passing a ReadableStream body.
    options.duplex = 'half';
  }
  return new Request(request.url, options);
}
`;

export { NORMALIZE_REQUEST_CODE, STREAMING_NORMALIZE_REQUEST_CODE };
