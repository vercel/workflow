import ts from 'typescript/lib/tsserverlibrary';
import { enhanceCompletions } from './completions';
import { getCustomDiagnostics } from './diagnostics';

interface PluginConfig {
  enableDiagnostics?: boolean;
  enableCompletions?: boolean;
}

function init(modules: {
  typescript: typeof import('typescript/lib/tsserverlibrary');
}) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {
    try {
      // Log plugin initialization
      info.project.projectService.logger.info(
        '@workflow/typescript-plugin: Initializing plugin'
      );

      // Get plugin configuration
      const config: PluginConfig = info.config || {};
      const enableDiagnostics = config.enableDiagnostics !== false;
      const enableCompletions = config.enableCompletions !== false;

      info.project.projectService.logger.info(
        `@workflow/typescript-plugin: Diagnostics=${enableDiagnostics}, Completions=${enableCompletions}`
      );

      // Set up decorator object
      const proxy: ts.LanguageService = Object.create(null);
      for (const k of Object.keys(info.languageService) as Array<
        keyof ts.LanguageService
      >) {
        const x = info.languageService[k]!;
        proxy[k] = (...args: Array<unknown>) =>
          x.apply(info.languageService, args);
      }

      // Enhance semantic diagnostics
      if (enableDiagnostics) {
        proxy.getSemanticDiagnostics = (fileName: string) => {
          const prior = info.languageService.getSemanticDiagnostics(fileName);
          try {
            const program = info.languageService.getProgram();
            if (!program) {
              return prior;
            }

            const customDiagnostics = getCustomDiagnostics(
              fileName,
              program,
              ts
            );

            return [...prior, ...customDiagnostics];
          } catch (error) {
            info.project.projectService.logger.info(
              `@workflow/typescript-plugin: Error in getSemanticDiagnostics: ${error}`
            );
            return prior;
          }
        };
      }

      // Enhance completions
      if (enableCompletions) {
        proxy.getCompletionsAtPosition = (
          fileName: string,
          position: number,
          options: ts.GetCompletionsAtPositionOptions | undefined
        ) => {
          const prior = info.languageService.getCompletionsAtPosition(
            fileName,
            position,
            options
          );
          try {
            const program = info.languageService.getProgram();
            if (!program) return prior;

            return enhanceCompletions(fileName, position, prior, program, ts);
          } catch (error) {
            info.project.projectService.logger.info(
              `@workflow/typescript-plugin: Error in getCompletionsAtPosition: ${error}`
            );
            return prior;
          }
        };
      }

      info.project.projectService.logger.info(
        '@workflow/typescript-plugin loaded successfully'
      );

      return proxy;
    } catch (error) {
      info.project.projectService.logger.info(
        `@workflow/typescript-plugin: Error initializing plugin: ${error}`
      );
      // Return the original language service if plugin fails
      return info.languageService;
    }
  }

  return { create };
}

export = init;
