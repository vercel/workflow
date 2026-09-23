// Single source of truth for the Vercel projects the E2E lanes test against,
// and the matrices each Vercel lane in tests.yml runs. The `ci-scope` job
// prints these as step outputs; the lanes read them with fromJSON().

const TEAM_ID = 'team_nO2mCG4W8IxPIeKoSsqwAxxB';

const PROJECTS = [
  {
    name: 'example',
    'project-id': 'prj_xWq20Dd860HHAfzMjK2Mb6TPVxMa',
    'project-slug': 'example-workflow',
  },
  {
    name: 'nextjs-turbopack',
    'project-id': 'prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi',
    'project-slug': 'example-nextjs-workflow-turbopack',
  },
  {
    name: 'nextjs-webpack',
    'project-id': 'prj_avRPBF3eWjh6iDNQgmhH4VOg27h0',
    'project-slug': 'example-nextjs-workflow-webpack',
  },
  {
    name: 'nitro',
    'project-id': 'prj_e7DZirYdLrQKXNrlxg7KmA6ABx8r',
    'project-slug': 'workbench-nitro-workflow',
  },
  {
    name: 'vite',
    'project-id': 'prj_uLIcNZNDmETulAvj5h0IcDHi5432',
    'project-slug': 'workbench-vite-workflow',
  },
  {
    name: 'nuxt',
    'project-id': 'prj_oTgiz3SGX2fpZuM6E0P38Ts8de6d',
    'project-slug': 'workbench-nuxt-workflow',
  },
  {
    name: 'sveltekit',
    'project-id': 'prj_MqnBLm71ceXGSnm3Fs8i8gBnI23G',
    'project-slug': 'workbench-sveltekit-workflow',
  },
  {
    name: 'hono',
    'project-id': 'prj_p0GIEsfl53L7IwVbosPvi9rPSOYW',
    'project-slug': 'workbench-hono-workflow',
  },
  {
    name: 'express',
    'project-id': 'prj_cCZjpBy92VRbKHHbarDMhOHtkuIr',
    'project-slug': 'workbench-express-workflow',
  },
  {
    name: 'fastify',
    'project-id': 'prj_5Yap0VDQ633v998iqQ3L3aQ25Cck',
    'project-slug': 'workbench-fastify-workflow',
  },
  {
    name: 'nest',
    'project-id': 'prj_AV3YrzooDhMlvfmZybqeugHRk48Y',
    'project-slug': 'workbench-nestjs-workflow',
  },
  {
    name: 'astro',
    'project-id': 'prj_YDAXj3K8LM0hgejuIMhioz2yLgTI',
    'project-slug': 'workbench-astro-workflow',
  },
  {
    name: 'tanstack-start',
    'project-id': 'prj_643jeVugTMq5ivsOFQHcbLG1qcnu',
    'project-slug': 'workbench-tanstack-start-workflow',
  },
  {
    name: 'python',
    'project-id': 'prj_MtdPMACTDJnukz8LzWM65Fob0IVU',
    'project-slug': 'workbench-python-workflow',
    // Keeps cross-language coverage visible without blocking JavaScript SDK
    // changes while the Python runtime catches up with the current protocol.
    advisory: true,
    // `vm` selects the JS engine the workflow body runs on; the Python app
    // has one runtime, so only the `node` half of the pair is real.
    vms: ['node'],
  },
];

// Workflow VM engines: node:vm (default) and the opt-in QuickJS WASM engine.
// The e2e runner sets WORKFLOW_VM, and start() stamps it into the run's
// executionContext so the deployed handler runs each workflow on that engine.
const VMS = ['node', 'quickjs'];

// Apps whose WebSocket-transport deployments the WS lane asserts on. Vite is
// here because it resolves `ws`'s absent optional accelerators to a stub
// instead of failing the require, so a build check cannot see the breakage
// and only a masked frame of 48 bytes or more trips it (see
// WORKFLOW_OPTIONAL_WS_NATIVE_MODULES). Every CBOR event frame clears that.
const WS_TRANSPORT_APPS = ['example', 'nextjs-turbopack', 'express', 'vite'];

// One fixture per server shape; see the e2e-vercel-http-transport job for why
// each shape is here and the others are omitted. The first four match the WS
// lane so a failure on one transport can be compared against the other.
const HTTP_TRANSPORT_APPS = [
  'example',
  'nextjs-turbopack',
  'vite',
  'express',
  'nitro',
  'hono',
];

function project(name) {
  const found = PROJECTS.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Unknown Vercel E2E project: ${name}`);
  }
  return found;
}

function appEntry({ vms: _vms, ...app }) {
  return { advisory: false, ...app };
}

function buildMatrices() {
  return {
    'vercel-team-id': TEAM_ID,
    'vercel-projects': Object.fromEntries(
      PROJECTS.map((app) => [app.name, appEntry(app)])
    ),
    'vercel-prod-matrix': {
      include: PROJECTS.flatMap((app) =>
        (app.vms ?? VMS).map((vm) => ({ app: appEntry(app), vm }))
      ),
    },
    'vercel-ws-transport-matrix': {
      include: WS_TRANSPORT_APPS.map((name) => ({
        app: appEntry(project(name)),
      })),
    },
    'vercel-http-transport-matrix': {
      include: HTTP_TRANSPORT_APPS.map((name) => ({
        app: appEntry(project(name)),
      })),
    },
  };
}

function toGithubOutput(matrices) {
  return Object.entries(matrices)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`
    )
    .join('\n');
}

if (require.main === module) {
  console.log(toGithubOutput(buildMatrices()));
}

module.exports = { PROJECTS, TEAM_ID, buildMatrices, toGithubOutput };
