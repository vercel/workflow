/**
 * JSON encoding for the documents world-local stores in SQLite.
 *
 * Entities and events are stored as JSON documents next to the columns they
 * are queried by. Two value types do not survive plain JSON and are tagged:
 *
 * - `Uint8Array` (every serialized payload) as `{ "__type": "Uint8Array", "data": "<base64>" }`;
 * - `Date` as `{ "__type": "Date", "value": "<ISO 8601>" }`.
 *
 * `decode(encode(x))` returns a structurally equal value with the same types,
 * so a row reads back exactly as it was written, with no schema pass.
 */

type Tagged =
  | { __type: 'Uint8Array'; data: string }
  | { __type: 'Date'; value: string };

function replacer(this: unknown, key: string, value: unknown): unknown {
  // `JSON.stringify` calls `toJSON` before the replacer sees a Date, so read
  // the raw value from the holder.
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Date) {
    return { __type: 'Date', value: raw.toISOString() } satisfies Tagged;
  }
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      ).toString('base64'),
    } satisfies Tagged;
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const tagged = value as Partial<
      Record<'__type' | 'data' | 'value', unknown>
    >;
    if (tagged.__type === 'Uint8Array' && typeof tagged.data === 'string') {
      return new Uint8Array(Buffer.from(tagged.data, 'base64'));
    }
    if (tagged.__type === 'Date' && typeof tagged.value === 'string') {
      return new Date(tagged.value);
    }
  }
  return value;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

export function decode<T>(text: unknown): T {
  return JSON.parse(String(text), reviver) as T;
}

/**
 * The queue's wire format (unchanged from earlier releases): `Uint8Array` as
 * `{ __type: 'Uint8Array', data }`, everything else plain JSON.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(value).toString('base64'),
    };
  }
  return value;
}

export function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { __type?: unknown }).__type === 'Uint8Array' &&
    typeof (value as { data?: unknown }).data === 'string'
  ) {
    return new Uint8Array(
      Buffer.from((value as { data: string }).data, 'base64')
    );
  }
  return value;
}
