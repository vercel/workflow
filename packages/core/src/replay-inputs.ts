import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { FatalError } from '@workflow/errors';
import { captureReplayInputs as capturePlainInputs } from './replay-inputs-capture.js';

export interface ReplayInputCapture {
  index: number;
  encoded: string;
}

export function captureReplayInputs(
  args: unknown[],
  indices?: readonly number[]
) {
  return capturePlainInputs(args, indices, types.isProxy);
}

export const REPLAY_INPUT_LABEL = 'reconstructed through replay';

function decodeReplayValue(value: any, references: unknown[] = []): any {
  if (!Array.isArray(value)) return value;
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'negative-zero':
      return -0;
    case 'reference':
      return references[value[1]];
    default: {
      const result =
        value[0] === 'array'
          ? new Array(value[2])
          : Object.create(value[0] === 'null-object' ? null : Object.prototype);
      references[value[1]] = result;
      for (const [key, child] of value[3]) {
        Object.defineProperty(result, key, {
          value: decodeReplayValue(child, references),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
}

export function replayInputEnvelope(captures?: ReplayInputCapture[]) {
  return captures?.length
    ? {
        version: 1,
        arguments: captures.map(({ index, encoded }) => ({
          index,
          fingerprint: createHash('sha256').update(encoded).digest('hex'),
        })),
      }
    : undefined;
}

/** Only the executor materializes captures; persisted ordinary arguments win. */
export function materializeReplayInputs(
  input: { args: unknown[]; replayInputs?: unknown },
  captures?: ReplayInputCapture[]
): unknown[] {
  if (input.replayInputs === undefined) return input.args;
  const expected = replayInputEnvelope(captures);
  if (
    !expected ||
    JSON.stringify(input.replayInputs) !== JSON.stringify(expected)
  ) {
    throw new FatalError(
      'Replay-derived step input mismatch: argument indices or integrity fingerprints differ from the recorded invocation'
    );
  }
  const args = input.args.slice();
  for (const { index, encoded } of captures!) {
    if (index >= args.length && encoded === '["undefined"]') continue;
    if (index >= args.length || args[index] !== REPLAY_INPUT_LABEL) {
      throw new FatalError('Invalid replay-derived step input envelope');
    }
    args[index] = decodeReplayValue(JSON.parse(encoded));
  }
  return args;
}
