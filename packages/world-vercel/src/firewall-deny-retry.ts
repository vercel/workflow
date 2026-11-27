/**
 * One delayed retry for a request the Vercel Firewall denied.
 *
 * A 403 has two possible origins. Usually world-vercel decided it, and
 * retrying changes nothing. But a request can also be refused by the Vercel
 * Firewall before it reaches world-vercel; the Vercel edge then answers 403
 * with `x-vercel-mitigated: deny`, a header world-vercel never sets. Such a
 * deny says nothing about the request itself and can lift, so it is worth one
 * more attempt.
 *
 * Exactly one, and late: a deny usually means the edge is shedding traffic,
 * and a quick or repeated retry would add to it. A request the Firewall denied
 * is re-sent once, {@link FIREWALL_DENY_RETRY_DELAY_MS} later. If that attempt
 * is denied too, its response goes to the caller as before.
 *
 * Only a 403 whose `x-vercel-mitigated` is exactly `deny` is retried. A 403
 * without the header, a challenge (`x-vercel-mitigated: challenge`, answered
 * as 429 and handled by `isFirewallChallenge429`), and every other status are
 * returned untouched.
 */

/** How long to wait before re-sending a request the Firewall denied. */
export const FIREWALL_DENY_RETRY_DELAY_MS = 10_000;

/** A 403 the Vercel Firewall sent, not the service behind it. */
export function isFirewallDeny(
  status: number,
  mitigated: string | null | undefined
): boolean {
  return status === 403 && mitigated === 'deny';
}

/**
 * Sends a request with `send`, and re-sends it once after
 * {@link FIREWALL_DENY_RETRY_DELAY_MS} when the Vercel Firewall denied it.
 *
 * `send` must build a fresh request each time it is called, so its body can
 * be sent again. A `signal` that aborts during the wait ends it, throwing the
 * abort reason, as the request itself would have.
 */
export async function withFirewallDenyRetry<R>(
  send: () => Promise<R>,
  options: {
    /** Status and `x-vercel-mitigated` of a response. */
    inspect: (response: R) => {
      status: number;
      mitigated: string | null | undefined;
    };
    /** Releases a denied response's connection before the wait. */
    discard: (response: R) => Promise<unknown>;
    /** What the request is, for the log line. */
    label: string;
    signal?: AbortSignal;
  }
): Promise<R> {
  const first = await send();
  const { status, mitigated } = options.inspect(first);
  if (!isFirewallDeny(status, mitigated) || options.signal?.aborted) {
    return first;
  }
  console.warn(
    `[workflow] The Vercel Firewall denied ${options.label} (403, x-vercel-mitigated: deny); retrying once in ${FIREWALL_DENY_RETRY_DELAY_MS / 1000}s`
  );
  await options.discard(first);
  const waited = await sleep(FIREWALL_DENY_RETRY_DELAY_MS, options.signal);
  if (!waited) {
    // Aborted while waiting: the caller asked for no more attempts.
    options.signal?.throwIfAborted();
  }
  return send();
}

/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** {@link withFirewallDenyRetry} options for a fetch `Response`. */
export const fetchResponse = {
  inspect: (response: Response) => ({
    status: response.status,
    mitigated: response.headers.get('x-vercel-mitigated'),
  }),
  // Draining also works for Next.js's cloned GET responses: cancelling one
  // tee branch waits for the other branch, which Next.js keeps cached.
  discard: (response: Response) => response.text().catch(() => {}),
};
