import { All, Controller, Post, Req, Res } from '@nestjs/common';
import { join } from 'pathe';

// Module-level state for configuration
let configuredOutDir: string | null = null;

/**
 * Configure the workflow controller with the output directory
 */
export function configureWorkflowController(outDir: string): void {
  configuredOutDir = outDir;
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
  if (!configuredOutDir) {
    throw new Error(
      'WorkflowController not configured. Call configureWorkflowController first.'
    );
  }
  return configuredOutDir;
}

/**
 * Controller that handles the well-known workflow endpoints.
 * Dynamically imports the generated bundles and handles request/response conversion.
 */
@Controller('.well-known/workflow/v1')
export class WorkflowController {
  @Post('step')
  async handleStep(@Req() req: any, @Res() res: any) {
    const outDir = getOutDir();
    const { POST } = await import(join(outDir, 'steps.mjs'));
    const webRequest = toWebRequest(req);
    const webResponse = await POST(webRequest);
    await sendWebResponse(res, webResponse);
  }

  @Post('flow')
  async handleFlow(@Req() req: any, @Res() res: any) {
    const outDir = getOutDir();
    const { POST } = await import(join(outDir, 'workflows.mjs'));
    const webRequest = toWebRequest(req);
    const webResponse = await POST(webRequest);
    await sendWebResponse(res, webResponse);
  }

  @All('webhook/:token')
  async handleWebhook(@Req() req: any, @Res() res: any) {
    const outDir = getOutDir();
    const { POST } = await import(join(outDir, 'webhook.mjs'));
    const webRequest = toWebRequest(req);
    const webResponse = await POST(webRequest);
    await sendWebResponse(res, webResponse);
  }
}
