import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface DocsLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * A styled link component for documentation links.
 * Automatically prepends the docs base URL if a relative path is provided.
 */
const DocsLink = React.forwardRef<HTMLAnchorElement, DocsLinkProps>(
  ({ className, href, children, ...props }, ref) => {
    // Convert relative paths to full docs URLs
    const fullHref = href.startsWith('http')
      ? href
      : `https://useworkflow.dev/docs/${href.replace(/^\//, '')}`;

    return (
      <Link
        href={fullHref}
        className={cn(
          'font-medium underline underline-offset-4 transition-colors',
          className
        )}
        style={{
          color: 'var(--ds-blue-600)',
        }}
        target="_blank"
        rel="noopener noreferrer"
        ref={ref}
        {...props}
      >
        {children}
      </Link>
    );
  }
);
DocsLink.displayName = 'DocsLink';

export { DocsLink };
