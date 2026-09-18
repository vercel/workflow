import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { expect, it } from 'vitest';
import { applySwcTransform } from './apply-swc-transform.js';

it.each([
  'workflow',
  'step',
] as const)('preserves replayInputs through the %s transform and minification', async (mode) => {
  const { code } = await applySwcTransform(
    'replay-inputs.ts',
    `
    export async function turn(state: string[], ordinary: string) {
      "use step";
      return ordinary + state.length;
    }
    turn.replayInputs = [0];
    turn.maxRetries = 2;
  `,
    mode
  );
  const bundled = await transform(code, {
    format: 'cjs',
    minify: true,
    target: 'es2022',
  });
  const context = {
    module: { exports: {} as any },
    require: () => ({ registerStepFunction() {} }),
    [Symbol.for('WORKFLOW_USE_STEP')]: () => async () => undefined,
  };
  runInNewContext(bundled.code, context);
  expect(context.module.exports.turn.replayInputs).toEqual([0]);
  expect(context.module.exports.turn.maxRetries).toBe(2);
});
