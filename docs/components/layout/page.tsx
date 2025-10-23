'use client';
import { useBreadcrumb } from 'fumadocs-core/breadcrumb';
import { Link } from 'fumadocs-core/framework';
import type {
  PageTree,
  TableOfContents,
  TOCItemType,
} from 'fumadocs-core/server';
import { AnchorProvider, useActiveAnchors } from 'fumadocs-core/toc';
import { useTreeContext } from 'fumadocs-ui/contexts/tree';
import { usePathname } from 'next/navigation';
import { type ComponentProps, Fragment, type ReactNode, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { LLMCopyButton, ViewOptions } from '../page-actions';

export interface DocsPageProps {
  toc?: TableOfContents;

  children: ReactNode;
}

function findPageFile(tree: PageTree.Root, targetUrl: string): string | null {
  function search(nodes: PageTree.Node[]): string | null {
    for (const node of nodes) {
      if (node.type === 'page' && node.url === targetUrl) {
        return (node as any).$ref?.file || null;
      }

      if (node.type === 'folder') {
        // Check if the folder's index page matches
        if (node.index && node.index.url === targetUrl) {
          return (node.index as any).$ref?.file || null;
        }

        // Recursively search children
        const result = search(node.children);
        if (result) return result;
      }
    }
    return null;
  }

  return search(tree.children);
}

export function DocsPage({ toc = [], ...props }: DocsPageProps) {
  const { root } = useTreeContext();
  const pathname = usePathname();
  const breadcrumbItems = useBreadcrumb(pathname, root, { includePage: true });

  const githubFilePath = useMemo(() => {
    const file = findPageFile(root, pathname);
    return file || `${pathname.replace('/docs/', '')}.mdx`;
  }, [root, pathname]);

  const markdownUrl = `/llms.mdx${pathname.replace('/docs', '')}`;

  return (
    <AnchorProvider toc={toc}>
      <main className="flex w-full min-w-0 flex-col pt-[var(--fd-nav-height)]">
        <div className="flex flex-col items-start gap-3 pr-4 md:flex-row md:items-center md:justify-between md:gap-0">
          <div className="w-full max-w-[860px] px-4 md:mx-auto md:px-6">
            <div className="flex items-center gap-1 text-muted-foreground text-sm shrink-0">
              {breadcrumbItems.map((item, i) => (
                <Fragment key={i}>
                  {i !== 0 && (
                    <svg
                      className="opacity-50"
                      fill="none"
                      height="16"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      width="16"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  )}
                  {item.url ? (
                    <Link
                      className="transition-colors hover:text-foreground"
                      href={item.url}
                    >
                      {item.name}
                    </Link>
                  ) : (
                    <span className="text-foreground">{item.name}</span>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 gap-1 ps-2 md:ps-0">
            <LLMCopyButton markdownUrl={markdownUrl} />
            <ViewOptions
              markdownUrl={markdownUrl}
              githubUrl={`https://github.com/vercel/workflow/blob/main/docs/content/docs/${githubFilePath}`}
            />
          </div>
        </div>
        <article className="flex w-full max-w-[860px] flex-1 flex-col gap-6 px-4 pt-4 pb-8 md:mx-auto md:px-6">
          {props.children}
          <Footer />
        </article>
      </main>
      <div
        className={cn(
          'sticky top-(--fd-nav-height) h-[calc(100dvh-var(--fd-nav-height))] w-[286px] shrink-0 overflow-auto px-4 pt-14 max-xl:hidden',
          toc.length === 0 && 'invisible'
        )}
      >
        {toc.length > 0 && (
          <>
            <p className="mb-2 text-fd-foreground text-sm">On this page</p>
            <div className="flex flex-col">
              {toc.map((item) => (
                <TocItem item={item} key={item.url} />
              ))}
            </div>
          </>
        )}
      </div>
    </AnchorProvider>
  );
}

export function DocsBody(props: ComponentProps<'div'>) {
  return (
    <div {...props} className={cn('prose', props.className)}>
      {props.children}
    </div>
  );
}

export function DocsDescription(props: ComponentProps<'p'>) {
  // don't render if no description provided
  if (props.children === undefined) return null;

  return (
    <p
      {...props}
      className={cn('mb-8 text-fd-muted-foreground text-lg', props.className)}
    >
      {props.children}
    </p>
  );
}

export function DocsTitle(props: ComponentProps<'h1'>) {
  return (
    <h1 {...props} className={cn('font-semibold text-3xl', props.className)}>
      {props.children}
    </h1>
  );
}

function TocItem({ item }: { item: TOCItemType }) {
  const isActive = useActiveAnchors().includes(item.url.slice(1));

  return (
    <a
      className={cn(
        'py-1 text-muted-foreground text-sm transition-colors ease-out hover:text-foreground',
        isActive && 'text-primary-blue opacity-100'
      )}
      href={item.url}
      style={{
        paddingLeft: Math.max(0, item.depth - 2) * 16,
      }}
    >
      {item.title}
    </a>
  );
}

function Footer() {
  const { root } = useTreeContext();
  const pathname = usePathname();
  const flatten = useMemo(() => {
    const result: PageTree.Item[] = [];

    function scan(items: PageTree.Node[]) {
      for (const item of items) {
        if (item.type === 'page') result.push(item);
        else if (item.type === 'folder') {
          if (item.index) result.push(item.index);
          scan(item.children);
        }
      }
    }

    scan(root.children);
    return result;
  }, [root]);

  const { previous, next } = useMemo(() => {
    const idx = flatten.findIndex((item) => item.url === pathname);

    if (idx === -1) return {};
    return {
      previous: flatten[idx - 1],
      next: flatten[idx + 1],
    };
  }, [flatten, pathname]);

  return (
    <div className="mt-16 flex flex-row justify-between gap-8 border-border/40 border-t pt-8">
      {previous ? (
        <Link
          className="group flex items-start gap-1 text-muted-foreground transition-colors hover:text-foreground"
          href={previous.url}
        >
          <svg
            className="mt-[24px]"
            height="12"
            strokeLinejoin="round"
            style={{ color: 'currentcolor' }}
            viewBox="0 0 16 16"
            width="12"
          >
            <path
              clipRule="evenodd"
              d="M10.5 14.0607L9.96967 13.5303L5.14645 8.70712C4.75592 8.31659 4.75592 7.68343 5.14645 7.2929L9.96967 2.46968L10.5 1.93935L11.5607 3.00001L11.0303 3.53034L6.56066 8.00001L11.0303 12.4697L11.5607 13L10.5 14.0607Z"
              fill="currentColor"
              fillRule="evenodd"
            />
          </svg>
          <div className="flex flex-col">
            <span className="text-xs">Previous</span>
            <span>{previous.name}</span>
          </div>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          className="group flex items-start gap-1 text-muted-foreground transition-colors hover:text-foreground"
          href={next.url}
        >
          <div className="flex flex-col items-end">
            <span className="text-xs">Next</span>
            <span>{next.name}</span>
          </div>
          <svg
            className="mt-[24px]"
            height="12"
            strokeLinejoin="round"
            style={{ color: 'currentcolor' }}
            viewBox="0 0 16 16"
            width="12"
          >
            <path
              clipRule="evenodd"
              d="M5.50001 1.93933L6.03034 2.46966L10.8536 7.29288C11.2441 7.68341 11.2441 8.31657 10.8536 8.7071L6.03034 13.5303L5.50001 14.0607L4.43935 13L4.96968 12.4697L9.43935 7.99999L4.96968 3.53032L4.43935 2.99999L5.50001 1.93933Z"
              fill="currentColor"
              fillRule="evenodd"
            />
          </svg>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
