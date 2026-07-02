import {
  type DynamicModule,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createBuildQueue } from '@workflow/builders';
import {
  type NestBuilderOptions,
  NestLocalBuilder,
  resolveNestBuilderConfig,
} from './builder.js';
import {
  configureWorkflowController,
  WorkflowController,
} from './workflow.controller.js';

export interface WorkflowModuleOptions extends NestBuilderOptions {
  /**
   * Skip building workflow bundles (useful in production when bundles are pre-built)
   * @default false
   */
  skipBuild?: boolean;
}

/**
 * NestJS module that provides workflow functionality.
 * Builds workflow bundles on module initialization and registers the workflow controller.
 */
@Module({})
export class WorkflowModule implements OnModuleInit, OnModuleDestroy {
  private static builder: NestLocalBuilder | null = null;
  private static buildQueue = createBuildQueue();

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
    const { outDir } = resolveNestBuilderConfig(options);

    // Configure the controller with the output directory
    configureWorkflowController(outDir);

    // Create builder if we're not skipping builds
    if (!options.skipBuild) {
      WorkflowModule.builder = new NestLocalBuilder(options);
    }

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
    const builder = WorkflowModule.builder;
    if (builder) {
      await WorkflowModule.buildQueue(() => builder.build());
    }
  }

  async onModuleDestroy() {
    // Cleanup if needed
    WorkflowModule.builder = null;
  }
}
