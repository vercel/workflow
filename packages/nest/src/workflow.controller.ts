import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { All, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { globalSingleton } from '@workflow/utils';
import { join } from 'pathe';

// Configuration, set once at bootstrap and read on every request.
//
// On `globalThis` rather than at module scope because a bundler can compile
// this module into the host application's build more than once (see
// `globalSingleton`), and the copy that `configureWorkflowController()` writes
// would then not be the copy the request path reads, leaving the controller
// unconfigured for the life of the process.
const controllerConfig = globalSingleton(
  '@workflow/nest//controllerConfig',
  1,
  () => ({ outDir: null as string | null })
);

/**
 * Configure the workflow controller with the output directory
 */
export function configureWorkflowController(outDir: string): void {
  controllerConfig.outDir = outDir;
}

/**
 * Convert Express/Fastify request to Web API Request
 */
function toWebRequest(req: any): Request {
  // Works for both Express and Fastify
  const protocol =
    req.protocol ?? (req.raw?.socket?.encrypted ? 'https' : 'http');
  const host = req.headers.host ?? req.hostname;
  const url = req.originalUrl ?? req.url;
  const fullUrl = `${protocol}://${host}${url}`;

  const headers = req.headers;
  const method = req.method;
  const body = req.body;

  return new globalThis.Request(fullUrl, {
    method,
    headers,
    body:
      method !== 'GET' && method !== 'HEAD'
        ? body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body)
        : undefined,
  });
}

/**
 * Send Web API Response back via Express/Fastify response
 */
async function sendWebResponse(
  res: any,
  webResponse: globalThis.Response
): Promise<void> {
  const status = webResponse.status;
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await webResponse.text();

  // Works for both Express and Fastify
  if (typeof res.code === 'function') {
    // Fastify
    res.code(status).headers(headers).send(body);
  } else {
    // Express - use res.end() instead of res.send() to avoid automatic charset addition
    res.status(status);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    // Use res.end() to send the body without Express modifying headers
    res.end(body);
  }
}

function getOutDir(): string {
  if (!controllerConfig.outDir) {
    throw new Error(
      'WorkflowController not configured. Call configureWorkflowController first.'
    );
  }
  return controllerConfig.outDir;
}

export async function loadWorkflowHandler() {
  const outDir = getOutDir();
  await import(pathToFileURL(join(outDir, 'steps.mjs')).href);
  return import(pathToFileURL(join(outDir, 'workflows.mjs')).href);
}

/**
 * Controller that handles the well-known workflow endpoints.
 * Dynamically imports the generated bundles and handles request/response conversion.
 */
@Controller('.well-known/workflow/v1')
export class WorkflowController {
  @Post('flow')
  async handleFlow(@Req() req: any, @Res() res: any) {
    const { POST } = await loadWorkflowHandler();
    const webRequest = toWebRequest(req);
    const webResponse = await POST(webRequest);
    await sendWebResponse(res, webResponse);
  }

  @All('webhook/:token')
  async handleWebhook(@Req() req: any, @Res() res: any) {
    const outDir = getOutDir();
    const { POST } = await import(
      pathToFileURL(join(outDir, 'webhook.mjs')).href
    );
    const webRequest = toWebRequest(req);
    const webResponse = await POST(webRequest);
    await sendWebResponse(res, webResponse);
  }

  @Get('manifest.json')
  async handleManifest(@Res() res: any) {
    if (process.env.WORKFLOW_PUBLIC_MANIFEST !== '1') {
      if (typeof res.code === 'function') {
        res.code(404).send('');
      } else {
        res.status(404).end('');
      }
      return;
    }
    const outDir = getOutDir();
    let manifest: string;
    try {
      manifest = readFileSync(join(outDir, 'manifest.json'), 'utf-8');
    } catch {
      if (typeof res.code === 'function') {
        res.code(404).send('');
      } else {
        res.status(404).end('');
      }
      return;
    }
    const webResponse = new Response(manifest, {
      headers: { 'content-type': 'application/json' },
    });
    await sendWebResponse(res, webResponse);
  }
}
