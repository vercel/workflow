const matrix = {
  app: [
    {
      name: 'nextjs-turbopack',
      project: 'example-nextjs-workflow-turbopack',
    },
    {
      name: 'nextjs-webpack',
      project: 'example-nextjs-workflow-webpack',
    },
  ],
};

if (process.env.GITHUB_REF === 'refs/heads/main') {
  const newItems = [];

  for (const item of matrix.app) {
    newItems.push({ ...item, canary: true });
  }
  matrix.app.push(...newItems);
}

// Manually add nitro
matrix.app.push({
  name: 'nitro',
  project: 'workbench-nitro-workflow',
});

matrix.app.push({
  name: 'hono',
  project: 'workbench-hono-workflow',
});

console.log(JSON.stringify(matrix));
