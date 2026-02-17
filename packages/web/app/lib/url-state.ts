import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

type SetValue = (value: string | null) => void;

/**
 * Generic hook for managing a single URL search parameter.
 * Replaces the nuqs `useQueryState` pattern.
 */
function useUrlParam(
  key: string,
  defaultValue?: string
): [string | null, SetValue] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? defaultValue ?? null;

  const setValue = useCallback(
    (newValue: string | null) => {
      setSearchParams(
        (prev) => {
          if (newValue === null || newValue === undefined) {
            prev.delete(key);
          } else {
            prev.set(key, newValue);
          }
          return prev;
        },
        { replace: true }
      );
    },
    [key, setSearchParams]
  );

  return [value, setValue];
}

/**
 * Hook to manage sidebar state in URL
 */
export function useSidebarState() {
  return useUrlParam('sidebar');
}

/**
 * Hook to manage theme state in URL
 */
export function useThemeState() {
  return useUrlParam('theme', 'system');
}

/**
 * Hook to manage tab selection state in URL
 */
export function useTabState(): [string, SetValue] {
  const [value, setValue] = useUrlParam('tab', 'runs');
  return [value ?? 'runs', setValue];
}

/**
 * Hook to manage individual navigation params
 */
export function useHookIdState() {
  return useUrlParam('hookId');
}

export function useStepIdState() {
  return useUrlParam('stepId');
}

export function useEventIdState() {
  return useUrlParam('eventId');
}

export function useStreamIdState() {
  return useUrlParam('streamId');
}

/**
 * Hook to manage selected workflow ID for graph visualization
 */
export function useWorkflowIdState() {
  return useUrlParam('workflowId');
}
