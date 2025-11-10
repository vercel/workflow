import { renderers } from './renderers.mjs';
import { c as createExports, s as serverEntrypointModule } from './chunks/_@astrojs-ssr-adapter_9__r_ZjJ.mjs';
import { manifest } from './manifest_Dl93wae-.mjs';

const serverIslandMap = new Map();;

const _page0 = () => import('./pages/_image.astro.mjs');
const _page1 = () => import('./pages/.well-known/workflow/v1/flow.astro.mjs');
const _page2 = () => import('./pages/.well-known/workflow/v1/step.astro.mjs');
const _page3 = () => import('./pages/.well-known/workflow/v1/webhook/_token_.astro.mjs');
const _page4 = () => import('./pages/api/hook.astro.mjs');
const _page5 = () => import('./pages/api/test-direct-step-call.astro.mjs');
const _page6 = () => import('./pages/api/trigger.astro.mjs');
const _page7 = () => import('./pages/index.astro.mjs');
const pageMap = new Map([
    ["../../node_modules/.pnpm/astro@5.15.6_@netlify+blobs@9.1.2_@types+node@24.6.2_@vercel+functions@3.1.4_@aws-sdk+c_33d54f21a5540c974d08dc1b122d5cc1/node_modules/astro/dist/assets/endpoint/node.js", _page0],
    ["src/pages/.well-known/workflow/v1/flow.js", _page1],
    ["src/pages/.well-known/workflow/v1/step.js", _page2],
    ["src/pages/.well-known/workflow/v1/webhook/[token].js", _page3],
    ["src/pages/api/hook.ts", _page4],
    ["src/pages/api/test-direct-step-call.ts", _page5],
    ["src/pages/api/trigger.ts", _page6],
    ["src/pages/index.astro", _page7]
]);

const _manifest = Object.assign(manifest, {
    pageMap,
    serverIslandMap,
    renderers,
    actions: () => import('./noop-entrypoint.mjs'),
    middleware: () => import('./_noop-middleware.mjs')
});
const _args = {
    "mode": "standalone",
    "client": "file:///Users/adrianlam/GitHub/workflow/workbench/astro/dist/client/",
    "server": "file:///Users/adrianlam/GitHub/workflow/workbench/astro/dist/server/",
    "host": false,
    "port": 4321,
    "assets": "_astro",
    "experimentalStaticHeaders": false
};
const _exports = createExports(_manifest, _args);
const handler = _exports['handler'];
const startServer = _exports['startServer'];
const options = _exports['options'];
const _start = 'start';
if (Object.prototype.hasOwnProperty.call(serverEntrypointModule, _start)) {
	serverEntrypointModule[_start](_manifest, _args);
}

export { handler, options, pageMap, startServer };
