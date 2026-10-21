import {
  getRunLimitGuidance,
  type RunLimitGuidanceInput,
} from '@workflow/web-shared';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';

/**
 * Banner for runs that failed with MAX_EVENTS_EXCEEDED or REPLAY_TIMEOUT
 * and weren't already on the QuickJS VM with snapshotting. Renders nothing
 * otherwise. The decision and copy live in `@workflow/web-shared` so the
 * Vercel dashboard shows the same guidance.
 */
export function RunLimitGuidanceAlert({
  run,
}: {
  run: RunLimitGuidanceInput | null | undefined;
}) {
  const guidance = getRunLimitGuidance(run);
  if (!guidance) return null;

  return (
    <Alert variant="warning" data-testid="run-limit-guidance">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{guidance.title}</AlertTitle>
      <AlertDescription>
        <p>{guidance.description}</p>
        <p className="mt-2">
          Set{' '}
          <code className="rounded bg-[var(--ds-amber-200)] px-1 py-0.5 font-mono text-xs">
            {guidance.envVar}
          </code>{' '}
          and start the workflow again.{' '}
          <a
            href={guidance.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-4"
          >
            Learn more
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
