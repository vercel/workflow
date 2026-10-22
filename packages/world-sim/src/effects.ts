/**
 * What user code ran, recorded from step bodies themselves.
 *
 * The event log says what a run *committed*, which is silent about a
 * candidate that never became a run: if a refused start ran a step body
 * before its refusal (an optimistic inline start, say), nothing durable
 * shows it. So the workflows a start Hook scenario plays record each side
 * effect here, from inside the step body, and `NoLoserExecution` reads it.
 *
 * A process-global registry rather than an import: step bodies are compiled
 * into the scenario bundle, and keying on `Symbol.for` keeps world-sim out of
 * it. A step records with:
 *
 * ```ts
 * const g = globalThis as Record<symbol, unknown>;
 * const key = Symbol.for('@workflow/world-sim/effects');
 * ((g[key] ??= []) as unknown[]).push({ runId, label, attempt });
 * ```
 */

import type { SimEffect } from './types.js';

export const SIM_EFFECTS_KEY: unique symbol = Symbol.for(
  '@workflow/world-sim/effects'
) as never;

type EffectHost = Record<symbol, SimEffect[] | undefined>;

/** Start a fresh effect log for one scenario. */
export function resetEffects(): void {
  (globalThis as unknown as EffectHost)[SIM_EFFECTS_KEY] = [];
}

export function readEffects(): SimEffect[] {
  return [...((globalThis as unknown as EffectHost)[SIM_EFFECTS_KEY] ?? [])];
}
