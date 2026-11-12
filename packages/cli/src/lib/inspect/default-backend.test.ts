import { Parser } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDefaultBackend } from './default-backend.js';
import { cliFlags } from './flags.js';

const parseBackend = async (argv: string[]): Promise<string> => {
  const { flags } = await Parser.parse(argv, {
    flags: { backend: cliFlags.backend },
  });
  return flags.backend;
};

describe('--backend default', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.WORKFLOW_TARGET_WORLD;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  afterEach(() => {
    setDefaultBackend('local');
    if (saved === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
    else process.env.WORKFLOW_TARGET_WORLD = saved;
  });

  it('is local by default', async () => {
    expect(await parseBackend([])).toBe('local');
  });

  it('is vercel when run as `vercel workflow`', async () => {
    setDefaultBackend('vercel');
    expect(await parseBackend([])).toBe('vercel');
  });

  it('yields to --backend and WORKFLOW_TARGET_WORLD', async () => {
    setDefaultBackend('vercel');
    expect(await parseBackend(['--backend', 'local'])).toBe('local');
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres';
    expect(await parseBackend([])).toBe('@workflow/world-postgres');
  });
});
