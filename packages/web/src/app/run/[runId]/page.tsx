'use client';

import { useParams } from 'next/navigation';
import { ErrorBoundary } from '@/components/error-boundary';
import { RunDetailView } from '@/components/run-detail-view';
import { useQueryParamConfig } from '@/lib/config';
import {
  useEventIdState,
  useHookIdState,
  useStepIdState,
} from '@/lib/url-state';

export default function RunDetailPage() {
  const params = useParams();
  const config = useQueryParamConfig();
  const [stepId] = useStepIdState();
  const [eventId] = useEventIdState();
  const [hookId] = useHookIdState();

  const runId = params.runId as string;
  const selectedId = stepId || eventId || hookId || undefined;

  return (
    <ErrorBoundary
      title="Run Detail Error"
      description="Failed to load run details. Please try navigating back to the home page."
    >
      <RunDetailView config={config} runId={runId} selectedId={selectedId} />
    </ErrorBoundary>
  );
}
