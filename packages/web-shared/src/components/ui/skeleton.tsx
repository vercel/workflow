import { cn } from '../../lib/utils';

function Skeleton({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn('rounded-md', className)}
      style={{ backgroundColor: 'var(--ds-gray-200)', ...style }}
    />
  );
}

export { Skeleton };
