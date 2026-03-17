'use client';

import { useActionState } from 'react';
import {
  type DirectImportedStepActionState,
  runDirectImportedStepAction,
} from './actions';

const initialState: DirectImportedStepActionState = {
  error: null,
  result: null,
};

/**
 * Small interactive harness for the server-action repro.
 */
export function ServerActionReproForm() {
  const [state, formAction, isPending] = useActionState(
    runDirectImportedStepAction,
    initialState
  );

  return (
    <form action={formAction} className="space-y-4">
      <button
        type="submit"
        className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        disabled={isPending}
      >
        {isPending ? 'Running…' : 'Run direct step server action'}
      </button>

      <div className="rounded border p-4 text-sm">
        <div>
          <strong>Expected:</strong> <code>step-result:42</code>
        </div>
        <div>
          <strong>Result:</strong> <code>{state.result ?? 'pending'}</code>
        </div>
        <div>
          <strong>Error:</strong> <code>{state.error ?? 'none'}</code>
        </div>
      </div>
    </form>
  );
}
