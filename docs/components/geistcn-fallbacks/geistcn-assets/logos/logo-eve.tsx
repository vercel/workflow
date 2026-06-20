import { cn } from '@/lib/utils';

/**
 * eve wordmark + Beta badge. eve ships a text-based brand mark rather than an
 * SVG wordmark, so this mirrors its docs logo. `height` is accepted for parity
 * with the other product logos but does not drive sizing for this text mark.
 */
export function LogoEve({
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span className="font-semibold text-gray-1000 text-lg leading-none">
        eve
      </span>
      <span className="rounded-full border border-blue-300 px-2 py-0.5 font-medium text-blue-700 text-xs leading-none">
        Beta
      </span>
    </span>
  );
}
