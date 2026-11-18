import { useOutletContext } from 'react-router';
import { RunUsagePage } from '~/components/run-usage';
import type { RunUsageState } from '~/lib/client/hooks/use-run-usage';
import { DEFAULT_META_DESCRIPTION, DEFAULT_TITLE } from '~/lib/meta';

/**
 * What the run page (the layout route) hands the Usage page: the usage it
 * already reads for the header, so the page adds no read of its own.
 */
export interface RunUsageOutletContext {
  runId: string;
  usage: RunUsageState;
  /** Pricing is linked only on the Vercel backend. */
  isVercelBackend: boolean;
}

export function meta({ params }: { params: { runId?: string } }) {
  return [
    { title: `Usage · ${params.runId ?? 'Run'} · ${DEFAULT_TITLE}` },
    { name: 'description', content: DEFAULT_META_DESCRIPTION },
  ];
}

export default function RunUsageRoute() {
  const { runId, usage, isVercelBackend } =
    useOutletContext<RunUsageOutletContext>();
  return (
    <RunUsagePage
      runId={runId}
      usage={usage.usage}
      error={usage.error}
      onRetry={usage.refresh}
      retrying={usage.loading}
      isVercelBackend={isVercelBackend}
    />
  );
}
