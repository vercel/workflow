export const SEQUENCE_CLASS_ID = 'class//workflow//Sequence';

export type SequenceRef = {
  runId: string;
  stepId: string;
  slot: string;
  length: number;
};

export function isSequenceRef(value: unknown): value is SequenceRef {
  const ref = value as SequenceRef;
  return (
    !!ref &&
    typeof ref.runId === 'string' &&
    typeof ref.stepId === 'string' &&
    typeof ref.slot === 'string' &&
    Number.isSafeInteger(ref.length) &&
    ref.length >= 0
  );
}
