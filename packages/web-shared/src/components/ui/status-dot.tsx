import { cn } from '../../lib/cn';
import { STATUS, type Status } from '../../lib/status';

/**
 * A status dot with Geist `StatusDot` geometry, coloured from the shared
 * status map. It is decorative: always show the status label next to it.
 */
export function StatusDot({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        STATUS[status].dot,
        className
      )}
    />
  );
}
