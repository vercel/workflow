export const CHAIN_CLASS_ID = 'class//workflow//Chain';

export type ChainRef = {
  runId: string;
  stepId: string;
  slot: string;
  length: number;
};

export type ChainRecipe = {
  slot: string;
  length: number;
  base?: ChainRef;
  take: number;
  additions: unknown[];
};

export function isChainRef(value: unknown): value is ChainRef {
  const ref = value as ChainRef;
  return (
    !!ref &&
    typeof ref.runId === 'string' &&
    typeof ref.stepId === 'string' &&
    typeof ref.slot === 'string' &&
    Number.isSafeInteger(ref.length) &&
    ref.length >= 0
  );
}
