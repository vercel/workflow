import { l as decodeKey } from './chunks/astro/server_DhWKww_t.mjs';
import 'clsx';
import 'cookie';
import { N as NOOP_MIDDLEWARE_FN } from './chunks/astro-designed-error-pages_pFA87nEA.mjs';
import 'es-module-lexer';

function sanitizeParams(params) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, value.normalize().replace(/#/g, "%23").replace(/\?/g, "%3F")];
      }
      return [key, value];
    })
  );
}
function getParameter(part, params) {
  if (part.spread) {
    return params[part.content.slice(3)] || "";
  }
  if (part.dynamic) {
    if (!params[part.content]) {
      throw new TypeError(`Missing parameter: ${part.content}`);
    }
    return params[part.content];
  }
  return part.content.normalize().replace(/\?/g, "%3F").replace(/#/g, "%23").replace(/%5B/g, "[").replace(/%5D/g, "]");
}
function getSegment(segment, params) {
  const segmentPath = segment.map((part) => getParameter(part, params)).join("");
  return segmentPath ? "/" + segmentPath : "";
}
function getRouteGenerator(segments, addTrailingSlash) {
  return (params) => {
    const sanitizedParams = sanitizeParams(params);
    let trailing = "";
    if (addTrailingSlash === "always" && segments.length) {
      trailing = "/";
    }
    const path = segments.map((segment) => getSegment(segment, sanitizedParams)).join("") + trailing;
    return path || "/";
  };
}

function deserializeRouteData(rawRouteData) {
  return {
    route: rawRouteData.route,
    type: rawRouteData.type,
    pattern: new RegExp(rawRouteData.pattern),
    params: rawRouteData.params,
    component: rawRouteData.component,
    generate: getRouteGenerator(rawRouteData.segments, rawRouteData._meta.trailingSlash),
    pathname: rawRouteData.pathname || void 0,
    segments: rawRouteData.segments,
    prerender: rawRouteData.prerender,
    redirect: rawRouteData.redirect,
    redirectRoute: rawRouteData.redirectRoute ? deserializeRouteData(rawRouteData.redirectRoute) : void 0,
    fallbackRoutes: rawRouteData.fallbackRoutes.map((fallback) => {
      return deserializeRouteData(fallback);
    }),
    isIndex: rawRouteData.isIndex,
    origin: rawRouteData.origin
  };
}

function deserializeManifest(serializedManifest) {
  const routes = [];
  for (const serializedRoute of serializedManifest.routes) {
    routes.push({
      ...serializedRoute,
      routeData: deserializeRouteData(serializedRoute.routeData)
    });
    const route = serializedRoute;
    route.routeData = deserializeRouteData(serializedRoute.routeData);
  }
  const assets = new Set(serializedManifest.assets);
  const componentMetadata = new Map(serializedManifest.componentMetadata);
  const inlinedScripts = new Map(serializedManifest.inlinedScripts);
  const clientDirectives = new Map(serializedManifest.clientDirectives);
  const serverIslandNameMap = new Map(serializedManifest.serverIslandNameMap);
  const key = decodeKey(serializedManifest.key);
  return {
    // in case user middleware exists, this no-op middleware will be reassigned (see plugin-ssr.ts)
    middleware() {
      return { onRequest: NOOP_MIDDLEWARE_FN };
    },
    ...serializedManifest,
    assets,
    componentMetadata,
    inlinedScripts,
    clientDirectives,
    routes,
    serverIslandNameMap,
    key
  };
}

const manifest = deserializeManifest({"hrefRoot":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/","cacheDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/node_modules/.astro/","outDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/dist/","srcDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/src/","publicDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/public/","buildClientDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/dist/client/","buildServerDir":"file:///Users/adrianlam/GitHub/workflow/workbench/astro/dist/server/","adapterName":"@astrojs/node","routes":[{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"type":"page","component":"_server-islands.astro","params":["name"],"segments":[[{"content":"_server-islands","dynamic":false,"spread":false}],[{"content":"name","dynamic":true,"spread":false}]],"pattern":"^\\/_server-islands\\/([^/]+?)\\/?$","prerender":false,"isIndex":false,"fallbackRoutes":[],"route":"/_server-islands/[name]","origin":"internal","_meta":{"trailingSlash":"ignore"}}},{"file":"index.html","links":[],"scripts":[],"styles":[],"routeData":{"route":"/","isIndex":true,"type":"page","pattern":"^\\/$","segments":[],"params":[],"component":"src/pages/index.astro","pathname":"/","prerender":true,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"type":"endpoint","isIndex":false,"route":"/_image","pattern":"^\\/_image\\/?$","segments":[[{"content":"_image","dynamic":false,"spread":false}]],"params":[],"component":"../../node_modules/.pnpm/astro@5.15.6_@netlify+blobs@9.1.2_@types+node@24.6.2_@vercel+functions@3.1.4_@aws-sdk+c_33d54f21a5540c974d08dc1b122d5cc1/node_modules/astro/dist/assets/endpoint/node.js","pathname":"/_image","prerender":false,"fallbackRoutes":[],"origin":"internal","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/.well-known/workflow/v1/flow","isIndex":false,"type":"endpoint","pattern":"^\\/\\.well-known\\/workflow\\/v1\\/flow\\/?$","segments":[[{"content":".well-known","dynamic":false,"spread":false}],[{"content":"workflow","dynamic":false,"spread":false}],[{"content":"v1","dynamic":false,"spread":false}],[{"content":"flow","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/.well-known/workflow/v1/flow.js","pathname":"/.well-known/workflow/v1/flow","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/.well-known/workflow/v1/step","isIndex":false,"type":"endpoint","pattern":"^\\/\\.well-known\\/workflow\\/v1\\/step\\/?$","segments":[[{"content":".well-known","dynamic":false,"spread":false}],[{"content":"workflow","dynamic":false,"spread":false}],[{"content":"v1","dynamic":false,"spread":false}],[{"content":"step","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/.well-known/workflow/v1/step.js","pathname":"/.well-known/workflow/v1/step","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/.well-known/workflow/v1/webhook/[token]","isIndex":false,"type":"endpoint","pattern":"^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^/]+?)\\/?$","segments":[[{"content":".well-known","dynamic":false,"spread":false}],[{"content":"workflow","dynamic":false,"spread":false}],[{"content":"v1","dynamic":false,"spread":false}],[{"content":"webhook","dynamic":false,"spread":false}],[{"content":"token","dynamic":true,"spread":false}]],"params":["token"],"component":"src/pages/.well-known/workflow/v1/webhook/[token].js","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/hook","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/hook\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"hook","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/hook.ts","pathname":"/api/hook","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/test-direct-step-call","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/test-direct-step-call\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"test-direct-step-call","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/test-direct-step-call.ts","pathname":"/api/test-direct-step-call","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}},{"file":"","links":[],"scripts":[],"styles":[],"routeData":{"route":"/api/trigger","isIndex":false,"type":"endpoint","pattern":"^\\/api\\/trigger\\/?$","segments":[[{"content":"api","dynamic":false,"spread":false}],[{"content":"trigger","dynamic":false,"spread":false}]],"params":[],"component":"src/pages/api/trigger.ts","pathname":"/api/trigger","prerender":false,"fallbackRoutes":[],"distURL":[],"origin":"project","_meta":{"trailingSlash":"ignore"}}}],"base":"/","trailingSlash":"ignore","compressHTML":true,"componentMetadata":[["/Users/adrianlam/GitHub/workflow/workbench/astro/src/pages/index.astro",{"propagation":"none","containsHead":true}]],"renderers":[],"clientDirectives":[["idle","(()=>{var l=(n,t)=>{let i=async()=>{await(await n())()},e=typeof t.value==\"object\"?t.value:void 0,s={timeout:e==null?void 0:e.timeout};\"requestIdleCallback\"in window?window.requestIdleCallback(i,s):setTimeout(i,s.timeout||200)};(self.Astro||(self.Astro={})).idle=l;window.dispatchEvent(new Event(\"astro:idle\"));})();"],["load","(()=>{var e=async t=>{await(await t())()};(self.Astro||(self.Astro={})).load=e;window.dispatchEvent(new Event(\"astro:load\"));})();"],["media","(()=>{var n=(a,t)=>{let i=async()=>{await(await a())()};if(t.value){let e=matchMedia(t.value);e.matches?i():e.addEventListener(\"change\",i,{once:!0})}};(self.Astro||(self.Astro={})).media=n;window.dispatchEvent(new Event(\"astro:media\"));})();"],["only","(()=>{var e=async t=>{await(await t())()};(self.Astro||(self.Astro={})).only=e;window.dispatchEvent(new Event(\"astro:only\"));})();"],["visible","(()=>{var a=(s,i,o)=>{let r=async()=>{await(await s())()},t=typeof i.value==\"object\"?i.value:void 0,c={rootMargin:t==null?void 0:t.rootMargin},n=new IntersectionObserver(e=>{for(let l of e)if(l.isIntersecting){n.disconnect(),r();break}},c);for(let e of o.children)n.observe(e)};(self.Astro||(self.Astro={})).visible=a;window.dispatchEvent(new Event(\"astro:visible\"));})();"]],"entryModules":{"\u0000noop-middleware":"_noop-middleware.mjs","\u0000virtual:astro:actions/noop-entrypoint":"noop-entrypoint.mjs","\u0000@astro-page:src/pages/.well-known/workflow/v1/flow@_@js":"pages/.well-known/workflow/v1/flow.astro.mjs","\u0000@astro-page:src/pages/.well-known/workflow/v1/step@_@js":"pages/.well-known/workflow/v1/step.astro.mjs","\u0000@astro-page:src/pages/.well-known/workflow/v1/webhook/[token]@_@js":"pages/.well-known/workflow/v1/webhook/_token_.astro.mjs","\u0000@astro-page:src/pages/api/hook@_@ts":"pages/api/hook.astro.mjs","\u0000@astro-page:src/pages/api/test-direct-step-call@_@ts":"pages/api/test-direct-step-call.astro.mjs","\u0000@astro-page:src/pages/api/trigger@_@ts":"pages/api/trigger.astro.mjs","\u0000@astro-page:src/pages/index@_@astro":"pages/index.astro.mjs","\u0000@astrojs-ssr-virtual-entry":"entry.mjs","\u0000@astro-renderers":"renderers.mjs","\u0000@astro-page:../../node_modules/.pnpm/astro@5.15.6_@netlify+blobs@9.1.2_@types+node@24.6.2_@vercel+functions@3.1.4_@aws-sdk+c_33d54f21a5540c974d08dc1b122d5cc1/node_modules/astro/dist/assets/endpoint/node@_@js":"pages/_image.astro.mjs","\u0000@astrojs-ssr-adapter":"_@astrojs-ssr-adapter.mjs","\u0000@astrojs-manifest":"manifest_Dl93wae-.mjs","/Users/adrianlam/GitHub/workflow/node_modules/.pnpm/unstorage@1.17.2_@netlify+blobs@9.1.2_@vercel+functions@3.1.4_@aws-sdk+credential-provi_3128ad0acdbf5fcd10d3fd4ae6facc53/node_modules/unstorage/drivers/fs-lite.mjs":"chunks/fs-lite_COtHaKzy.mjs","/Users/adrianlam/GitHub/workflow/node_modules/.pnpm/astro@5.15.6_@netlify+blobs@9.1.2_@types+node@24.6.2_@vercel+functions@3.1.4_@aws-sdk+c_33d54f21a5540c974d08dc1b122d5cc1/node_modules/astro/dist/assets/services/sharp.js":"chunks/sharp_CR567j69.mjs","/Users/adrianlam/GitHub/workflow/node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/index.js":"chunks/index_DqQ8k47W.mjs","astro:scripts/before-hydration.js":""},"inlinedScripts":[],"assets":["/favicon.svg","/index.html"],"buildFormat":"directory","checkOrigin":true,"allowedDomains":[],"serverIslandNameMap":[],"key":"HL0UuLEHejpYckGtqBgG3AGwkjtu7IQ2osDhkMDvjVM=","sessionConfig":{"driver":"fs-lite","options":{"base":"/Users/adrianlam/GitHub/workflow/workbench/astro/node_modules/.astro/sessions"}}});
if (manifest.sessionConfig) manifest.sessionConfig.driverModule = () => import('./chunks/fs-lite_COtHaKzy.mjs');

export { manifest };
