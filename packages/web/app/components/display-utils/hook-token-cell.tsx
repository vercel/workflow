import type { EnvMap } from '~/lib/types';
import { fetchHookToken } from '~/lib/workflow-api-client';
import { CopyableText } from './copyable-text';

interface HookTokenCellProps {
  env: EnvMap;
  runId: string;
  hookId: string;
}

/**
 * Renders a hook's secret token as a masked, copy-on-demand cell.
 *
 * The token is not present in hook list rows — it is fetched one hook at a
 * time (via `fetchHookToken`) only when the user clicks to copy it. This keeps
 * the secret out of bulk list responses while preserving the copy affordance.
 */
export function HookTokenCell({ env, runId, hookId }: HookTokenCellProps) {
  return (
    <CopyableText
      text={() => fetchHookToken(env, runId, hookId)}
      label="Copy token"
      overlay
    >
      <span className="text-muted-foreground">••••••••••••</span>
    </CopyableText>
  );
}
