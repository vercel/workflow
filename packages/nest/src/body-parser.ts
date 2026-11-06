/**
 * Keep the host application's body parser away from the workflow routes.
 *
 * The queue delivers a run's input, a step's input and a step's output in the
 * HTTP body of a `POST /.well-known/workflow/v1/flow`, so those bodies are as
 * large as the data a workflow passes around. Express's body parser — which
 * NestJS installs by default — rejects anything over 100 KB with `413 request
 * entity too large` before the request reaches a controller, so a workflow
 * that passes a modest array around stops making progress and the only trace
 * is a 413 in the queue's retry log.
 *
 * Nest registers its parsers inside `app.init()`, before any module's
 * `onModuleInit` runs, so a module cannot get in front of them. It can,
 * however, make them stand aside for one path: the parser is an ordinary
 * Express middleware in the application's router stack, and replacing its
 * handle with one that calls `next()` for workflow routes leaves the request
 * stream unread for {@link toWebRequest} to consume. The application's own
 * routes keep the parser, and the limit, they were configured with.
 */

import { isWorkflowRoutePath, requestPath } from './workflow-routes.js';

/**
 * Names `body-parser` gives the middleware it returns. Express re-exports
 * `body-parser` as `express.json()` and friends, and NestJS's `ExpressAdapter`
 * calls those, so every parser an application can end up with — whether
 * installed by Nest, by `app.useBodyParser()`, or by a bare `app.use()` —
 * arrives under one of these names.
 */
const BODY_PARSER_NAMES = new Set([
  'jsonParser',
  'urlencodedParser',
  'textParser',
  'rawParser',
]);

/** Marks a handle this module already wrapped, so repeat calls are no-ops. */
const BYPASSED = Symbol.for('@workflow/nest/bodyParserBypassed');

/** Fastify's default `bodyLimit`, 1 MiB. */
export const FASTIFY_DEFAULT_BODY_LIMIT = 1024 * 1024;

export type BodyParserBypass =
  | {
      platform: 'express';
      /** Parser middleware names that now stand aside for workflow routes. */
      bypassed: string[];
    }
  | {
      platform: 'fastify';
      /** The limit Fastify enforces, or `undefined` if it is unreadable. */
      bodyLimit: number | undefined;
    }
  | { platform: 'unknown' };

type ExpressLayer = {
  name?: string;
  handle?: unknown;
};

type ExpressRouter = { stack?: ExpressLayer[] };

type ExpressLike = {
  /**
   * Express 5 exposes the router directly. Express 4 keeps it as `_router`
   * and defines `router` as a getter that throws `'app.router' is
   * deprecated!`, so `_router` has to be read first.
   */
  router?: ExpressRouter;
  _router?: ExpressRouter;
};

type AdapterLike = {
  getType?: () => string;
  getInstance?: () => unknown;
};

type AppLike = { getHttpAdapter?: () => AdapterLike };

/** Accept a Nest application, an HTTP adapter, or the platform instance. */
function resolveAdapter(target: unknown): AdapterLike | undefined {
  const app = target as AppLike | null | undefined;
  if (typeof app?.getHttpAdapter === 'function') return app.getHttpAdapter();
  const adapter = target as AdapterLike | null | undefined;
  if (typeof adapter?.getInstance === 'function') return adapter;
  return undefined;
}

function expressRouterOf(instance: unknown): ExpressRouter | undefined {
  const app = instance as ExpressLike | null | undefined;
  let router: ExpressRouter | undefined;
  try {
    router = app?._router ?? app?.router;
  } catch {
    // Express 4 before any middleware was registered: `_router` does not
    // exist yet and `router` throws. There is no parser to bypass.
    return undefined;
  }
  return Array.isArray(router?.stack) ? router : undefined;
}

type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;

/**
 * Whether the body arrives compressed.
 *
 * `body-parser` inflates `content-encoding: gzip|deflate|br` before handing the
 * bytes on, and nothing downstream of the bypass does. Compressed bodies
 * therefore keep going through the parser: a correct body under the size limit
 * beats raw bytes nothing can read. The queue never compresses at the HTTP
 * layer — payload compression happens inside the serialized value — so this
 * only ever applies to a webhook sender that opted into it.
 */
