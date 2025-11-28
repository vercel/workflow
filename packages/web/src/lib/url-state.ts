'use client';

import { parseAsString, useQueryState, useQueryStates } from 'nuqs';

/**
 * Hook to manage sidebar state in URL
 */
export function useSidebarState() {
  return useQueryState('sidebar', parseAsString);
}

/**
 * Hook to manage theme state in URL
 */
export function useThemeState() {
  return useQueryState('theme', parseAsString.withDefault('system'));
}

/**
 * Hook to manage tab selection state in URL
 */
export function useTabState() {
  return useQueryState('tab', parseAsString.withDefault('runs'));
}

/**
 * Hook to manage multiple navigation params at once
 */
export function useNavigationParams() {
  return useQueryStates({
    sidebar: parseAsString,
    hookId: parseAsString,
    stepId: parseAsString,
    eventId: parseAsString,
    streamId: parseAsString,
    runId: parseAsString,
    id: parseAsString,
    resource: parseAsString,
  });
}

/**
 * Hook to manage individual navigation params
 */
export function useHookIdState() {
  return useQueryState('hookId', parseAsString);
}

export function useStepIdState() {
  return useQueryState('stepId', parseAsString);
}

export function useEventIdState() {
  return useQueryState('eventId', parseAsString);
}

export function useStreamIdState() {
  return useQueryState('streamId', parseAsString);
}

/**
 * Hook to manage selected workflow ID for graph visualization
 */
export function useWorkflowIdState() {
  return useQueryState('workflowId', parseAsString);
}
