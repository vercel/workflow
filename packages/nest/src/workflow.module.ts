import {
  type DynamicModule,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { globalSingleton } from '@workflow/utils';
import { join } from 'pathe';
import type { NestBuilderOptions } from './builder.js';
import {
  configureWorkflowController,
  loadWorkflowHandler,
  WorkflowController,
} from './workflow.controller.js';

export interface WorkflowModuleOptions extends NestBuilderOptions {
  /**
   * Skip building workflow bundles. Set this in production (and always on
   * Vercel) where bundles are pre-built by `workflow-nest build`.
   * @default false
   */
  skipBuild?: boolean;
}

const DEFAULT_OUT_DIR = '.nestjs/workflow';

/**
 * NestJS module that provides workflow functionality: it registers the
 * controller that serves the `.well-known/workflow/v1` routes and, in local
 * dev, rebuilds the workflow bundles on init.
 *
 * The build toolchain (`@workflow/builders`, esbuild, SWC) is imported lazily,
 * only when a build actually runs (`skipBuild` false). Importing this module
 * must stay free of build-time dependencies so the runtime app can be bundled
 * into a serverless function without dragging in the compiler.
 */
@Module({})
export class WorkflowModule implements OnModuleInit, OnModuleDestroy {
  // On `globalThis` rather than in static fields: a bundler can compile this
  // module into the host build more than once (see `globalSingleton`), and
  // `forRoot()` would then configure one copy while the module lifecycle hooks
  // read another. Static fields are module-scope state with a class for a
  // namespace, and duplicate exactly the same way.
  private static readonly state = globalSingleton(
    '@workflow/nest//moduleConfig',
    1,
    () => ({
      options: null as WorkflowModuleOptions | null,
      outDir: null as string | null,
    })
  );

  /**
   * Configure the WorkflowModule with options.
   * Call this in your AppModule imports.
   *
   * @example
   * ```typescript
   * @Module({
   *   imports: [WorkflowModule.forRoot()],
   * })
   * export class AppModule {}
   * ```
   */
  static forRoot(options: WorkflowModuleOptions = {}): DynamicModule {
    const workingDir = options.workingDir ?? process.cwd();
    const outDir = options.outDir ?? join(workingDir, DEFAULT_OUT_DIR);

    // Configure the controller with the output directory
    configureWorkflowController(outDir);

    WorkflowModule.state.options = options;
    WorkflowModule.state.outDir = outDir;

    return {
      module: WorkflowModule,
      controllers: [WorkflowController],
      providers: [
        {
          provide: 'WORKFLOW_OPTIONS',
          useValue: options,
        },
      ],
      global: true,
    };
  }

  async onModuleInit() {
    const options = WorkflowModule.state.options;
    const outDir = WorkflowModule.state.outDir;
    if (!options || !outDir) return;

    if (!options.skipBuild) {
      // Lazy-load the toolchain so it never enters the runtime bundle.
      const [{ NestLocalBuilder }, { createBuildQueue }] = await Promise.all([
        import('./builder.js'),
        import('@workflow/builders'),
      ]);
      const builder = new NestLocalBuilder({ ...options, outDir });
      await createBuildQueue()(() => builder.build());
    }

    if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
      const { POST } = await loadWorkflowHandler();
      await POST.initialize();
    }
  }

  async onModuleDestroy() {
    // Cleanup if needed
    WorkflowModule.state.options = null;
  }
}
