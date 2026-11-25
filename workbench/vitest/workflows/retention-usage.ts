/** Hands its payload to a step, so the run writes it more than once. */
export async function digestPayload(data: Uint8Array) {
  'use step';
  let sum = 0;
  for (const byte of data) sum = (sum + byte) % 65_521;
  return { length: data.length, sum };
}

export async function retentionUsageWorkflow(data: Uint8Array) {
  'use workflow';
  return digestPayload(data);
}
