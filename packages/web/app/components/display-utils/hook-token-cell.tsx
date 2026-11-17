import { TextWithCopyButton } from '@workflow/web-shared';
import type { EnvMap } from '~/lib/types';
import { fetchHookToken } from '~/lib/workflow-api-client';

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
    <TextWithCopyButton
      text={() => fetchHookToken(env, runId, hookId)}
      label="Copy token"
      overlay
    >
      <span className="text-muted-foreground">••••••••••••</span>
    </TextWithCopyButton>
  );
}
