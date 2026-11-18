import { Button } from '@workflow/web-shared';
import { ArrowUpRight } from 'lucide-react';

export function DocsLink() {
  return (
    <Button asChild variant="secondary" size="small" suffix={<ArrowUpRight />}>
      <a
        href="https://workflow-sdk.dev/docs/observability"
        target="_blank"
        rel="noopener noreferrer"
      >
        Docs
      </a>
    </Button>
  );
}
