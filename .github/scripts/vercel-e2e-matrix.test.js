const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROJECTS,
  buildMatrices,
  toGithubOutput,
} = require('./vercel-e2e-matrix.js');

const matrices = buildMatrices();

function names(matrix) {
  return matrix.include.map(({ app, vm }) =>
    vm ? `${app.name}/${vm}` : app.name
  );
}

test('project names, IDs, and slugs are unique', () => {
  for (const key of ['name', 'project-id', 'project-slug']) {
    const values = PROJECTS.map((app) => app[key]);
    assert.equal(new Set(values).size, values.length, key);
  }
});

test('the prod lane runs every app on both VMs, except Python on node only', () => {
  const prod = names(matrices['vercel-prod-matrix']);
  assert.equal(prod.length, PROJECTS.length * 2 - 1);
  assert.ok(prod.includes('python/node'));
  assert.ok(!prod.includes('python/quickjs'));
  const advisory = matrices['vercel-prod-matrix'].include
    .filter(({ app }) => app.advisory)
    .map(({ app }) => app.name);
  assert.deepEqual(advisory, ['python']);
});

test('the transport lanes run their fixed app subsets', () => {
  assert.deepEqual(names(matrices['vercel-ws-transport-matrix']), [
    'example',
    'nextjs-turbopack',
    'express',
    'vite',
  ]);
  assert.deepEqual(names(matrices['vercel-http-transport-matrix']), [
    'example',
    'nextjs-turbopack',
    'vite',
    'express',
    'nitro',
    'hono',
  ]);
});

test('matrix entries carry no lane-internal fields', () => {
  for (const { app } of matrices['vercel-prod-matrix'].include) {
    assert.deepEqual(Object.keys(app).sort(), [
      'advisory',
      'name',
      'project-id',
      'project-slug',
    ]);
  }
});

test('outputs are single-line key=value pairs', () => {
  const lines = toGithubOutput(matrices).split('\n');
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf('='))),
    Object.keys(matrices)
  );
  assert.equal(
    JSON.parse(lines[1].slice(lines[1].indexOf('=') + 1))['nextjs-turbopack'][
      'project-id'
    ],
    'prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi'
  );
});
