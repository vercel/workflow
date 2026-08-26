import type { WorkflowFileInfo } from '@workflow/builders';
import type { EnvironmentModuleNode, Plugin } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { workflowHotUpdatePlugin } from './hot-update.js';

function module(id: string, importers: EnvironmentModuleNode[] = []) {
  return {
    id,
    importers: new Set(importers),
    info: {
      meta: {
        'workflow:imports': '',
        'workflow:module': false,
      },
    },
  } as EnvironmentModuleNode;
}

function workflowModule(id: string) {
  return {
    id,
    importers: new Set(),
    info: { meta: { 'workflow:module': true } },
  } as EnvironmentModuleNode;
}

type HotUpdateHook = (options: {
  type: 'create' | 'update' | 'delete';
  file: string;
  modules: EnvironmentModuleNode[];
  read(): string | Promise<string>;
  timestamp: number;
}) => Promise<void>;

type TransformHook = (
  code: string,
  id: string
) =>
  | {
      meta: {
        'workflow:imports': string;
        'workflow:module': boolean;
      };
    }
  | undefined;

function builder(build: () => Promise<void>, affects = false) {
  return {
    build,
    getWorkflowFileInfo: (): WorkflowFileInfo =>
      affects
        ? { kind: 'source', affectsBuild: true, importSignature: '' }
        : { kind: 'untracked' },
  };
}

function hooks(plugin: Plugin): {
  hotUpdate: HotUpdateHook;
  transform: TransformHook;
} {
  return {
    hotUpdate: plugin.hotUpdate as HotUpdateHook,
    transform: plugin.transform as TransformHook,
  };
}

describe('workflowHotUpdatePlugin', () => {
  it('rebuilds when a workflow dependency changes', async () => {
    const build = vi.fn();
    const { hotUpdate, transform } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build) })
    );
    const workflowFile = '/app/workflow.ts';
    const helperFile = '/app/helper.ts';
    const root = workflowModule(workflowFile);

    expect(
      transform("export function run() {\n  'use workflow';\n}", workflowFile)
    ).toEqual({
      meta: {
        'workflow:imports': '',
        'workflow:module': true,
      },
    });
    await hotUpdate({
      type: 'update',
      file: helperFile,
      modules: [module(helperFile, [root])],
      read: () => 'export const value = 2;',
      timestamp: 1,
    });

    expect(build).toHaveBeenCalledOnce();
  });

  it('uses the Vite graph for non-source dependencies', async () => {
    const build = vi.fn();
    const { hotUpdate, transform } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build) })
    );
    const workflowFile = '/app/workflow.ts';
    const inputFile = '/app/input.json';
    const root = workflowModule(workflowFile);

    transform("export function run() {\n  'use workflow';\n}", workflowFile);
    await hotUpdate({
      type: 'update',
      file: inputFile,
      modules: [module(inputFile, [root])],
      read: () => '{"value":2}',
      timestamp: 1,
    });

    expect(build).toHaveBeenCalledOnce();
  });

  it('ignores unrelated updates', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build) })
    );

    await hotUpdate({
      type: 'update',
      file: '/app/unrelated.ts',
      modules: [module('/app/unrelated.ts')],
      read: () => 'export const value = 2;',
      timestamp: 1,
    });
    await hotUpdate({
      type: 'update',
      file: '/app/unvisited.ts',
      modules: [],
      read: () => 'export const value = 2;',
      timestamp: 2,
    });

    expect(build).not.toHaveBeenCalled();
  });

  it('rebuilds when an updated source disappears before it is read', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build) })
    );

    await hotUpdate({
      type: 'update',
      file: '/app/workflow.ts',
      modules: [],
      read: () => Promise.reject(new Error('File not found')),
      timestamp: 1,
    });

    expect(build).toHaveBeenCalledOnce();
  });

  it('rebuilds once across Vite environments', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build, true) })
    );
    const update = {
      type: 'update' as const,
      file: '/app/helper.ts',
      modules: [],
      read: () => 'export const value = 2;',
      timestamp: 1,
    };

    await hotUpdate(update);
    await hotUpdate(update);

    expect(build).toHaveBeenCalledOnce();
  });

  it('ignores an older environment update after a newer event', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build, true) })
    );
    const update = (timestamp: number) =>
      hotUpdate({
        type: 'update',
        file: '/app/helper.ts',
        modules: [],
        read: () => 'export const value = 2;',
        timestamp,
      });

    await update(1);
    await update(2);
    await update(1);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('uses builder discovery for dependencies absent from Vite', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build, true) })
    );

    await hotUpdate({
      type: 'update',
      file: '/app/unvisited-helper.ts',
      modules: [],
      read: () => 'export const value = 2;',
      timestamp: 1,
    });

    expect(build).toHaveBeenCalledOnce();
  });

  it('rebuilds when imports change', async () => {
    const build = vi.fn();
    const { hotUpdate } = hooks(
      workflowHotUpdatePlugin({ builder: builder(build) })
    );

    await hotUpdate({
      type: 'update',
      file: '/app/page.ts',
      modules: [
        {
          id: '/app/page.ts',
          importers: new Set(),
          info: {
            meta: {
              'workflow:imports': './old',
              'workflow:module': false,
            },
          },
        } as EnvironmentModuleNode,
      ],
      read: () => "import './workflow';",
      timestamp: 1,
    });

    expect(build).toHaveBeenCalledOnce();
  });
});
