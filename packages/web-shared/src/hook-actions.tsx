'use client';

import type { Hook, WorkflowRunStatus } from '@workflow/world';
import { Send } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { resumeHook } from './api/workflow-api-client';
import type { EnvMap } from './api/workflow-server-actions';
import { ResolveHookModal } from './sidebar/resolve-hook-modal';

// ============================================================================
// Types
// ============================================================================

export interface HookActionCallbacks {
  /** Called after a successful action */
  onSuccess?: () => void;
}

export interface UseHookActionsOptions {
  env: EnvMap;
  callbacks?: HookActionCallbacks;
}

export interface UseHookActionsReturn {
  /** Whether the hook is currently being resolved */
  isResolving: boolean;
  /** The hook currently selected for resolution (null if none) */
  selectedHook: Hook | null;
  /** Open the resolve modal for a specific hook */
  openResolveModal: (hook: Hook) => void;
  /** Close the resolve modal */
  closeResolveModal: () => void;
  /** Handle submitting the resolve payload */
  handleResolve: (payload: unknown) => Promise<void>;
}

// ============================================================================
// Hook for managing hook actions state
// ============================================================================

/**
 * React hook for managing hook action state.
 * Use this to coordinate the resolve modal across components.
 */
export function useHookActions({
  env,
  callbacks,
}: UseHookActionsOptions): UseHookActionsReturn {
  const [isResolving, setIsResolving] = useState(false);
  const [selectedHook, setSelectedHook] = useState<Hook | null>(null);

  const openResolveModal = useCallback((hook: Hook) => {
    setSelectedHook(hook);
  }, []);

  const closeResolveModal = useCallback(() => {
    setSelectedHook(null);
  }, []);

  const handleResolve = useCallback(
    async (payload: unknown) => {
      if (isResolving || !selectedHook) return;

      try {
        setIsResolving(true);
        await resumeHook(env, selectedHook.token, payload);
        toast.success('Hook resolved', {
          description: 'The payload has been sent and the hook resolved.',
        });
        setSelectedHook(null);
        callbacks?.onSuccess?.();
      } catch (err) {
        console.error('Failed to resolve hook:', err);
        toast.error('Failed to resolve hook', {
          description:
            err instanceof Error ? err.message : 'An unknown error occurred',
        });
      } finally {
        setIsResolving(false);
      }
    },
    [env, selectedHook, isResolving, callbacks]
  );

  return {
    isResolving,
    selectedHook,
    openResolveModal,
    closeResolveModal,
    handleResolve,
  };
}

// ============================================================================
// Dropdown Menu Item Component
// ============================================================================

export interface HookActionsDropdownItemProps {
  /** The hook to act on */
  hook: Hook;
  /** The current run status (used to determine if actions are available) */
  runStatus?: WorkflowRunStatus;
  /** Stop click event propagation (useful in table rows) */
  stopPropagation?: boolean;
  /** Called when the resolve action is triggered */
  onResolveClick: (hook: Hook) => void;
  /** Custom DropdownMenuItem component (allows using the consumer's UI library) */
  DropdownMenuItem: React.ComponentType<{
    onClick?: (e: React.MouseEvent) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }>;
}

/**
 * Dropdown menu item for resolving a hook.
 * This is a single menu item component that can be composed into dropdown menus.
 */
export function ResolveHookDropdownItem({
  hook,
  stopPropagation = false,
  onResolveClick,
  DropdownMenuItem,
}: HookActionsDropdownItemProps): React.JSX.Element {
  const handleClick = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    onResolveClick(hook);
  };

  return (
    <DropdownMenuItem onClick={handleClick}>
      <Send className="h-4 w-4 mr-2" />
      Resolve Hook
    </DropdownMenuItem>
  );
}

// ============================================================================
// Modal wrapper for convenience
// ============================================================================

export interface HookResolveModalProps {
  /** The hook actions state from useHookActions */
  hookActions: UseHookActionsReturn;
}

/**
 * Convenience wrapper that renders the ResolveHookModal using useHookActions state.
 * Place this at the top level of your component (outside any iteration).
 */
export function HookResolveModalWrapper({
  hookActions,
}: HookResolveModalProps): React.JSX.Element | null {
  const { selectedHook, closeResolveModal, handleResolve, isResolving } =
    hookActions;

  return (
    <ResolveHookModal
      isOpen={selectedHook !== null}
      onClose={closeResolveModal}
      onSubmit={handleResolve}
      isSubmitting={isResolving}
    />
  );
}

// Re-export the modal for direct use
export { ResolveHookModal } from './sidebar/resolve-hook-modal';
