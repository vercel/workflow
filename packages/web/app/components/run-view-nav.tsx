import { Button } from '@workflow/web-shared';
import { Link } from 'react-router';
import { runUsagePath } from './run-usage';

/**
 * Where focus goes after moving between the run page and its Usage page:
 * the Usage page's content, or the run page's selected tab.
 */
export type RunView = 'usage' | 'tabs';

const RUN_VIEW_FOCUS_TARGET: Record<RunView, string> = {
  usage: '[data-run-view="usage"]',
  tabs: '[role="tab"][data-state="active"]',
};

/**
 * Focuses the view that a navigation landed on. The link that was followed
 * is gone once the other page renders (the Usage link is not shown on its
 * own page, and the run breadcrumb turns into text), so focus would
 * otherwise drop to the document. Returns whether it found the target, so
 * a caller can try again on the next render.
 */
export function focusRunView(root: ParentNode | null, view: RunView): boolean {
  const target = root?.querySelector(RUN_VIEW_FOCUS_TARGET[view]);
  if (!(target instanceof HTMLElement)) return false;
  target.focus();
  return true;
}

/**
 * The run header's link to the run's Usage page, beside the run's actions.
 * Usage is a page of its own, not one of the run's tabs.
 */
export function ViewUsageLink({
  runId,
  onNavigate,
}: {
  runId: string;
  /** Called when the link is followed, to move focus once the page renders. */
  onNavigate?: () => void;
}) {
  return (
    <Button asChild variant="secondary" size="small">
      <Link
        to={runUsagePath(runId)}
        data-testid="run-view-usage-link"
        onClick={onNavigate}
      >
        View Usage
      </Link>
    </Button>
  );
}
