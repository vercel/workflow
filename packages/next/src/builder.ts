import semver from 'semver';
import { getNextBuilderDeferred } from './builder-deferred.js';
import { getNextBuilderEager } from './builder-eager.js';
import { parseEnvironmentFlag } from './environment-flag.js';

export const DEFERRED_BUILDER_MIN_VERSION = '16.2.0-canary.48';

export const WORKFLOW_DEFERRED_ENTRIES = [
  '/.well-known/workflow/v1/flow',
  '/.well-known/workflow/v1/webhook/[token]',
] as const;

let warnedAboutFlagAndVersion = false;

export function shouldUseDeferredBuilder(nextVersion: string): boolean {
  const flagEnabled =
    parseEnvironmentFlag(process.env.WORKFLOW_NEXT_LAZY_DISCOVERY) ?? false;
  const versionCompatible = semver.gte(
    nextVersion,
    DEFERRED_BUILDER_MIN_VERSION
  );

  if (flagEnabled && !versionCompatible && !warnedAboutFlagAndVersion) {
    warnedAboutFlagAndVersion = true;
    console.warn(
      `Enabled lazyDiscovery but Next.js version is not compatible, needs ${DEFERRED_BUILDER_MIN_VERSION} have ${nextVersion}`
    );
  }

  return flagEnabled && versionCompatible;
}

export async function getNextBuilder(nextVersion: string) {
  if (shouldUseDeferredBuilder(nextVersion)) {
    return getNextBuilderDeferred();
  }

  return getNextBuilderEager();
}
