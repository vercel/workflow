import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';

const state = vi.hoisted(() => ({
  checkForUpdateCached: vi.fn(),
  inferLocalWorldEnvVars: vi.fn(),
}));

// Only the npm lookup is replaced; isBetaVersion stays real so the banner is
// tested with the same check the CLI runs.
vi.mock('../update-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../update-check.js')>()),
  checkForUpdateCached: state.checkForUpdateCached,
}));

// A local-world config error with ignoreLocalWorldConfigError makes
// setupCliWorld return right after printing the banner, before any world is
// created. writeEnvVars is stubbed so the test leaves process.env alone.
vi.mock('./env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.js')>()),
  writeEnvVars: vi.fn(),
  inferLocalWorldEnvVars: state.inferLocalWorldEnvVars,
}));

const { setupCliWorld } = await import('./setup.js');

const flags = {
  json: false,
  verbose: false,
  backend: 'local',
  env: '',
  authToken: '',
  project: '',
  team: '',
};

/** Runs setupCliWorld and returns the banner lines it printed, without ANSI codes. */
const bannerFor = async (version: string): Promise<string[]> => {
  const showBox = vi.spyOn(logger, 'showBox').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  await expect(setupCliWorld(flags, version, true)).resolves.toBeNull();
  expect(showBox).toHaveBeenCalledTimes(1);
  const [, ...lines] = showBox.mock.calls[0];
  return lines.map((line) => stripVTControlCharacters(line ?? ''));
};

beforeEach(() => {
  vi.restoreAllMocks();
  state.checkForUpdateCached.mockReset().mockImplementation(async (v) => ({
    currentVersion: v,
    needsUpdate: false,
  }));
  state.inferLocalWorldEnvVars
    .mockReset()
    .mockRejectedValue(new Error('no local world'));
});

describe('setupCliWorld banner', () => {
  it('says "This is a beta release" for a beta version', async () => {
    const lines = await bannerFor('5.0.0-beta.58');
    expect(lines[0]).toBe('Workflow CLI v5.0.0-beta.58');
    expect(lines).toContain('This is a beta release');
  });

  it.each([
    '5.3.0',
    '5.2.0-25050c7',
  ])('does not say "This is a beta release" for %s', async (version) => {
    const lines = await bannerFor(version);
    expect(lines[0]).toBe(`Workflow CLI v${version}`);
    expect(lines.join('\n')).not.toContain('beta release');
  });

  // @workflow/cli and workflow have separate version numbers: workflow@5.6.0
  // ships @workflow/cli@5.1.1 while @workflow/cli@latest is 5.3.0, so
  // suggesting workflow@5.3.0 would downgrade workflow.
  it('suggests workflow@latest, not the CLI version number', async () => {
    state.checkForUpdateCached.mockResolvedValue({
      currentVersion: '5.1.1',
      latestVersion: '5.3.0',
      needsUpdate: true,
    });
    const lines = await bannerFor('5.1.1');
    expect(lines).toContain('Update available: 5.1.1 → 5.3.0');
    expect(lines).toContain('Run: `[npm|bun|pnpm] i workflow@latest`');
    expect(lines.join('\n')).not.toContain('workflow@5.3.0');
  });
});
