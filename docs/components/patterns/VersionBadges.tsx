import { Badge } from '@/components/ui/badge';
import type { WorkflowVersion } from '@/lib/patterns/types';

interface VersionBadgesProps {
  versions: WorkflowVersion[];
}

/**
 * Compatibility badges showing which Workflow SDK majors a pattern works
 * with. Rendered on the listing card and the detail hero so readers can tell
 * at a glance whether a pattern relies on version-specific features.
 */
export function VersionBadges({ versions }: VersionBadgesProps) {
  return (
    <>
      {versions.map((version) => (
        <Badge
          key={version}
          variant="secondary"
          className="text-xs font-mono font-normal py-0.5 px-2"
          title={`Works with Workflow SDK ${version}`}
        >
          {version}
        </Badge>
      ))}
    </>
  );
}
