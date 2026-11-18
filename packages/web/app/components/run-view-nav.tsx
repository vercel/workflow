import { cn } from '@workflow/web-shared';
import { BarChart3, List } from 'lucide-react';
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
}: {
  runId: string;
  current?: boolean;
}) {
  return (
    <Link
      to={runUsagePath(runId)}
      className={cn(tabsTriggerClassName, 'gap-2')}
      aria-current={current ? 'page' : undefined}
      data-testid="run-usage-nav-link"
    >
      <BarChart3 className="h-4 w-4" aria-hidden="true" />
      Usage
    </Link>
  );
}

/**
 * The pill the row's items sit in, tabs and links alike. Below `sm` the
 * icons go, so four items fit a phone's width without scrolling.
 */
export const RUN_VIEW_ROW_CLASS = cn(
  tabsListClassName,
  'mb-4 max-w-full flex-none max-sm:[&_svg]:hidden'
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
}: {
  runId: string;
  /** Hidden where the World does not count usage, like the header fields. */
  showUsage: boolean;
}) {
  return (
    <nav aria-label="Run views" className={RUN_VIEW_ROW_CLASS}>
      {RUN_TABS.map((tab) => (
        <Link
          key={tab.value}
          to={runTabPath(runId, tab.value)}
          className={cn(tabsTriggerClassName, 'gap-2')}
        >
          <List className="h-4 w-4" aria-hidden="true" />
          {tab.label}
        </Link>
      ))}
      {showUsage && <UsageNavLink runId={runId} current />}
    </nav>
  );
}
