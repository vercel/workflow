import { globalSingleton } from '@workflow/utils';
import { ulid } from 'ulid';

// On `globalThis` (see `globalSingleton`): one id per process, however many
// bundler layers hold a copy of this module.
const instance = globalSingleton(
  '@workflow/core//computeInstanceId',
  1,
  () => ({ id: undefined as string | undefined })
);

/**
 * Identifier for the compute instance (microVM) this module was loaded into.
 *
 * Vercel exposes no native per-instance ID under Fluid compute (`AWS_LAMBDA_*`
 * is blocked), so we synthesize one on first use: a prefixed ULID
 * (`cinst_<ulid>`, per the `wrun_`/`step_` convention) whose timestamp is the
 * instance's first request. Stable for the instance's life and shared by every
 * invocation it handles, including the concurrent ones Fluid packs onto it;
 * cold starts mint fresh IDs. Emitted as the OpenTelemetry `faas.instance`
 * attribute.
 *
 * Minted lazily rather than at module load: runtimes such as Cloudflare
 * Workers forbid generating random values in global scope.
 */
export function getComputeInstanceId(): string {
  instance.id ??= `cinst_${ulid()}`;
  return instance.id;
}
