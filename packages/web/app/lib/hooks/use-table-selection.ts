import { useCallback, useMemo, useState } from 'react';

export interface UseTableSelectionOptions<T> {
  /** Function to extract unique ID from each item */
  getItemId: (item: T) => string;
}

export interface UseTableSelectionReturn<T> {
  /** Set of currently selected item IDs */
  selectedIds: Set<string>;
  /** Whether a specific item is selected */
  isSelected: (item: T) => boolean;
  /** Toggle selection of a single item */
  toggleSelection: (item: T) => void;
  /** Select all items in the provided list */
  selectAll: (items: T[]) => void;
  /** Clear all selections */
  clearSelection: () => void;
  /** Toggle all items (select all if not all selected, otherwise clear) */
  toggleSelectAll: (items: T[]) => void;
  /** Number of selected items */
  selectionCount: number;
  /** Whether all provided items are selected */
  isAllSelected: (items: T[]) => boolean;
  /** Whether some but not all items are selected (for indeterminate state) */
  isSomeSelected: (items: T[]) => boolean;
  /** Select a specific item by ID */
  selectById: (id: string) => void;
  /** Deselect a specific item by ID */
  deselectById: (id: string) => void;
}

/**
 * Hook for managing table row selection state.
 * Provides a consistent interface for multi-select functionality across different tables.
 */
export function useTableSelection<T>({
  getItemId,
}: UseTableSelectionOptions<T>): UseTableSelectionReturn<T> {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const isSelected = useCallback(
    (item: T) => selectedIds.has(getItemId(item)),
    [selectedIds, getItemId]
  );

  const toggleSelection = useCallback(
    (item: T) => {
      const id = getItemId(item);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [getItemId]
  );

  const selectAll = useCallback(
    (items: T[]) => {
      setSelectedIds(new Set(items.map(getItemId)));
    },
    [getItemId]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isAllSelected = useCallback(
    (items: T[]) => {
      if (items.length === 0) return false;
      return items.every((item) => selectedIds.has(getItemId(item)));
    },
    [selectedIds, getItemId]
  );

  const isSomeSelected = useCallback(
    (items: T[]) => {
      if (items.length === 0) return false;
      const someSelected = items.some((item) =>
        selectedIds.has(getItemId(item))
      );
      const allSelected = items.every((item) =>
        selectedIds.has(getItemId(item))
      );
      return someSelected && !allSelected;
    },
    [selectedIds, getItemId]
  );

  const toggleSelectAll = useCallback(
    (items: T[]) => {
      if (isAllSelected(items)) {
        clearSelection();
      } else {
        selectAll(items);
      }
    },
    [isAllSelected, clearSelection, selectAll]
  );

  const selectById = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const deselectById = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const selectionCount = selectedIds.size;

  return useMemo(
    () => ({
      selectedIds,
      isSelected,
      toggleSelection,
      selectAll,
      clearSelection,
      toggleSelectAll,
      selectionCount,
      isAllSelected,
      isSomeSelected,
      selectById,
      deselectById,
    }),
    [
      selectedIds,
      isSelected,
      toggleSelection,
      selectAll,
      clearSelection,
      toggleSelectAll,
      selectionCount,
      isAllSelected,
      isSomeSelected,
      selectById,
      deselectById,
    ]
  );
}
