import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@swc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { transformMock } = vi.hoisted(() => ({
  transformMock: vi.fn(),
}));

vi.mock('@swc/core', () => ({
  transform: transformMock,
}));

import { workflowTransformPlugin } from './index.js';

const decoratedStep = `declare function Injectable(): ClassDecorator;
declare function Log(): MethodDecorator;

@Injectable()
export class OrderService {
  @Log()
  total(id: string) {
    return id.length;
  }
}

export async function chargeOrder(id: string) {
  'use step';
  return new OrderService().total(id);
}
`;

function projectWith(files: Record<string, object>) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-rollup-decorators-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

async function swcOptionsFor(projectDir: string): Promise<Options> {
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  transformMock.mockResolvedValueOnce({ code: 'compiled', map: null });
  const transform = workflowTransformPlugin().transform;
  if (typeof transform !== 'function') {
    throw new Error('expected transform to be a function');
  }
  await transform.call(
    {} as never,
    decoratedStep,
    join(projectDir, 'workflows/order.ts')
  );
  return transformMock.mock.calls.at(-1)?.[1];
}

async function parseWithRealSwc(options: Options) {
  const swc = await vi.importActual<typeof import('@swc/core')>('@swc/core');
  return swc.transform(decoratedStep, options);
}

afterEach(() => {
  vi.restoreAllMocks();
  transformMock.mockReset();
});

describe('workflowTransformPlugin decorators', () => {
  it('enables legacy decorators and metadata when tsconfig turns them on', async () => {
    const options = await swcOptionsFor(
      projectWith({
        'tsconfig.json': {
          compilerOptions: {
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
          },
        },
      })
    );

    expect(options.jsc?.parser?.decorators).toBe(true);
    expect(options.jsc?.transform?.legacyDecorator).toBe(true);
    expect(options.jsc?.transform?.decoratorMetadata).toBe(true);
    await expect(parseWithRealSwc(options)).resolves.toMatchObject({
      code: expect.stringContaining('_ts_decorate'),
    });
  });

  it('follows tsconfig extends to find experimentalDecorators', async () => {
    const options = await swcOptionsFor(
      projectWith({
        'tsconfig.base.json': {
          compilerOptions: { experimentalDecorators: true },
        },
        'tsconfig.json': { extends: './tsconfig.base.json' },
      })
    );

    expect(options.jsc?.parser?.decorators).toBe(true);
    expect(options.jsc?.transform?.legacyDecorator).toBe(true);
    expect(options.jsc?.transform?.decoratorMetadata).toBe(false);
    await expect(parseWithRealSwc(options)).resolves.toBeDefined();
  });

  it.each([
    [
      'experimentalDecorators is off',
      { 'tsconfig.json': { compilerOptions: {} } },
    ],
    [
      'only emitDecoratorMetadata is set',
      { 'tsconfig.json': { compilerOptions: { emitDecoratorMetadata: true } } },
    ],
    ['there is no tsconfig', {}],
  ])('keeps decorators off when %s', async (_, files) => {
    const options = await swcOptionsFor(projectWith(files));

    expect(options.jsc?.parser?.decorators).toBe(false);
    expect(options.jsc?.transform?.legacyDecorator).toBe(false);
    expect(options.jsc?.transform?.decoratorMetadata).toBe(false);
    await expect(parseWithRealSwc(options)).rejects.toThrow();
  });
});
