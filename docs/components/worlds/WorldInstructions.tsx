import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { World } from './types';

interface WorldInstructionsProps {
  id: string;
  world: World;
}

/**
 * Installation & Usage section for community worlds.
 * Official worlds use MDX content directly instead of this component.
 */
export function WorldInstructions({ id, world }: WorldInstructionsProps) {
  const isExternalDocs = world.docs.startsWith('http');

  return (
    <section className="py-8 sm:py-12 border-t" id="installation">
      <div className="space-y-6">
        <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
          Installation & Usage
        </h2>
        <p className="text-muted-foreground">
          This is a community-maintained World implementation. For installation
          instructions and usage documentation, please refer to the project's
          README on GitHub.
        </p>
        <div className="flex gap-3 flex-wrap">
          {world.repository && (
            <Button asChild>
              <a
                href={world.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2"
              >
                View on GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
          {isExternalDocs && world.docs !== world.repository && (
            <Button asChild variant="outline">
              <a
                href={world.docs}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2"
              >
                Documentation
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
