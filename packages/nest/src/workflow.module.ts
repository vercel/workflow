import {
  type DynamicModule,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { join } from 'pathe';
import type { NestBuilderOptions } from './builder.js';
import {
  configureWorkflowController,
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
 * The build toolchain (`@workflow/builders`, esbuild, SWC) is imported lazily
 * — only when a build actually runs (`skipBuild` false). Importing this module
 * must stay free of build-time dependencies so the runtime app can be bundled
 * into a serverless function without dragging in the compiler.
 */
@Module({})
export class WorkflowModule implements OnModuleInit, OnModuleDestroy {
  private static options: WorkflowModuleOptions | null = null;
  private static outDir: string | null = null;

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

    WorkflowModule.options = options;
    WorkflowModule.outDir = outDir;

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
    const options = WorkflowModule.options;
    if (!options || options.skipBuild) {
      return;
    }
    // Lazy-load the toolchain so it never enters the runtime bundle.
    const [{ NestLocalBuilder }, { createBuildQueue }] = await Promise.all([
      import('./builder.js'),
      import('@workflow/builders'),
    ]);
    const builder = new NestLocalBuilder({
      ...options,
      outDir: WorkflowModule.outDir ?? undefined,
    });
    await createBuildQueue()(() => builder.build());
  }

  async onModuleDestroy() {
    // Cleanup if needed
    WorkflowModule.options = null;
  }
}
