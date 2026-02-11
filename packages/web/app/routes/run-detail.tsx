import { ErrorBoundary as ErrorBoundaryComponent } from '@workflow/web-shared';
import { useParams, useSearchParams } from 'react-router';
import { RunDetailView } from '~/components/run-detail-view';

export default function RunDetailPage() {
  const params = useParams();
  const [searchParams] = useSearchParams();

  const runId = params.runId as string;
  const stepId = searchParams.get('stepId');
  const eventId = searchParams.get('eventId');
  const hookId = searchParams.get('hookId');

  const selectedId = stepId || eventId || hookId || undefined;

  return (
    <ErrorBoundaryComponent title="Failed to load run details">
      <RunDetailView runId={runId} selectedId={selectedId} />
    </ErrorBoundaryComponent>
  );
}
