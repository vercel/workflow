import { useCallback, useOptimistic, useTransition } from 'react';
import {
  type NavigateOptions,
  useNavigate,
  useSearchParams,
} from 'react-router';

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

export type SearchParamUpdates = Record<string, string | null>;

/**
 * URL search params with an optimistic local copy, for UI that is driven by
 * the URL such as tabs.
 *
 * A search param change is a router navigation, and React Router commits it
 * inside a transition, so a click otherwise shows nothing until the
 * navigation settles and the next view renders. The optimistic copy applies
 * the change on the same frame as the click, then hands over to the real URL
 * once the navigation commits (or reverts if it is interrupted).
 */
export function useOptimisticSearchParams(): [
  URLSearchParams,
  (updates: SearchParamUpdates, options?: NavigateOptions) => void,
] {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [optimisticParams, setOptimisticParams] = useOptimistic(searchParams);
  const [, startTransition] = useTransition();

  const updateSearchParams = useCallback(
    (updates: SearchParamUpdates, options?: NavigateOptions) => {
      const next = new URLSearchParams(optimisticParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const search = next.toString();
      startTransition(async () => {
        setOptimisticParams(next);
        await navigate(
          { search: search ? `?${search}` : '' },
          { preventScrollReset: true, ...options }
        );
      });
    },
    [navigate, optimisticParams, setOptimisticParams]
  );

  return [optimisticParams, updateSearchParams];
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
