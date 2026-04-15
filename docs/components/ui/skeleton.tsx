import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('relative overflow-hidden rounded-md bg-[var(--ds-gray-100)]', className)}
      {...props}
    >
      <div className="absolute inset-0 -right-[200%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite_reverse] bg-[linear-gradient(90deg,var(--ds-gray-100),var(--ds-gray-200),var(--ds-gray-100))] bg-[length:50%_100%]" />
    </div>
  );
}

export { Skeleton };
