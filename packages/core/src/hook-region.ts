import type { WorldCapabilities } from '@workflow/world';
import { decode, encode, REGION_IDS } from '@workflow/world-vercel/run-id';

/**
 * Per-region webhook storage, for Worlds that declare
 * `capabilities.hookRegions` (world-vercel).
 *
 * A webhook is stored in its run's region, so `hook_created` can commit in
 * the same transaction as the run's event log and deliveries stay in-region.
 * Where it lives is carried by two values the runtime mints:
 *
 * - **The hook ID.** The ULID in `hook_<ulid>` is region-tagged with the same
 *   encoding as region-tagged run IDs. An untagged hook ID means the World's
 *   default region (`iad1`), which is where every `createHook()` hook lives.
 *   Every hook-scoped backend operation (create, dispose, get by ID) reads the
 *   region from it.
 * - **The webhook token.** The webhook endpoint only receives a token, so the
 *   generated token is prefixed `wh.<region>.` and `resumeWebhook()` reads the
 *   region back from it. Webhook tokens are always generated, and only
 *   `resumeWebhook()` decodes tokens (it only accepts webhooks), so a custom
 *   `createHook()` token can never be mistaken for one.
 *
 * Determinism: every input here (the run ID and the World's static
 * capabilities) is fixed for a run, so replays mint identical values.
 */

/** Prefix of a region-tagged webhook token: `wh.<region>.<nanoid>`. */
export const WEBHOOK_TOKEN_PREFIX = 'wh.';

const RUN_ID_PREFIX = 'wrun_';

/** Whether `code` is a region code the hook region encoding can carry. */
function isKnownHookRegion(code: string): boolean {
  return code !== 'unknown' && Object.hasOwn(REGION_IDS, code);
}

/**
 * The region of a run, decoded from its region-tagged run ID. Untagged
 * (legacy) run IDs live in `iad1`. `undefined` for an undecodable ID.
 */
function runRegion(runId: string): string | undefined {
  const bare = runId.startsWith(RUN_ID_PREFIX)
    ? runId.slice(RUN_ID_PREFIX.length)
    : runId;
  try {
    const decoded = decode(bare);
    return decoded.tagged && decoded.region ? decoded.region : 'iad1';
  } catch {
    return undefined;
  }
}

/**
 * The region a new hook is stored in, or `undefined` for the World's default
 * region (an untagged hook ID): a webhook's run region on a World with
 * `hookRegions`, else the default.
 */
export function newHookRegion(args: {
  isWebhook: boolean;
  runId: string;
  capabilities: WorldCapabilities | undefined;
}): string | undefined {
  if (args.capabilities?.hookRegions !== true || !args.isWebhook) {
    return undefined;
  }
  return runRegion(args.runId);
}

/** The hook ID's ULID, region-tagged for `region` (see the module docs). */
export function tagHookUlid(ulid: string, region: string): string {
  return encode(ulid, region as Parameters<typeof encode>[1]);
}

/** A generated webhook token carrying its region. */
export function regionalWebhookToken(region: string, nanoid: string): string {
  return `${WEBHOOK_TOKEN_PREFIX}${region}.${nanoid}`;
}

/**
 * The region a webhook token was minted for, or `undefined` for a legacy
 * webhook token (stored in the World's default region).
 */
export function webhookTokenRegion(token: string): string | undefined {
  if (!token.startsWith(WEBHOOK_TOKEN_PREFIX)) return undefined;
  const end = token.indexOf('.', WEBHOOK_TOKEN_PREFIX.length);
  if (end === -1) return undefined;
  const region = token.slice(WEBHOOK_TOKEN_PREFIX.length, end);
  return isKnownHookRegion(region) ? region : undefined;
}
