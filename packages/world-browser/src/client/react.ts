/**
 * React hooks for browser workflows.
 *
 * These hooks provide a convenient way to interact with browser workflows
 * from React components, with proper SSR safety.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Step, WorkflowRun } from '@workflow/world';
import {
  BrowserWorkflowClient,
  type WorkflowSubscriptionCallback,
} from './sdk.js';
import type { AnyWorkerEvent } from '../worker/message-types.js';

// Lazy-initialized client instance
let clientInstance: BrowserWorkflowClient | null = null;

function getClient(): BrowserWorkflowClient {
  if (typeof window === 'undefined') {
    throw new Error(
      'Browser workflow hooks can only be used on the client side'
    );
  }
  if (!clientInstance) {
    clientInstance = new BrowserWorkflowClient();
  }
  return clientInstance;
}

/**
 * Hook for workflow operations (trigger, cancel, etc.)
 *
 * @example
 * ```tsx
 * const { trigger, cancel } = useWorkflow();
 *
 * const handleStart = async () => {
 *   const { runId } = await trigger('my-workflow', { input: 'value' });
 * };
 * ```
 */
export function useWorkflow() {
  const trigger = useCallback(
    async (workflowId: string, ...args: unknown[]) => {
      const client = getClient();
      return client.trigger(workflowId, args);
    },
    []
  );

  const cancel = useCallback(async (runId: string) => {
    const client = getClient();
    return client.cancel(runId);
  }, []);

  const pause = useCallback(async (runId: string) => {
    const client = getClient();
    return client.pause(runId);
  }, []);

  const resume = useCallback(async (runId: string) => {
    const client = getClient();
    return client.resume(runId);
  }, []);

  const getStatus = useCallback(async (runId: string) => {
    const client = getClient();
    return client.getStatus(runId);
  }, []);

  return {
    trigger,
    cancel,
    pause,
    resume,
    getStatus,
  };
}

/**
 * State returned by useWorkflowRun hook.
 */
export interface UseWorkflowRunState {
  /** The workflow run data, null if not loaded yet */
  run: WorkflowRun | null;
  /** Current status of the run */
  status: WorkflowRun['status'] | null;
  /** Output of the completed workflow */
  output: unknown;
  /** Error if the workflow failed */
  error: { message: string; stack?: string; code?: string } | null;
  /** Steps of the workflow */
  steps: Step[];
  /** Whether the data is still loading */
  isLoading: boolean;
  /** Whether the workflow is currently running */
  isRunning: boolean;
  /** Whether the workflow has completed (successfully or with failure) */
  isComplete: boolean;
}

/**
 * Hook to subscribe to a workflow run's status and updates.
 *
 * @param runId - The run ID to subscribe to, or null to not subscribe
 * @returns The current state of the workflow run
 *
 * @example
 * ```tsx
 * const { status, steps, output, isLoading } = useWorkflowRun(runId);
 *
 * if (isLoading) return <Spinner />;
 * if (status === 'completed') return <div>Result: {output}</div>;
 * ```
 */
