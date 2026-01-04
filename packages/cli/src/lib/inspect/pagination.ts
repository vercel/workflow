/**
 * Interactive pagination for CLI tables
 */
import readline from 'node:readline';
import { logger } from '../config/log.js';
import { isInteractive } from './terminal-utils.js';

export interface PaginationState {
  cursor: string | null | undefined;
  hasMore: boolean;
  hasPrevious: boolean;
  currentPage: number;
  totalPages: number;
  hasMorePagesAvailable: boolean;
}

export interface PaginationCallbacks {
  onNext: () => Promise<void>;
  onPrevious: () => Promise<void>;
  onExit: () => void;
}

/**
 * Setup interactive pagination listener
 */
export const setupPaginationListener = (
  state: PaginationState,
  callbacks: PaginationCallbacks
): (() => void) => {
  if (!isInteractive()) {
    return () => {}; // No-op cleanup function
  }

  // Enable raw mode for immediate key capture
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  const keypressHandler = async (_chunk: string, key: any) => {
    if (!key) return;

    // Handle exit
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      callbacks.onExit();
      return;
    }

    // Handle next page
    if (
      (key.name === 'n' && !key.ctrl) ||
      key.name === 'right' ||
      key.name === 'down'
    ) {
      if (state.hasMore) {
        await callbacks.onNext();
      } else {
        logger.warn('No more pages available');
      }
      return;
    }

    // Handle previous page
    if (
      (key.name === 'p' && !key.ctrl) ||
      key.name === 'left' ||
      key.name === 'up'
    ) {
      // Always allow going "previous" - on first page it reloads
      await callbacks.onPrevious();
      return;
    }
  };

  process.stdin.on('keypress', keypressHandler);

  // Return cleanup function
  return () => {
    process.stdin.off('keypress', keypressHandler);
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
};

/**
 * Show pagination state info
 */
export const showPaginationState = (state: PaginationState) => {
  const parts: string[] = [];

  // Show page indicator
  // Use hasMorePagesAvailable to determine if there are unknown pages beyond what we've loaded
  const pageIndicator = state.hasMorePagesAvailable
    ? `Page ${state.currentPage} of ${state.totalPages}+`
    : `Page ${state.currentPage} of ${state.totalPages}`;
  parts.push(pageIndicator);

  if (state.hasPrevious) {
    parts.push('[p] Previous');
  } else {
    parts.push('[p] Reload');
  }

  if (state.hasMore) {
    parts.push('[n] Next');
  }

  parts.push('[q] Quit (or Ctrl+C)');
  logger.log(`\n${parts.join(' | ')}`);
};

/**
 * Page data structure for caching paginated results
 */
export interface PageData<T> {
  data: T[];
  cursor: string | null | undefined;
  hasMore: boolean;
}

/**
 * Generic pagination handler for list operations
 */
export interface ListPaginationOptions<TData> {
  /**
   * Initial cursor from CLI options
   */
  initialCursor?: string;

  /**
   * Fetch function that returns paginated data
   */
  fetchPage: (cursor: string | undefined) => Promise<PageData<TData>>;

  /**
   * Display function that renders the current page
   */
  displayPage: (data: TData[], pageIndex: number) => void | Promise<void>;

  /**
   * Optional callback for when fetching starts
   */
  onFetchStart?: (pageIndex: number) => void;

  /**
   * Enable interactive pagination with keyboard controls
   */
  interactive?: boolean;
}

/**
 * Setup pagination for list operations with page caching
 */
export async function setupListPagination<TData>(
  options: ListPaginationOptions<TData>
): Promise<void> {
  const { initialCursor, fetchPage, displayPage, onFetchStart, interactive } =
    options;

  // Interactive mode requires both TTY support and explicit --interactive flag
  const enableInteractive = interactive && isInteractive();

  // Pages stack - stores all fetched pages
  const pages: PageData<TData>[] = [];

  // Current page index (0-based)
  let pageIndex = 0;

  /**
   * Fetch and display a specific page
   */
  const showPage = async (index: number, cursor?: string) => {
    if (onFetchStart) {
      onFetchStart(index);
    }

    const page = await fetchPage(cursor);
    pages[index] = page;
    pageIndex = index;

    // Clear screen for subsequent pages in interactive mode
    if (enableInteractive) {
      console.clear();
    }

    await displayPage(page.data, index);
    return page;
  };

  // Fetch and display first page
  const firstPage = await showPage(0, initialCursor);

  // In non-interactive mode, show info if there are more pages
  if (!enableInteractive) {
    if (firstPage.hasMore) {
      logger.info(
        '\nMore results available. Use --interactive (-i) to paginate through results.'
      );
    }
    return;
  }

  // Setup pagination state
  const paginationState: PaginationState = {
    cursor: firstPage.cursor,
    hasMore: firstPage.hasMore,
    hasPrevious: false,
    currentPage: 1,
    totalPages: 1,
    hasMorePagesAvailable: firstPage.hasMore,
  };

  showPaginationState(paginationState);

  const cleanup = setupPaginationListener(paginationState, {
    onNext: async () => {
      const newPageIndex = pageIndex + 1;

      // Check if we already have this page cached
      if (pages[newPageIndex]) {
        pageIndex = newPageIndex;
        const cachedPage = pages[newPageIndex];

        if (enableInteractive) {
          console.clear();
        }

        await displayPage(cachedPage.data, pageIndex);

        paginationState.cursor = cachedPage.cursor;
        paginationState.hasMore = cachedPage.hasMore;
        paginationState.hasPrevious = pageIndex > 0;
        paginationState.currentPage = pageIndex + 1;
        paginationState.totalPages = pages.length;
        // Check if the last page in cache has more data
        paginationState.hasMorePagesAvailable = pages[pages.length - 1].hasMore;
      } else {
        // Fetch new page using cursor from current page
        const currentPage = pages[pageIndex];
        const nextPage = await showPage(
          newPageIndex,
          currentPage.cursor || undefined
        );

        paginationState.cursor = nextPage.cursor;
        paginationState.hasMore = nextPage.hasMore;
        paginationState.hasPrevious = pageIndex > 0;
        paginationState.currentPage = pageIndex + 1;
        paginationState.totalPages = pages.length;
        // Check if the last page in cache has more data
        paginationState.hasMorePagesAvailable = pages[pages.length - 1].hasMore;
      }

      showPaginationState(paginationState);
    },
    onPrevious: async () => {
      // Special case: on first page, reload
      if (pageIndex === 0) {
        pages.length = 0; // Clear cache
        const reloadedPage = await showPage(0, initialCursor);

        paginationState.cursor = reloadedPage.cursor;
        paginationState.hasMore = reloadedPage.hasMore;
        paginationState.hasPrevious = false;
        paginationState.currentPage = 1;
        paginationState.totalPages = 1;
        paginationState.hasMorePagesAvailable = reloadedPage.hasMore;
      } else {
        // Go to previous cached page
        pageIndex--;
        const prevPage = pages[pageIndex];

        if (enableInteractive) {
          console.clear();
        }

        await displayPage(prevPage.data, pageIndex);

        paginationState.cursor = prevPage.cursor;
        paginationState.hasMore = prevPage.hasMore;
        paginationState.hasPrevious = pageIndex > 0;
        paginationState.currentPage = pageIndex + 1;
        paginationState.totalPages = pages.length;
        // Check if the last page in cache has more data
        paginationState.hasMorePagesAvailable = pages[pages.length - 1].hasMore;
      }

      showPaginationState(paginationState);
    },
    onExit: () => {
      cleanup();
      process.exit(0);
    },
  });

  // Keep process alive
  return new Promise(() => {});
}
