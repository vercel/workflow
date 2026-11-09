import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as browser from './browser.js';
import * as host from './index.js';

const browserEntry = fileURLToPath(new URL('./browser.ts', import.meta.url));

describe('workflow browser entry', () => {
  it('has the same runtime exports as the host entry', () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(host).sort());
  });

  it('bundles for the browser without Node.js built-ins', async () => {
    const result = await build({
      entryPoints: [browserEntry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    expect(code).not.toMatch(/["']node:/);
  });

  it('keeps the error classes usable', () => {
    expect(new browser.FatalError('boom')).toBeInstanceOf(Error);
    expect(
      new browser.RetryableError('later', { retryAfter: 1000 })
    ).toBeInstanceOf(Error);
  });

  it('lets a hook be defined at module scope and throws when it is used', async () => {
    const hook = browser.defineHook<{ approved: boolean }>();
    expect(() => hook.create()).toThrow(
      'can only be called inside a workflow or step function'
    );
    await expect(hook.resume('token', { approved: true })).rejects.toThrow(
      'can only be called inside a workflow or step function'
    );
  });

  it.each([
    ['createHook', () => browser.createHook()],
    ['createWebhook', () => browser.createWebhook()],
    ['getStepMetadata', () => browser.getStepMetadata()],
    ['getWorkflowMetadata', () => browser.getWorkflowMetadata()],
    ['getWritable', () => browser.getWritable()],
  ])('%s throws outside a workflow or step', (name, call) => {
    expect(call).toThrow(`\`${name}()\` can only be called inside a workflow`);
  });

  it.each([
    ['sleep', () => browser.sleep('1s')],
    ['setAttributes', () => browser.setAttributes({})],
  ])('%s rejects outside a workflow or step', async (name, call) => {
    await expect(call()).rejects.toThrow(
      `\`${name}()\` can only be called inside a workflow`
    );
  });
});
