import { ErrorBoundary as ErrorBoundaryComponent } from '@workflow/web-shared';
import { redirect, useParams, useSearchParams } from 'react-router';
import { RunDetailView } from '~/components/run-detail-view';
import type { Route } from './+types/run-detail';

/**
 * Action handler for POST requests to /run/:runId.
 *
 * This route doesn't use form-based mutations (mutations go through
 * the /api/rpc resource route instead), but React Router requires an
 * action export if POST requests can reach this route. Redirect back
 * to the same URL as a GET.
 */
export async function action({ params }: Route.ActionArgs) {
  return redirect(`/run/${params.runId}`);
}

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
