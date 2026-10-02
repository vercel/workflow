import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  All,
  Controller,
  Get,
  Head,
  Inject,
  Optional,
  Options,
  Post,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import { globalSingleton } from '@workflow/utils';
import { join } from 'pathe';
import {
  basePathReachesRoutes,
  getWorkflowBasePath,
  normalizeBasePath,
  type ResolvedWorkflowModuleOptions,
  servedGlobalPrefix,
  WORKFLOW_MODULE_OPTIONS,
} from './options.js';
import {
  sendStatus,
  sendWebResponse,
  toWebRequest,
} from './request-response.js';
import { WORKFLOW_ROUTE_PREFIX } from './workflow-routes.js';

/**
 * Fallback output directory for apps still calling the deprecated
 * {@link configureWorkflowController}. Injected options take precedence.
 *
 * On `globalThis` rather than at module scope because a bundler can compile
 * this module into the host application's build more than once (see
 * `globalSingleton`), and the copy that `configureWorkflowController()` writes
 * would then not be the copy the request path reads, leaving the fallback
 * empty for the life of the process.
 */
const controllerConfig = globalSingleton(
  '@workflow/nest//controllerConfig',
  1,
  () => ({ outDir: null as string | null })
);

/**
 * Point the controller at the directory holding the generated bundles.
 *
 * @deprecated `WorkflowModule.forRoot()` now provides the output directory
 * through dependency injection. This function writes process-global state, so
 * two applications in one process (the usual `Test.createTestingModule` setup)
 * overwrite each other's configuration. It remains only so existing callers
 * keep working.
 */
export function configureWorkflowController(outDir: string): void {
  controllerConfig.outDir = outDir;
}

/**
 * Reset the deprecated global. Test-only.
 * @internal
 */
export function resetWorkflowControllerGlobal(): void {
  controllerConfig.outDir = null;
}

type BundleName =
  | 'steps.mjs'
  | 'workflows.mjs'
  | 'webhook.mjs'
  | 'manifest.json';

/** Handlers the generated flow bundle exports, all aliases of the same entry. */
type FlowBundle = Record<'GET' | 'HEAD' | 'OPTIONS' | 'POST', FlowHandler>;
type FlowHandler = (request: Request) => Promise<Response>;

/**
 * Serves the `.well-known/workflow/v1` endpoints by delegating to the bundles
 * `workflow-nest build` (or the module's startup build) generates.
 *
 * Every handler writes through `@Res()` rather than returning a value, so an
 * interceptor or exception filter that reshapes responses cannot corrupt the
 * protocol: the queue and third-party webhook senders key off the exact status
 * and body the workflow runtime produces. Errors this controller raises itself
 * are turned into responses here rather than thrown, for the same reason.
 *
 * Guards still run, because Nest runs them before the handler. An application
 * guard that rejects unauthenticated requests therefore rejects queue
 * deliveries too, which stalls every run; `isWorkflowRequest()` is exported so
 * a guard can let these routes through.
 *
 * `VERSION_NEUTRAL` keeps the routes at a fixed path when the application
 * enables `app.enableVersioning()`. URI versioning would otherwise move them
 * to `/v1/.well-known/workflow/v1/...` while the SDK keeps generating callback
 * URLs at the unversioned path.
 */
@Controller({ path: WORKFLOW_ROUTE_PREFIX, version: VERSION_NEUTRAL })
export class WorkflowController {
  #basePathChecked = false;

  constructor(
    @Optional()
    @Inject(WORKFLOW_MODULE_OPTIONS)
    private readonly options: ResolvedWorkflowModuleOptions | undefined,
    @Optional()
    @Inject(ApplicationConfig)
    private readonly appConfig?: ApplicationConfig
  ) {}

