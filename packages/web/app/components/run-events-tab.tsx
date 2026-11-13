import { EventListView } from '@workflow/web-shared';
import type { ComponentProps } from 'react';
import { useEventsListData } from '~/lib/client/hooks/use-events-list-data';
import type { EnvMap } from '~/lib/types';

interface RunEventsTabProps
  extends Pick<
    ComponentProps<typeof EventListView>,
    | 'run'
    | 'onLoadEventData'
    | 'encryptionKey'
    | 'onSortOrderChange'
    | 'onDecrypt'
    | 'isDecrypting'
    | 'hasEncryptedData'
  > {
  env: EnvMap;
  runId: string;
  sortOrder: 'asc' | 'desc';
}

/**
 * The run page's Events tab. Rendered inside the tab's content, so it fetches
 * only while the tab is selected.
 */
export function RunEventsTab({
  env,
  runId,
  sortOrder,
  encryptionKey,
  ...listProps
}: RunEventsTabProps) {
  const { events, loading, hasMore, loadingMore, loadMore, searchByExactId } =
    useEventsListData(env, runId, { sortOrder, encryptionKey });

  return (
    <EventListView
      {...listProps}
      events={events}
      isLoading={loading}
      hasMoreEvents={hasMore}
      isLoadingMoreEvents={loadingMore}
      onLoadMoreEvents={loadMore}
      encryptionKey={encryptionKey}
      sortOrder={sortOrder}
      onExactIdSearch={searchByExactId}
    />
  );
}
