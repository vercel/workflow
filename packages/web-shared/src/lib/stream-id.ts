/**
 * Describes opaque stream IDs for display in the observability UI.
 *
 * Stream IDs written by the runtime carry a decodable structure
 * (see `getWorkflowRunStreamId` / `getAbortStreamId` in `@workflow/core`):
 *
 * - `strm_<ulid>_user` — the run's default user stream
 * - `strm_<ulid>_user_<base64url(namespace)>` — a named user stream
 * - `strm_<id>_system_abort` — a hook's abort-signal backing stream
 *
 * Anything else is reported verbatim so future or foreign formats stay
 * inspectable instead of being mislabeled.
 */

export type StreamIdKind = 'user-default' | 'user-named' | 'system' | 'unknown';

export interface StreamIdDescription {
  kind: StreamIdKind;
  /**
   * Short human-meaningful name for the stream: the decoded namespace for
   * named user streams, otherwise a fixed label ("Default stream",
   * "Abort signal") or the raw ID when the format is unrecognized.
   */
  label: string;
  /** Decoded namespace, present only for `user-named` streams. */
  namespace?: string;
}

const STREAM_ID_PATTERN = /^strm_(?<id>[^_]+)_(?<rest>.+)$/;
const USER_SEGMENT = 'user';
const ABORT_SUFFIX = 'system_abort';

function decodeBase64Url(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function describeStreamId(streamId: string): StreamIdDescription {
  const match = STREAM_ID_PATTERN.exec(streamId);
  if (!match?.groups) {
    return { kind: 'unknown', label: streamId };
  }

  const { rest } = match.groups;

  if (rest === ABORT_SUFFIX) {
    return { kind: 'system', label: 'Abort signal' };
  }

  if (rest === USER_SEGMENT) {
    return { kind: 'user-default', label: 'Default stream' };
  }

  if (rest.startsWith(`${USER_SEGMENT}_`)) {
    const encoded = rest.slice(USER_SEGMENT.length + 1);
    const namespace = decodeBase64Url(encoded);
    if (namespace) {
      return { kind: 'user-named', label: namespace, namespace };
    }
  }

  return { kind: 'unknown', label: streamId };
}
