import type { StepStatus, WorkflowRunStatus } from '@workflow/world';

/**
 * The semantic status layer for the observability UI. Every surface that
 * colours a run, step, hook, wait, attempt or stream by its status reads it
 * from here, so a status looks the same in the runs table, the trace
 * timeline, the event details and the dashboard that embeds these components.
 *
 * The palette follows the Vercel dashboard (`vercel/front`):
 * - in progress is amber, as Geist's `StatusDot` shows a building deployment
 *   and the dashboard's workflow runs table shows a running run;
 * - a persistent success (a completed run) is `teal-600`, and a positive
 *   action outcome (a decrypted payload) is blue, per the product-design
 *   interface-quality guidance; generic green is not used;
 * - failure is red, and anything idle, queued or cancelled is gray.
 *
 * Dots use themed Geist scale steps, so they adapt to dark mode, unlike the
 * fixed `geist-cyan` and `geist-warning` migration colours.
 */
export type StatusTone =
  | 'neutral'
  | 'progress'
  | 'success'
  | 'positive'
  | 'error';

export interface StatusToneStyle {
  /** Geist colour scale, for CSS that reads `var(--ds-<hue>-<step>)`. */
  hue: 'gray' | 'amber' | 'teal' | 'blue' | 'red';
  /** Solid fill for a status dot or a solid bar segment. */
  dot: string;
  /** Status text on a neutral surface (the `-800` step, see AGENTS.md). */
  text: string;
  /** Variant for a Geist `Badge` that shows this status. */
  badgeVariant:
    | 'gray-subtle'
    | 'amber-subtle'
    | 'teal-subtle'
    | 'blue-subtle'
    | 'red-subtle';
}

export const STATUS_TONES: Record<StatusTone, StatusToneStyle> = {
  neutral: {
    hue: 'gray',
    dot: 'bg-gray-700',
    text: 'text-gray-900',
    badgeVariant: 'gray-subtle',
  },
  progress: {
    hue: 'amber',
    dot: 'bg-amber-700',
    text: 'text-amber-800',
    badgeVariant: 'amber-subtle',
  },
  success: {
    hue: 'teal',
    dot: 'bg-teal-600',
    text: 'text-teal-800',
    badgeVariant: 'teal-subtle',
  },
  positive: {
    hue: 'blue',
    dot: 'bg-blue-700',
    text: 'text-blue-800',
    badgeVariant: 'blue-subtle',
  },
  error: {
    hue: 'red',
    dot: 'bg-red-700',
    text: 'text-red-800',
    badgeVariant: 'red-subtle',
  },
};

/**
 * Every status the UI colours: run and step statuses, the timeline's segment
 * states for steps, hooks and waits, and a stream's live state.
 */
export type Status =
  | WorkflowRunStatus
  | StepStatus
  | 'queued'
  | 'retrying'
  | 'succeeded'
  | 'waiting'
  | 'sleeping'
  | 'live';

export interface StatusStyle extends StatusToneStyle {
  label: string;
  tone: StatusTone;
  /**
   * Subtle fill and border colour for a timeline bar. Add the `border`
   * width yourself.
   */
  bar: string;
}

function status(label: string, tone: StatusTone, bar: string): StatusStyle {
  return { label, tone, bar, ...STATUS_TONES[tone] };
}

export const STATUS: Record<Status, StatusStyle> = {
  pending: status('Pending', 'neutral', 'bg-gray-200 border-gray-500'),
  queued: status('Queued', 'neutral', 'bg-gray-400 border-gray-500'),
  waiting: status('Waiting', 'neutral', 'bg-gray-200 border-gray-500'),
  sleeping: status('Sleeping', 'neutral', 'bg-gray-400 border-gray-500'),
  cancelled: status('Cancelled', 'neutral', 'bg-gray-500 border-gray-700'),
  running: status('Running', 'progress', 'bg-amber-200 border-amber-500'),
  retrying: status('Retrying', 'progress', 'bg-amber-100 border-amber-500'),
  completed: status('Completed', 'success', 'bg-teal-200 border-teal-500'),
  succeeded: status('Succeeded', 'success', 'bg-teal-200 border-teal-500'),
  live: status('Live', 'success', 'bg-teal-200 border-teal-500'),
  failed: status('Failed', 'error', 'bg-red-200 border-red-500'),
};
