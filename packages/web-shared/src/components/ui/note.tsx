import { cva, type VariantProps } from 'class-variance-authority';
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Port of geistcn's `Note` (`packages/geistcn/src/components/note` in
 * `vercel/front`): the same variants, fill and size scale, built on Geist
 * colour tokens so it renders the same in the dashboard and in `@workflow/web`.
 *
 * The radius is literal rather than `rounded-md`: apps that still carry a
 * shadcn theme redefine the `--radius-*` scale (see `button.tsx`).
 */
const noteVariants = cva(
  [
    'relative box-border flex w-full flex-wrap items-center gap-3 break-words rounded-[6px] border',
    '[&_a]:font-medium [&_a]:underline-offset-2 [&_a:hover]:underline',
  ],
  {
    variants: {
      variant: {
        default: 'border-gray-400 text-gray-900 [&_a]:text-blue-700',
        secondary:
          'border-gray-alpha-400 text-gray-alpha-900 [&_a]:text-gray-1000',
        success: 'border-blue-400 text-blue-900 [&_a]:text-blue-1000',
        error: 'border-red-400 text-red-900 [&_a]:text-red-1000',
        warning: 'border-amber-400 text-amber-900 [&_a]:text-amber-1000',
        violet: 'border-purple-400 text-purple-900 [&_a]:text-purple-1000',
        cyan: 'border-teal-400 text-teal-900 [&_a]:text-teal-1000',
      },
      fill: {
        true: null,
        false: null,
      },
      size: {
        small: 'min-h-[var(--ds-size-small)] px-2 py-1.5 text-copy-13',
        medium: 'min-h-[var(--ds-size-medium)] px-3 py-1.5 text-copy-14',
      },
    },
    compoundVariants: [
      {
        variant: 'default',
        fill: true,
        className: 'border-gray-100 bg-gray-100',
      },
      {
        variant: 'secondary',
        fill: true,
        className: 'border-transparent bg-gray-alpha-200',
      },
      {
        variant: 'success',
        fill: true,
        className: 'border-blue-100 bg-blue-200',
      },
      { variant: 'error', fill: true, className: 'border-red-100 bg-red-200' },
      {
        variant: 'warning',
        fill: true,
        className: 'border-amber-100 bg-amber-200',
      },
      {
        variant: 'violet',
        fill: true,
        className: 'border-purple-100 bg-purple-200',
      },
      {
        variant: 'cyan',
        fill: true,
        className: 'border-teal-100 bg-teal-200',
      },
    ],
    defaultVariants: {
      variant: 'default',
      fill: false,
      size: 'medium',
    },
  }
);

type NoteVariant = NonNullable<VariantProps<typeof noteVariants>['variant']>;

/** The icon a variant shows when no `icon` prop is passed (as in Geist). */
function defaultVariantIcon(variant: NoteVariant): React.ReactNode {
  switch (variant) {
    case 'success':
      return <CircleCheck size={14} aria-hidden />;
    case 'error':
      return <OctagonAlert size={14} aria-hidden />;
    case 'warning':
      return <TriangleAlert size={14} aria-hidden />;
    default:
      return <Info size={14} aria-hidden />;
  }
}

export interface NoteProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof noteVariants> {
  /**
   * Leading icon. Omit for the variant's default icon; pass `null` for none.
   * It inherits the note's colour and stays pinned to the first line.
   */
  icon?: React.ReactNode;
}

/**
 * Persistent inline message (Geist `Note`). Compose the body from
 * {@link NoteContent}, an optional {@link NoteLabel} and {@link NoteAction}:
 *
 * ```tsx
 * <Note variant="error" fill>
 *   <NoteContent>
 *     <NoteLabel>Failed:</NoteLabel> Something went wrong.
 *   </NoteContent>
 *   <NoteAction>
 *     <Button size="small">Retry</Button>
 *   </NoteAction>
 * </Note>
 * ```
 */
export function Note({
  children,
  className,
  variant,
  fill,
  size,
  icon,
  ...props
}: NoteProps) {
  const resolvedIcon =
    icon === undefined ? defaultVariantIcon(variant ?? 'default') : icon;

  // The icon and content form one top-aligned group, which the note centres
  // against the action, so the action children live outside that group.
  const body: React.ReactNode[] = [];
  const actions: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === NoteAction) {
      actions.push(child);
    } else {
      body.push(child);
    }
  });

  return (
    <div
      className={cn(
        noteVariants({ variant, fill, size }),
        actions.length > 0 && 'pr-1.5',
        className
      )}
      data-slot="note"
      role="note"
      {...props}
    >
      <div
        className="flex min-w-0 flex-1 items-start gap-3"
        data-slot="note-body"
      >
        {resolvedIcon ? (
          <span className="flex shrink-0 [&>svg]:h-[1lh]" data-slot="note-icon">
            {resolvedIcon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2">{body}</div>
      </div>
      {actions}
    </div>
  );
}

/** Bold inline label at the start of a {@link NoteContent}. */
export function NoteLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('mr-1 whitespace-nowrap font-semibold', className)}
      data-slot="note-label"
      {...props}
    />
  );
}

/** Text content of a {@link Note}. */
export function NoteContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('min-w-0 flex-1', className)}
      data-slot="note-content"
      {...props}
    />
  );
}

/** Action slot of a {@link Note}, centred against the icon and content. */
export function NoteAction({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 self-center',
        className
      )}
      data-slot="note-action"
      {...props}
    />
  );
}
