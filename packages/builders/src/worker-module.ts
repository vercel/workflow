import { IN_PROCESS_QUEUE_HANDLER } from '@workflow/world';

/**
 * The module an app imports from its startup hook to run the process as a
 * worker for a World that delivers in process (the Postgres World). It is
 * generated next to the flow route, so the import of the route is relative
 * and the framework compiles both together.
 *
 * - `routeSpecifier`: the generated flow route module, relative to the
 *   worker module (`./route.js`, `./+server.js`, `./flow.js`).
 * - `wrapped`: the route's `POST` takes the framework's `{ request }` event
 *   (SvelteKit, Astro) rather than a `Request`.
 * - `reloads`: load the route on every delivery with a dynamic `import()`,
 *   for a development server whose module loader returns the rebuilt route
 *   after a workflow file changes (Vite); the handler is registered with
 *   `reloads: true` so an evaluation of the route does not replace it. Not
 *   for a bundler whose `import()` keeps returning the first module
 *   (Turbopack): there, import the route once, and the rebuilt route
 *   re-registers itself when the module is evaluated again.
 */
export function createWorkflowWorkerModuleCode({
  routeSpecifier,
  wrapped = false,
  reloads = false,
}: {
  routeSpecifier: string;
  wrapped?: boolean;
  reloads?: boolean;
}): string {
  const specifier = JSON.stringify(routeSpecifier);
  const entry = `Symbol.for(${JSON.stringify(IN_PROCESS_QUEUE_HANDLER.description)})`;
  const call = wrapped ? '({ request })' : '(request)';
  const route = reloads
    ? `// Loaded on every delivery, so a route the development server rebuilt is
// what runs.
const loadRoute = async () => (await import(${specifier})).POST;
const route = Object.assign(
  async (request) => (await loadRoute())${call},
  { [${entry}]: async (request) => (await loadRoute())[${entry}](request) }
);`
    : `import { POST } from ${specifier};

const route = POST;`;
  return `// biome-ignore-all lint: generated file
/* eslint-disable */
import { getWorld, registerWorkflowHandler } from 'workflow/runtime';
${route}

/**
 * Hands the flow route to the World, for a World that delivers in process
 * (the Postgres World); nothing happens on any other World. Every delivery
 * then runs in this process, through the route's in-process entry, never
 * over HTTP.
 */
export async function registerWorkflowWorker() {
  return registerWorkflowHandler(route${reloads ? ', { reloads: true }' : ''});
}

/**
 * Runs this process as a Workflow worker: hands the flow route to the World
 * and starts the World, so a copy of the app that serves no web traffic
 * still runs jobs. Call it from the app's startup hook when the app uses a
 * World that delivers in process.
 */
export async function startWorkflowWorker() {
  await registerWorkflowWorker();
  const world = await getWorld();
  await world.start?.();
}
`;
}