export function useWorkflowRun(runId: string | null): UseWorkflowRunState {
  const [state, setState] = useState<UseWorkflowRunState>({
    run: null,
    status: null,
    output: undefined,
    error: null,
    steps: [],
    isLoading: !!runId,
    isRunning: false,
    isComplete: false,
  });

  // Track mounted state
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!runId || typeof window === 'undefined') {
      setState({
        run: null,
        status: null,
        output: undefined,
        error: null,
        steps: [],
        isLoading: false,
        isRunning: false,
        isComplete: false,
      });
      return;
    }

    const client = getClient();
    let unsubscribe: (() => void) | null = null;

    // Fetch initial state
    const fetchInitialState = async () => {
      try {
        const [run, stepsResult] = await Promise.all([
          client.getStatus(runId),
          client.getSteps(runId),
        ]);

        if (!mountedRef.current) return;

        const isComplete =
          run.status === 'completed' ||
          run.status === 'failed' ||
          run.status === 'cancelled';

        setState({
          run,
          status: run.status,
          output: run.output,
          error: run.error ?? null,
          steps: stepsResult.data,
          isLoading: false,
          isRunning: run.status === 'running',
          isComplete,
        });
      } catch (error) {
        if (!mountedRef.current) return;

        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    };

    // Subscribe to updates
    const handleEvent: WorkflowSubscriptionCallback = (
      event: AnyWorkerEvent
    ) => {
      if (!mountedRef.current) return;

      switch (event.type) {
        case 'RUN_UPDATED':
        case 'RUN_COMPLETED':
        case 'RUN_FAILED': {
          const run = event.run;
          const isComplete =
            run.status === 'completed' ||
            run.status === 'failed' ||
            run.status === 'cancelled';

          setState((prev) => ({
            ...prev,
            run,
            status: run.status,
            output: run.output,
            error: run.error ?? null,
            isRunning: run.status === 'running',
            isComplete,
          }));
          break;
        }
        case 'STEP_UPDATED': {
          setState((prev) => {
            const existingIndex = prev.steps.findIndex(
              (s) => s.stepId === event.step.stepId
            );
            if (existingIndex >= 0) {
              const newSteps = [...prev.steps];
              newSteps[existingIndex] = event.step;
              return { ...prev, steps: newSteps };
            } else {
              return { ...prev, steps: [...prev.steps, event.step] };
            }
          });
          break;
        }
      }
    };

    unsubscribe = client.subscribe(runId, handleEvent);
    fetchInitialState();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [runId]);

  return state;
}

/**
 * Options for useWorkflowRuns hook.
 */
export interface UseWorkflowRunsOptions {
  /** Filter by workflow name */
  workflowName?: string;
  /** Filter by status */
  status?: WorkflowRun['status'];
  /** Maximum number of runs to return */
  limit?: number;
}

/**
 * State returned by useWorkflowRuns hook.
 */
export interface UseWorkflowRunsState {
  /** List of workflow runs */
  runs: WorkflowRun[];
  /** Whether the data is still loading */
  isLoading: boolean;
  /** Error if the fetch failed */
  error: Error | null;
  /** Whether there are more runs to load */
  hasMore: boolean;
  /** Cursor for pagination */
  cursor: string | null;
  /** Function to refresh the list */
  refresh: () => Promise<void>;
}

/**
 * Hook to list workflow runs.
 *
 * @param options - Options for filtering and pagination
 * @returns The list of workflow runs and loading state
 *
 * @example
 * ```tsx
 * const { runs, isLoading, refresh } = useWorkflowRuns({ limit: 10 });
 * ```
 */
export function useWorkflowRuns(
  options: UseWorkflowRunsOptions = {}
): UseWorkflowRunsState {
  const [state, setState] = useState<UseWorkflowRunsState>({
    runs: [],
    isLoading: true,
    error: null,
    hasMore: false,
    cursor: null,
    refresh: async () => {},
  });

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchRuns = useCallback(async () => {
    if (typeof window === 'undefined') return;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const client = getClient();
      const result = await client.listRuns({
        workflowName: options.workflowName,
        status: options.status,
        limit: options.limit,
      });

      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        runs: result.data,
        hasMore: result.hasMore,
        cursor: result.cursor,
        isLoading: false,
      }));
    } catch (error) {
      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, [options.workflowName, options.status, options.limit]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Return state with refresh function
  return {
    ...state,
    refresh: fetchRuns,
  };
}

/**
 * Hook to get current step progress of a workflow.
 *
 * @param runId - The run ID to get progress for
 * @returns The current step information
 */
export function useWorkflowProgress(runId: string | null) {
  const { steps, status, isLoading } = useWorkflowRun(runId);

  const currentStep = steps.find((s) => s.status === 'running');
  const completedSteps = steps.filter((s) => s.status === 'completed');
  const failedSteps = steps.filter((s) => s.status === 'failed');
  const pendingSteps = steps.filter((s) => s.status === 'pending');

  const progress =
    steps.length > 0 ? (completedSteps.length / steps.length) * 100 : 0;

  return {
    steps,
    currentStep,
    completedSteps,
    failedSteps,
    pendingSteps,
    progress,
    status,
    isLoading,
    totalSteps: steps.length,
    completedCount: completedSteps.length,
  };
}
