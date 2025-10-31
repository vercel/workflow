import workflowPlugin from 'workflow/bun';

await Bun.plugin(workflowPlugin());

const flow = await import('./.workflows/workflows.js');
const step = await import('./.workflows/steps.js');
const webhook = await import('./.workflows/webhook.js');

const server = Bun.serve({
  port: 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (
      url.pathname === '/.well-known/workflow/v1/flow' &&
      req.method === 'POST'
    ) {
      return flow.POST(req);
    }

    if (
      url.pathname === '/.well-known/workflow/v1/step' &&
      req.method === 'POST'
    ) {
      return step.POST(req);
    }

    if (url.pathname.startsWith('/.well-known/workflow/v1/webhook/')) {
      const handler = webhook[req.method as keyof typeof webhook];
      if (handler && typeof handler === 'function') {
        return handler(req);
      }
    }

    if (url.pathname === '/') {
      return new Response(await Bun.file('./index.html').text(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
