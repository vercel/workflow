import type { ChainRecipe } from '../chain-ref.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = encoder.encode('chn1');
const HEADER_BYTES = 8;

export type ChainEnvelope = {
  payload: Uint8Array;
  parseRecipes(): ChainRecipe[];
};

export function wrapChainEnvelope(
  payload: Uint8Array,
  recipes: ChainRecipe[]
): Uint8Array {
  if (recipes.length === 0) return payload;
  const recipeBytes = encoder.encode(JSON.stringify({ version: 1, recipes }));
  const output = new Uint8Array(
    HEADER_BYTES + recipeBytes.length + payload.length
  );
  output.set(PREFIX);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    4,
    recipeBytes.length
  );
  output.set(recipeBytes, HEADER_BYTES);
  output.set(payload, HEADER_BYTES + recipeBytes.length);
  return output;
}

export function splitChainEnvelope(payload: Uint8Array): ChainEnvelope {
  if (payload.length < 4 || !PREFIX.every((byte, i) => payload[i] === byte)) {
    return { payload, parseRecipes: () => [] };
  }
  if (payload.length < HEADER_BYTES)
    throw new Error('Truncated Chain envelope');
  const recipeLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  ).getUint32(4);
  const nestedOffset = HEADER_BYTES + recipeLength;
  if (nestedOffset > payload.length)
    throw new Error('Truncated Chain recipe table');
  const recipeBytes = payload.subarray(HEADER_BYTES, nestedOffset);
  let parsed: ChainRecipe[] | undefined;
  return {
    payload: payload.subarray(nestedOffset),
    parseRecipes() {
      if (parsed) return parsed;
      let envelope: unknown;
      try {
        envelope = JSON.parse(decoder.decode(recipeBytes));
      } catch {
        throw new Error('Malformed Chain recipe table');
      }
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        (envelope as { version?: unknown }).version !== 1 ||
        !Array.isArray((envelope as { recipes?: unknown }).recipes)
      ) {
        throw new Error('Unsupported Chain recipe envelope');
      }
      parsed = (envelope as { recipes: ChainRecipe[] }).recipes;
      return parsed;
    },
  };
}
