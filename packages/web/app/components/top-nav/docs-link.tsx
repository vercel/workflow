import { Button } from '@workflow/web-shared';
import { ArrowUpRight } from 'lucide-react';

export function DocsLink() {
  return (
    <Button asChild variant="secondary" size="small">
      <a
        href="https://workflow-sdk.dev/docs/observability"
        target="_blank"
        rel="noopener noreferrer"
        className="gap-1"
      >
        <span>Docs</span>
        <ArrowUpRight className="h-4 w-4" />
      </a>
    </Button>
  );
}
