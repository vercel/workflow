import ts from 'typescript/lib/tsserverlibrary';
import { describe, expect, it, vi } from 'vitest';
import * as pluginModule from './index';

// The plugin exports with `export =` which is CommonJS style
// In TypeScript, this becomes the default export
const plugin = (pluginModule as any).default || pluginModule;

describe('TypeScript Plugin', () => {
  describe('Plugin Factory', () => {
    it('exports a function', () => {
      expect(typeof plugin).toBe('function');
    });

    it('returns an object with create function', () => {
      const result = plugin({ typescript: ts });

      expect(result).toHaveProperty('create');
      expect(typeof result.create).toBe('function');
    });
  });

  describe('Plugin Initialization', () => {
    it('creates a language service proxy', () => {
      const factory = plugin({ typescript: ts });

      // Mock the plugin create info
      const mockLanguageService = {
        getSemanticDiagnostics: vi.fn(() => []),
        getCompletionsAtPosition: vi.fn(() => undefined),
        getSyntacticDiagnostics: vi.fn(() => []),
      };

      const mockLogger = {
        info: vi.fn(),
        msg: vi.fn(),
      };

      const mockProjectService = {
        logger: mockLogger,
      };

      const mockProject = {
        projectService: mockProjectService,
      };

      const info: any = {
        languageService: mockLanguageService,
        languageServiceHost: {},
        project: mockProject,
        config: {},
      };

      const proxy = factory.create(info);

      expect(proxy).toBeDefined();
      expect(typeof proxy.getSemanticDiagnostics).toBe('function');
      expect(typeof proxy.getCompletionsAtPosition).toBe('function');
    });

    it('proxies all language service methods', () => {
      const factory = plugin({ typescript: ts });

      const mockLanguageService = {
        getSemanticDiagnostics: vi.fn(() => []),
        getCompletionsAtPosition: vi.fn(() => undefined),
        getSyntacticDiagnostics: vi.fn(() => []),
        getQuickInfoAtPosition: vi.fn(() => undefined),
      };

      const mockLogger = {
        info: vi.fn(),
        msg: vi.fn(),
      };

      const mockProjectService = {
        logger: mockLogger,
      };

      const mockProject = {
        projectService: mockProjectService,
      };

      const info: any = {
        languageService: mockLanguageService,
        languageServiceHost: {},
        project: mockProject,
        config: {},
      };

      const proxy = factory.create(info);

      // All methods should be proxied
      expect(proxy.getSyntacticDiagnostics).toBeDefined();
      expect(proxy.getQuickInfoAtPosition).toBeDefined();

      // Test that a non-overridden method calls through
      proxy.getSyntacticDiagnostics('test.ts');
      expect(mockLanguageService.getSyntacticDiagnostics).toHaveBeenCalledWith(
        'test.ts'
      );
    });
  });

  describe('Configuration Options', () => {
    it('respects enableDiagnostics: false', () => {
      const factory = plugin({ typescript: ts });

      const originalGetSemanticDiagnostics = vi.fn(() => [
        { code: 1234, category: 1 },
      ]);

      const mockLogger = {
        info: vi.fn(),
        msg: vi.fn(),
      };

      const mockProjectService = {
        logger: mockLogger,
      };

      const mockProject = {
        projectService: mockProjectService,
      };

      const info: any = {
        languageService: {
          getSemanticDiagnostics: originalGetSemanticDiagnostics,
          getCompletionsAtPosition: vi.fn(),
          getProgram: vi.fn(() => ({
            getSourceFile: vi.fn(),
            getTypeChecker: vi.fn(),
          })),
        },
        languageServiceHost: {},
        project: mockProject,
        config: {
          enableDiagnostics: false,
        },
      };

      const proxy = factory.create(info);

      // When enableDiagnostics is false, should not add custom diagnostics
      const result = proxy.getSemanticDiagnostics('test.ts');
      expect(originalGetSemanticDiagnostics).toHaveBeenCalledWith('test.ts');
      // Should return the original diagnostics without modifications
      expect(result).toEqual([{ code: 1234, category: 1 }]);
    });

    it('respects enableCompletions: false', () => {
      const factory = plugin({ typescript: ts });

      const mockCompletions = { entries: [], isGlobalCompletion: false };
      const originalGetCompletionsAtPosition = vi.fn(() => mockCompletions);

      const mockLogger = {
        info: vi.fn(),
        msg: vi.fn(),
      };

      const mockProjectService = {
        logger: mockLogger,
      };

      const mockProject = {
        projectService: mockProjectService,
      };

      const info: any = {
        languageService: {
          getSemanticDiagnostics: vi.fn(),
          getCompletionsAtPosition: originalGetCompletionsAtPosition,
        },
        languageServiceHost: {},
        project: mockProject,
        config: {
          enableCompletions: false,
        },
      };

      const proxy = factory.create(info);

      // When enableCompletions is false, should call original method
      const result = proxy.getCompletionsAtPosition('test.ts', 0);
      expect(originalGetCompletionsAtPosition).toHaveBeenCalledWith(
        'test.ts',
        0
      );
      expect(result).toBe(mockCompletions);
    });
  });

  describe('Error Handling', () => {
    it('catches and logs errors in getSemanticDiagnostics', () => {
      const factory = plugin({ typescript: ts });

      const mockLogger = {
        info: vi.fn(),
        msg: vi.fn(),
      };

      const mockProjectService = {
        logger: mockLogger,
      };

      const mockProject = {
        projectService: mockProjectService,
      };

      const priorDiagnostics = [{ code: 1234, category: 1 }];

      const info: any = {
        languageService: {
          getSemanticDiagnostics: vi.fn(() => priorDiagnostics),
          getCompletionsAtPosition: vi.fn(),
          getProgram: vi.fn(() => {
            throw new Error('Test error');
          }),
        },
        languageServiceHost: {},
        project: mockProject,
        config: {},
      };

      const proxy = factory.create(info);

      // Should not throw and should return prior diagnostics
      const result = proxy.getSemanticDiagnostics('test.ts');
      expect(result).toEqual(priorDiagnostics);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Error')
      );
    });
  });
});
