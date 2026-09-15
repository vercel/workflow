import { cn } from '../../lib/cn';

function Skeleton({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn('rounded-md bg-gray-200', className)}
      style={style}
    />
  );
}

export { Skeleton };
