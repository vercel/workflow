'use client';

import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { StreamDetailView } from '@/components/stream-detail-view';
import { useQueryParamConfig, worldConfigToEnvMap } from '@/lib/config';

export default function StreamDetailPage() {
  const params = useParams();

  const config = useQueryParamConfig();
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);
  const streamId = params.streamId as string;

  return (
    <ErrorBoundary
      title="Stream Error"
      description="Failed to load stream data. Please try navigating back and selecting the stream again."
    >
      <StreamDetailView env={env} streamId={streamId} />
    </ErrorBoundary>
  );
}
