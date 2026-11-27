import { Parser } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliFlags } from './flags.js';
import {
  getVercelExtensionApiUrl,
  resetVercelExtension,
  setRunAsVercelExtension,
} from './vercel-extension.js';

const parseBackend = async (argv: string[]): Promise<string> => {
  const { flags } = await Parser.parse(argv, {
    flags: { backend: cliFlags.backend },
  });
  return flags.backend;
};

describe('run as `vercel workflow`', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.WORKFLOW_TARGET_WORLD;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  afterEach(() => {
    resetVercelExtension();
    if (saved === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
    else process.env.WORKFLOW_TARGET_WORLD = saved;
  });

  it('defaults --backend to local otherwise', async () => {
    expect(await parseBackend([])).toBe('local');
    expect(getVercelExtensionApiUrl()).toBeUndefined();
  });

  it('defaults --backend to vercel', async () => {
    setRunAsVercelExtension('http://127.0.0.1:4321');
    expect(await parseBackend([])).toBe('vercel');
    expect(getVercelExtensionApiUrl()).toBe('http://127.0.0.1:4321');
  });

  it('defaults --backend to vercel without a proxy URL too', async () => {
    setRunAsVercelExtension(undefined);
    expect(await parseBackend([])).toBe('vercel');
    expect(getVercelExtensionApiUrl()).toBeUndefined();
  });

  it('yields to --backend and WORKFLOW_TARGET_WORLD', async () => {
    setRunAsVercelExtension('http://127.0.0.1:4321');
    expect(await parseBackend(['--backend', 'local'])).toBe('local');
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres';
    expect(await parseBackend([])).toBe('@workflow/world-postgres');
  });
});
