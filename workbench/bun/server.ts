import workflowPlugin from 'workflow/bun';

Bun.plugin(workflowPlugin());

const server = Bun.serve({
  // `routes` requires Bun v1.2.3+
  routes: {
    '/': new Response(await Bun.file('./index.html').text()),
  },

  // (optional) fallback for unmatched routes:
  // Required if Bun's version < 1.2.3
  fetch(_) {
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
