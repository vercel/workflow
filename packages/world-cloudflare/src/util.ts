/**
 * Get a Durable Object stub for a given runId.
 */
export function getRunStub(
  namespace: DurableObjectNamespace,
  runId: string
): DurableObjectStub {
  const id = namespace.idFromName(runId);
  return namespace.get(id);
}

/**
 * Make a typed fetch request to a Durable Object and parse the JSON response.
 */
export async function doFetch<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await stub.fetch(`http://do${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO request failed (${res.status}): ${path} - ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Make a fetch request to a DO that returns a ReadableStream.
 */
export async function doFetchStream(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit
): Promise<ReadableStream<Uint8Array>> {
  const res = await stub.fetch(`http://do${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `DO stream request failed (${res.status}): ${path} - ${text}`
    );
  }
  if (!res.body) {
    throw new Error(`DO stream request returned no body: ${path}`);
  }
  return res.body;
}

/** ISO string or undefined */
export function toISOOrUndef(d: Date | undefined | null): string | undefined {
  return d ? d.toISOString() : undefined;
}