  #outDir(): string {
    const outDir = this.options?.outDir ?? controllerConfig.outDir;
    if (!outDir) {
      throw new Error(
        'WorkflowController is not configured. Register it through ' +
          '`WorkflowModule.forRoot()` so the generated bundle directory is ' +
          'provided by dependency injection.'
      );
    }
    return outDir;
  }

  /**
   * Backstop for the base-path reconciliation `WorkflowModule` performs at
   * startup, in case the prefix changed after the module initialized or the
   * controller was registered without the module.
   *
   * The comparison is against the prefix the SDK is *actually* generating URLs
   * under, not the configured option, so an adopted global prefix does not read
   * as a mismatch.
   */
  #warnOnBasePathMismatch(): void {
    if (this.#basePathChecked) return;
    this.#basePathChecked = true;
    const globalPrefix = servedGlobalPrefix(this.appConfig);
    const generating = normalizeBasePath(getWorkflowBasePath());
    if (basePathReachesRoutes(generating, globalPrefix)) return;
    console.error(
      `[@workflow/nest] Global prefix mismatch: NestJS serves the workflow ` +
        `routes under "${globalPrefix || '/'}" but the Workflow SDK generates ` +
        `URLs under "${generating || '/'}". Queue deliveries and webhooks will ` +
        `404 and runs will not progress. Pass ` +
        `\`WorkflowModule.forRoot({ basePath: '${globalPrefix}' })\` to match.`
    );
  }

  #bundlePath(name: BundleName): string {
    return join(this.#outDir(), name);
  }

  async #loadFlowBundle(): Promise<FlowBundle> {
    const path = this.#bundlePath('workflows.mjs');
    // The step registrations must be imported first: they register step
    // implementations by side effect, and the flow handler resolves them.
    await import(pathToFileURL(this.#bundlePath('steps.mjs')).href);
    return (await import(pathToFileURL(path).href)) as FlowBundle;
  }

  /**
   * Turn a bundle failure into an actionable message. The raw error is
   * `ERR_MODULE_NOT_FOUND` against a path inside a generated directory, which
   * says nothing about the build step that was skipped.
   */
  #describeLoadFailure(error: unknown, name: BundleName): string {
    let path: string;
    try {
      path = this.#bundlePath(name);
    } catch (configError) {
      // The module was never registered, so there is no directory to report.
      return configError instanceof Error
        ? configError.message
        : String(configError);
    }
    if (!existsSync(path)) {
      return (
        `Workflow bundle not found at ${path}. Run \`workflow-nest build\` ` +
        `before starting the app, or remove \`skipBuild\` so ` +
        `WorkflowModule builds the bundles during startup.`
      );
    }
    return `Failed to load the workflow bundle at ${path}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  /**
   * Run a bundle-backed handler, reporting a load failure as a 503 rather than
   * letting it escape as an unhandled 500 with a raw module-resolution stack.
   *
   * 503 rather than 500 is deliberate: a missing bundle is a deployment problem
   * that a retry of the same delivery can survive once the build lands.
   */
  async #serve(
    bundleName: BundleName,
    load: () => Promise<FlowHandler>,
    req: unknown,
    res: unknown
  ): Promise<void> {
    this.#warnOnBasePathMismatch();
    let handler: FlowHandler;
    try {
      handler = await load();
    } catch (error) {
      const message = this.#describeLoadFailure(error, bundleName);
      console.error(`[@workflow/nest] ${message}`);
      sendStatus(res, 503, message);
      return;
    }
    const webResponse = await handler(await toWebRequest(req));
    await sendWebResponse(res, webResponse);
  }

  async #handleFlow(
    method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST',
    req: unknown,
    res: unknown
  ): Promise<void> {
    await this.#serve(
      'workflows.mjs',
      async () => {
        const bundle = await this.#loadFlowBundle();
        return bundle[method] ?? bundle.POST;
      },
      req,
      res
    );
  }

  /**
   * The flow route answers every method the generated bundle exports, not just
   * POST. `HEAD` in particular is what `getWorkflowPort()` probes to identify a
   * workflow server when resolving the local base URL; a 404 there makes it fall
   * back to an arbitrary listening port.
   */
  @Post('flow')
  async handleFlowPost(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('POST', req, res);
  }

  /**
   * HEAD is declared before GET on purpose, and must stay there.
   *
   * NestJS registers routes in declaration order, and Fastify derives a HEAD
   * route from every GET route unless one already exists (`exposeHeadRoutes`,
   * on by default). Declaring GET first therefore makes Fastify create the
   * HEAD route itself and then throw `Method 'HEAD' already declared for
   * route '/.well-known/workflow/v1/flow'` when this handler registers —
   * which rejects `app.init()` and takes the whole application down at boot,
   * not just the workflow routes. Covered by the Fastify boot test.
   */
  @Head('flow')
  async handleFlowHead(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('HEAD', req, res);
  }

  @Get('flow')
  async handleFlowGet(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('GET', req, res);
  }

  @Options('flow')
  async handleFlowOptions(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('OPTIONS', req, res);
  }

  @All('webhook/:token')
  async handleWebhook(@Req() req: unknown, @Res() res: unknown) {
    await this.#serve(
      'webhook.mjs',
      async () => {
        const bundle = (await import(
          pathToFileURL(this.#bundlePath('webhook.mjs')).href
        )) as Partial<FlowBundle>;
        // Every method export is the same handler; pick the one matching the
        // request so a future divergence is honoured rather than silently
        // collapsed onto POST.
        const method = (
          (req as { method?: string }).method ?? 'POST'
        ).toUpperCase() as keyof FlowBundle;
        const handler = bundle[method] ?? bundle.POST;
        if (!handler) {
          throw new Error('webhook bundle exports no request handler');
        }
        return handler;
      },
      req,
      res
    );
  }

  @Get('manifest.json')
  handleManifest(@Res() res: unknown) {
    if (process.env.WORKFLOW_PUBLIC_MANIFEST !== '1') {
      sendStatus(res, 404);
      return;
    }
    let manifest: string;
    try {
      manifest = readFileSync(this.#bundlePath('manifest.json'), {
        encoding: 'utf-8',
      });
    } catch {
      sendStatus(res, 404);
      return;
    }
    sendStatus(res, 200, manifest, 'application/json');
  }
}
