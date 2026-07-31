import { ulid } from 'ulid';

/**
 * Identifier for the compute instance (microVM) this module was loaded into.
 *
 * Vercel exposes no native per-instance id under Fluid compute (`AWS_LAMBDA_*`
 * is blocked), so we synthesize one at module load: a prefixed ULID
 * (`cinst_<ulid>`, per the `wrun_`/`step_` convention) whose timestamp is the
 * instance's birth time. Stable for the instance's life and shared by every
 * invocation it handles — including the concurrent ones Fluid packs onto it;
 * cold starts mint fresh ids. Emitted as the OTEL `faas.instance` attribute.
 */
export const COMPUTE_INSTANCE_ID = `cinst_${ulid()}`;
