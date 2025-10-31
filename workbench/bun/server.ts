const server = Bun.serve({
  // `routes` requires Bun v1.2.3+
  routes: {
    '/': new Response(await Bun.file('./index.html').text()),
  },

  // (optional) fallback for unmatched routes:
  // Required if Bun's version < 1.2.3
  fetch(req) {
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
