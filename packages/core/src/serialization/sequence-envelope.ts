import type { SequenceRecipe } from '../sequence.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = encoder.encode('seq1');
const HEADER_BYTES = 8;

export type SequenceEnvelope = {
  payload: Uint8Array;
  parseRecipes(): SequenceRecipe[];
};

export function wrapSequenceEnvelope(
  payload: Uint8Array,
  recipes: SequenceRecipe[]
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

export function splitSequenceEnvelope(payload: Uint8Array): SequenceEnvelope {
  if (payload.length < 4 || !PREFIX.every((byte, i) => payload[i] === byte)) {
    return { payload, parseRecipes: () => [] };
  }
  if (payload.length < HEADER_BYTES)
    throw new Error('Truncated Sequence envelope');
  const recipeLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  ).getUint32(4);
  const nestedOffset = HEADER_BYTES + recipeLength;
  if (nestedOffset > payload.length)
    throw new Error('Truncated Sequence recipe table');
  const recipeBytes = payload.subarray(HEADER_BYTES, nestedOffset);
  let parsed: SequenceRecipe[] | undefined;
  return {
    payload: payload.subarray(nestedOffset),
    parseRecipes() {
      if (parsed) return parsed;
      let envelope: unknown;
      try {
        envelope = JSON.parse(decoder.decode(recipeBytes));
      } catch {
        throw new Error('Malformed Sequence recipe table');
      }
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        (envelope as { version?: unknown }).version !== 1 ||
        !Array.isArray((envelope as { recipes?: unknown }).recipes)
      ) {
        throw new Error('Unsupported Sequence recipe envelope');
      }
      parsed = (envelope as { recipes: SequenceRecipe[] }).recipes;
      return parsed;
    },
  };
}
