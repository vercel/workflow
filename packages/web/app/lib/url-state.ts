import { useCallback, useOptimistic, useTransition } from 'react';
import {
  type NavigateOptions,
  useNavigate,
  useSearchParams,
} from 'react-router';

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
