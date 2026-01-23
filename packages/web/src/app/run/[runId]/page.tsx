'use client';

import { ErrorBoundary } from '@workflow/web-shared';
import { useParams } from 'next/navigation';
import { RunDetailView } from '@/components/run-detail-view';
import {
  useEventIdState,
  useHookIdState,
  useStepIdState,
} from '@/lib/url-state';

export default function RunDetailPage() {
  const params = useParams();
  const [stepId] = useStepIdState();
  const [eventId] = useEventIdState();
  const [hookId] = useHookIdState();

  const runId = params.runId as string;
  const selectedId = stepId || eventId || hookId || undefined;

  return (
    <ErrorBoundary title="Failed to load run details">
      <RunDetailView runId={runId} selectedId={selectedId} />
    </ErrorBoundary>
  );
}
