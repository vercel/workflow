import { Badge } from '@/components/ui/badge';
import { patternTypeLabels } from '@/lib/patterns/manifest';
import type { RegistryPatternType } from '@/lib/patterns/types';
import { cn } from '@/lib/utils';

const typeStyles: Record<RegistryPatternType, string> = {
  // Components are the headline tier — call them out in blue.
  component: 'bg-blue-300 text-blue-700 border-transparent',
  template: 'bg-secondary text-secondary-foreground border-transparent',
  example: 'text-muted-foreground',
};

const typeTitles: Record<RegistryPatternType, string> = {
  component: 'Drop-in code — import it and call it, domain-free',
  template: 'Working skeleton — replace the function bodies with your logic',
  example: 'Educational — read the approach, then adapt it',
};

/**
 * Tier badge — component / template / example. Rendered on the listing card
 * and the detail hero next to the version badges.
 */
export function PatternTypeBadge({ type }: { type: RegistryPatternType }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-xs font-normal py-0.5 px-2', typeStyles[type])}
      title={typeTitles[type]}
    >
      {patternTypeLabels[type]}
    </Badge>
  );
}
