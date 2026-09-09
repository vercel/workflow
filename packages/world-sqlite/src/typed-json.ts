const BYTE_SENTINEL = 'Uint8Array';

interface ByteEnvelope {
  __type: typeof BYTE_SENTINEL;
  data: string;
}

function isByteEnvelope(value: unknown): value is ByteEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ByteEnvelope>;
  return (
    candidate.__type === BYTE_SENTINEL && typeof candidate.data === 'string'
  );
}

export function serializeQueuePayload(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value, function (key, current: unknown) {
      const original =
        key === '' ? value : (this as Record<string, unknown>)[key];
      if (original instanceof Uint8Array) {
        return {
          __type: BYTE_SENTINEL,
          data: Buffer.from(original).toString('base64'),
        } satisfies ByteEnvelope;
      }
      return current;
    })
  );
}

export function deserializeQueuePayload(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString(), (_key, value: unknown) =>
    isByteEnvelope(value) ? Buffer.from(value.data, 'base64') : value
  );
}
