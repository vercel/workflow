'use client';

import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { get403ErrorMessage } from '@/lib/errors';
import { DEFAULT_PAGE_SIZE } from '@/lib/utils';
import { PageSizeDropdown } from './page-size-dropdown';
import { TableSkeleton } from './table-skeleton';

export interface ColumnDefinition<T> {
  header: string;
  render: (item: T) => React.ReactNode;
  key: string;
}

interface LocalPaginatingTableProps<T> {
  /** All items to paginate through */
  items: T[];
  /** Column definitions */
  columns: ColumnDefinition<T>[];
  /** Table title */
  title: string;
  /** Whether data is still loading */
  loading?: boolean;
  /** Error if any */
  error?: Error | null;
  /** Function to get unique key for each item */
  getItemKey: (item: T) => string;
  /** Optional row click handler */
  onRowClick?: (item: T) => void;
  /** Optional function to determine if a row is selected */
  isRowSelected?: (item: T) => boolean;
  /** Optional callback when refresh is clicked (for exhaustive lists with live mode) */
  onRefresh?: () => void;
  /** Optional custom empty state message */
  emptyMessage?: React.ReactNode | string;
  /** Optional custom header actions */
  headerActions?: React.ReactNode;
  /** Warning message to show at the top (e.g., when limit exceeded) */
  warningMessage?: string;
  /** Whether the 1000 item limit was hit */
  hasHitLimit?: boolean;
  /** Whether all available data has been reached */
  hasReachedEnd?: boolean;
}

/**
 * LocalPaginatingTable - A table component that paginates through existing data client-side.
 * Does not make async calls; all data should be provided via the `items` prop.
 *
 * This pattern is used for step and event tables, where we exhaustively fetch all data
 * upfront and then paginate through it locally for better UX.
 */
export function LocalPaginatingTable<T>({
  items,
  columns,
  title,
  loading = false,
  error = null,
  getItemKey,
  onRowClick,
  isRowSelected,
  onRefresh,
  emptyMessage = 'No items found',
  headerActions,
  warningMessage,
  hasHitLimit = false,
  hasReachedEnd = false,
}: LocalPaginatingTableProps<T>) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);

  // Calculate pagination
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, items.length);
  const currentPageItems = items.slice(startIndex, endIndex);

  // Reset to first page when items change
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(1);
    }
  }, [currentPage, totalPages]);

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setCurrentPage(1); // Reset to first page when changing page size
  };

  // Show skeleton for initial load
  if (loading && items.length === 0) {
    return <TableSkeleton title={title} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl my-4 font-semibold leading-none tracking-tight">
          {title}
        </h2>
        <div className="flex items-center gap-4">
          {headerActions}
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          )}
        </div>
      </div>
      {warningMessage && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Warning</AlertTitle>
          <AlertDescription>{warningMessage}</AlertDescription>
        </Alert>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Error loading {title.toLowerCase()}</AlertTitle>
          <AlertDescription>{get403ErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column.key}>{column.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentPageItems.map((item) => {
                const itemKey = getItemKey(item);
                const isSelected = isRowSelected?.(item) ?? false;

                return (
                  <TableRow
                    key={itemKey}
                    className={`${onRowClick ? 'cursor-pointer' : ''} ${
                      isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                    }`}
                    onClick={() => onRowClick?.(item)}
                  >
                    {columns.map((column) => (
                      <TableCell key={`${itemKey}-${column.key}`}>
                        {column.render(item)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="space-y-2">
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Showing {startIndex + 1}-{endIndex} of {items.length}
                {hasHitLimit && ' (limit reached)'}
              </div>
              <div className="flex gap-2 items-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={currentPage >= totalPages}
                >
                  Next
                  <ChevronRight />
                </Button>
              </div>
            </div>

            {/* Show info message on last page when limit hit or more data might be available */}
            {currentPage === totalPages && !hasReachedEnd && (
              <div className="text-xs text-muted-foreground text-center py-2 bg-muted/30 rounded">
                {hasHitLimit
                  ? 'Displaying first 1,000 items. More data may be available but cannot be fetched due to the item limit.'
                  : 'More data might be available but cannot currently be fetched.'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
