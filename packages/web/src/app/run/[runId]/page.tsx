'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { ErrorBoundary } from '@/components/error-boundary';
import { RunDetailView } from '@/components/run-detail-view';
import { useQueryParamConfig } from '@/lib/config';

export default function RunDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const config = useQueryParamConfig();

  const runId = params.runId as string;
  const stepId = searchParams.get('stepId') || searchParams.get('step');
  const eventId = searchParams.get('eventId') || searchParams.get('event');
  const hookId = searchParams.get('hookId') || searchParams.get('hook');
  const selectedId = stepId
    ? stepId
    : eventId
      ? eventId
      : hookId
        ? hookId
        : undefined;

  return (
    <ErrorBoundary
      title="Run Detail Error"
      description="Failed to load run details. Please try navigating back to the home page."
    >
      <RunDetailView config={config} runId={runId} selectedId={selectedId} />
    </ErrorBoundary>
  );
}
