import '../../../../../chunks/index_ePTMDSOu.mjs';
import 'ms';
import '@jridgewell/sourcemap-codec';
import { r as resumeWebhook } from '../../../../../chunks/resume-hook_BHshEMMl.mjs';
export { renderers } from '../../../../../renderers.mjs';

process.on("unhandledRejection", (reason) => { if (reason !== undefined) console.error("Unhandled rejection detected", reason); });

async function handler(request, token) {

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const response = await resumeWebhook(token, request);
    return response;
  } catch (error) {
    // TODO: differentiate between invalid token and other errors
    console.error('Error during resumeWebhook', error);
    return new Response(null, { status: 404 });
  }
}


async function normalizeRequestConverter(request) {
  const options = {
    method: request.method,
    headers: new Headers(request.headers)
  };
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) {
    options.body = await request.arrayBuffer();
  }
  return new Request(request.url, options);
}

const createHandler = (method) => async ({ request, params, platform }) => {
  const normalRequest = await normalizeRequestConverter(request);
  const response = await handler(normalRequest, params.token);
  return response;
};

const GET = createHandler();
const POST = createHandler();
const PUT = createHandler();
const PATCH = createHandler();
const DELETE = createHandler();
const HEAD = createHandler();
const OPTIONS = createHandler();

const prerender = false;

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
  prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
