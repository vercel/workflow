import { cn } from '@workflow/web-shared';
import { Link } from 'react-router';
import { runPath, runUsagePath } from './run-usage';
import { tabsListClassName, tabsTriggerClassName } from './ui/tabs';

/** The run page's in-page tabs, in the row's order. */
export const RUN_TABS = [
  { value: 'trace', label: 'Trace' },
  { value: 'events', label: 'Events' },
  { value: 'streams', label: 'Streams' },
] as const;

export type RunTab = (typeof RUN_TABS)[number]['value'];

/** An item of the row: a tab, or the Usage page. */
export type RunViewItem = RunTab | 'usage';

/**
 * Focuses the row's active item: after switching between the run page and
 * the Usage page, the row is a new element, and focus would otherwise drop
 * to the document. Only the item in its active state counts (the current
 * page's link, or the selected tab): while the navigation is pending, the
 * old row's inactive item of the same name is still in the document.
 * Returns whether it found the item.
 */
export function focusRunViewItem(
  root: ParentNode | null,
  item: RunViewItem
): boolean {
  const target = root?.querySelector(
    `[data-run-view-item="${item}"]:is([aria-current="page"], [data-state="active"])`
  );
  if (!(target instanceof HTMLElement)) return false;
  target.focus();
  return true;
}

/** A run tab's URL, for links from outside the run page. */
export function runTabPath(runId: string, tab: RunTab): string {
  return `${runPath(runId)}?tab=${tab}`;
}

/**
 * The row's Usage item: a link to the run's Usage page, styled like the
 * tabs beside it. It is navigation to another route, not a tab, so it sits
 * next to the tablist rather than inside it.
 */
export function UsageNavLink({
  runId,
  current = false,
  onNavigate,
}: {
  runId: string;
  current?: boolean;
  /** Called when the link is followed, to move focus once the page renders. */
  onNavigate?: (item: RunViewItem) => void;
}) {
  return (
    <Link
      to={runUsagePath(runId)}
      className={tabsTriggerClassName}
      aria-current={current ? 'page' : undefined}
      data-testid="run-usage-nav-link"
      data-run-view-item="usage"
      onClick={() => onNavigate?.('usage')}
    >
      Usage
    </Link>
  );
}

/** The pill the row's items sit in, tabs and links alike. */
export const RUN_VIEW_ROW_CLASS = cn(
  tabsListClassName,
  'mb-4 max-w-full flex-none'
);

/**
 * The tab row on the Usage page. There are no in-page panels here, so every
 * item is a link: Trace, Events and Streams go back to the run page on that
 * tab (explicit paths, since this page is a child route), and Usage is the
 * current page.
 */
export function RunViewNav({
  runId,
  showUsage,
  onNavigate,
}: {
  runId: string;
  /** Hidden where the World does not count usage, like the header fields. */
  showUsage: boolean;
  /** Called when an item is followed, to move focus once the page renders. */
  onNavigate?: (item: RunViewItem) => void;
}) {
  return (
    <nav aria-label="Run views" className={RUN_VIEW_ROW_CLASS}>
      {RUN_TABS.map((tab) => (
        <Link
          key={tab.value}
          to={runTabPath(runId, tab.value)}
          className={tabsTriggerClassName}
          data-run-view-item={tab.value}
          onClick={() => onNavigate?.(tab.value)}
        >
          {tab.label}
        </Link>
      ))}
      {showUsage && (
        <UsageNavLink runId={runId} current onNavigate={onNavigate} />
      )}
    </nav>
  );
}
