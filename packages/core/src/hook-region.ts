import type { WorldCapabilities } from '@workflow/world';
import { decode, encode, REGION_IDS } from '@workflow/world-vercel/run-id';

/**
 * Per-region hook storage, for Worlds that declare
 * `capabilities.hookRegions` (world-vercel).
 *
 * A hook lives in one region's storage, and its token is unique within that
 * region only. Where it lives is carried by two values the runtime mints:
 *
 * - **The hook ID.** For a hook created with a region, the ULID in
 *   `hook_<ulid>` is region-tagged with the same encoding as region-tagged
 *   run IDs. An untagged hook ID means the World's default region (`iad1`).
 *   Every hook-scoped server operation (create, dispose, get by ID) reads the
 *   region from it.
 * - **The webhook token.** The webhook endpoint only receives a token, so a
 *   generated webhook token is prefixed `wh.<region>.` and `resumeWebhook()`
 *   reads the region back from it. Webhook tokens are always generated, so a
 *   custom `createHook()` token can never be mistaken for one: only
 *   `resumeWebhook()` decodes tokens, and it only accepts webhooks.
 *
 * Determinism: every input here (the explicit option, the run ID, the World's
 * static capabilities) is fixed for a run, so replays mint identical values.
 */

/** Prefix of a region-tagged webhook token: `wh.<region>.<nanoid>`. */
export const WEBHOOK_TOKEN_PREFIX = 'wh.';

const RUN_ID_PREFIX = 'wrun_';

/** Whether `code` is a region code the hook region encoding can carry. */
export function isKnownHookRegion(code: string): boolean {
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
 * region (an untagged hook ID).
 *
 * - An explicit `region` wins, and must be a known region code.
 * - A webhook without one is stored in its run's region, so webhook
 *   deliveries stay in-region.
 * - Worlds without `hookRegions` store every hook in their only region, so
 *   `region` is ignored there.
 *
 * @throws {Error} for an explicit region that is not a known region code.
 */
export function resolveNewHookRegion(args: {
  region: string | undefined;
  isWebhook: boolean;
  runId: string;
  capabilities: WorldCapabilities | undefined;
}): string | undefined {
  if (args.capabilities?.hookRegions !== true) return undefined;
  if (args.region !== undefined) {
    if (typeof args.region !== 'string' || !isKnownHookRegion(args.region)) {
      throw new Error(
        `\`createHook()\` was called with an unknown \`region\`: ${JSON.stringify(args.region)}. Pass a Vercel region code such as 'iad1' or 'fra1'.`
      );
    }
    return args.region;
  }
  return args.isWebhook ? runRegion(args.runId) : undefined;
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