function isEncoded(req: unknown): boolean {
  const headers = (req as { headers?: Record<string, unknown> } | undefined)
    ?.headers;
  const encoding = headers?.['content-encoding'];
  if (typeof encoding !== 'string') return false;
  const normalized = encoding.trim().toLowerCase();
  return normalized !== '' && normalized !== 'identity';
}

function wrap(parser: Middleware, globalPrefix: string): Middleware {
  const bypassing: Middleware = function workflowBodyParserBypass(
    req,
    res,
    next
  ) {
    if (
      isWorkflowRoutePath(requestPath(req), globalPrefix) &&
      !isEncoded(req)
    ) {
      return next();
    }
    return parser(req, res, next);
  };
  (bypassing as unknown as Record<symbol, boolean>)[BYPASSED] = true;
  return bypassing;
}

function bypassExpress(
  instance: unknown,
  globalPrefix: string
): BodyParserBypass {
  const router = expressRouterOf(instance);
  const bypassed: string[] = [];
  for (const layer of router?.stack ?? []) {
    const handle = layer.handle;
    if (typeof handle !== 'function') continue;
    if ((handle as unknown as Record<symbol, boolean>)[BYPASSED]) continue;
    const name = handle.name;
    if (!BODY_PARSER_NAMES.has(name)) continue;
    const wrapped = wrap(handle as Middleware, globalPrefix);
    layer.handle = wrapped;
    // A future Express could make `handle` a read-only accessor. Only report a
    // parser as bypassed once the replacement is actually in place.
    if (layer.handle === wrapped) bypassed.push(name);
  }
  return { platform: 'express', bypassed };
}

function fastifyBodyLimit(instance: unknown): number | undefined {
  const config = (
    instance as { initialConfig?: { bodyLimit?: unknown } } | null | undefined
  )?.initialConfig;
  return typeof config?.bodyLimit === 'number' ? config.bodyLimit : undefined;
}

/**
 * Stop the application's body parsers from consuming workflow requests.
 *
 * Call it after the HTTP adapter exists and before the server starts serving;
 * `WorkflowModule` does this for you during `onModuleInit` unless
 * `bypassBodyParser` is turned off.
 *
 * `globalPrefix` is the NestJS global prefix the workflow routes are served
 * under, so only those routes are matched; an application route that merely
 * contains `.well-known/workflow/v1` keeps its parser.
 *
 * On Fastify nothing is patched: its body limit is enforced by the framework
 * before any content-type parser runs and is configured per instance rather
 * than per route, so the reported `bodyLimit` is for the caller to act on.
 */
export function bypassWorkflowBodyParsers(
  target: unknown,
  globalPrefix = ''
): BodyParserBypass {
  const adapter = resolveAdapter(target);
  const instance = adapter?.getInstance?.() ?? target;
  const platform = adapter?.getType?.();

  if (platform === 'fastify') {
    return { platform: 'fastify', bodyLimit: fastifyBodyLimit(instance) };
  }
  if (platform === 'express' || expressRouterOf(instance)) {
    return bypassExpress(instance, globalPrefix);
  }
  return { platform: 'unknown' };
}

/**
 * The advice to print for a Fastify application whose body limit is low enough
 * to reject queue deliveries, or `undefined` when the limit is already raised.
 *
 * Fastify's 1 MiB default is twenty times Nest-on-Express's, so this is a
 * warning rather than something the integration works around: an application
 * that has chosen a larger limit is already correct, and one that has not is
 * told exactly what to change.
 */
export function fastifyBodyLimitAdvice(
  bodyLimit: number | undefined
): string | undefined {
  if (bodyLimit === undefined) return undefined;
  if (bodyLimit > FASTIFY_DEFAULT_BODY_LIMIT) return undefined;
  return (
    `[@workflow/nest] Fastify rejects request bodies over ${bodyLimit} bytes ` +
    `with 413. Queue deliveries carry run inputs, step inputs and step ` +
    `outputs in the body, so a workflow that passes more data than that stops ` +
    `making progress. Raise the limit on the adapter — ` +
    `\`new FastifyAdapter({ bodyLimit: 16 * 1024 * 1024 })\` — or set ` +
    `\`bypassBodyParser: false\` to silence this.`
  );
}
