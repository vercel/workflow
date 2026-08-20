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
} from '@nestjs/common';
import type { ApplicationConfig } from '@nestjs/core';
import { join } from 'pathe';
import {
  getWorkflowBasePath,
  normalizeBasePath,
  type ResolvedWorkflowModuleOptions,
  WORKFLOW_MODULE_OPTIONS,
} from './options.js';
import {
  sendStatus,
  sendWebResponse,
  toWebRequest,
} from './request-response.js';

/**
 * Fallback output directory for apps still calling the deprecated
 * {@link configureWorkflowController}. Injected options take precedence.
 */
let configuredOutDir: string | null = null;

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
  configuredOutDir = outDir;
}

/**
 * Reset the deprecated global. Test-only.
 * @internal
 */
export function resetWorkflowControllerGlobal(): void {
  configuredOutDir = null;
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
 * Note that these handlers take `@Res()`, so the app's exception filters and
 * interceptors do not wrap them. That is deliberate: the queue and third-party
 * webhook senders both key off the exact status and body the workflow runtime
 * produces, and an interceptor that reshapes responses would corrupt the
 * protocol. Errors this controller raises itself are therefore turned into
 * responses here rather than thrown.
 */
@Controller('.well-known/workflow/v1')
export class WorkflowController {
  #basePathChecked = false;

  constructor(
    @Optional()
    @Inject(WORKFLOW_MODULE_OPTIONS)
    private readonly options: ResolvedWorkflowModuleOptions | undefined,
    @Optional() private readonly appConfig?: ApplicationConfig
  ) {}

  #outDir(): string {
    const outDir = this.options?.outDir ?? configuredOutDir;
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
    const globalPrefix = normalizeBasePath(
      this.appConfig?.getGlobalPrefix?.() ?? ''
    );
    const generating = normalizeBasePath(getWorkflowBasePath());
    if (globalPrefix === generating) return;
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

  @Get('flow')
  async handleFlowGet(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('GET', req, res);
  }

  @Head('flow')
  async handleFlowHead(@Req() req: unknown, @Res() res: unknown) {
    await this.#handleFlow('HEAD', req, res);
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
