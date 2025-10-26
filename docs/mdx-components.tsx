import { Heading } from 'fumadocs-ui/components/heading';
import { icons } from 'lucide-react';
import type { MDXComponents } from 'mdx/types';
import Link from 'next/link';
import { createElement } from 'react';
import * as AccordionComponents from '@/components/ui/accordion';
import * as CalloutComponents from '@/components/ui/callout';
import { CodeBlock } from '@/components/ui/code-block';
import { TypeTable } from '@/components/ui/type-table';
import { TSDoc } from '@/lib/tsdoc';
import { Mermaid } from './components/mermaid';
import { Step, Steps } from './components/steps';
import { Badge } from './components/ui/badge';
import { cn } from './lib/cn';

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  const icon = (components as any)?.icon || false;

  return {
    ...AccordionComponents,
    Badge,
    TypeTable,
    TSDoc,
    CodeBlock,
    Step,
    Steps,
    Mermaid,
    ...CalloutComponents,
    h1: (props) => (
      <Heading as="h1" {...props}>
        {props.children}
        {icon &&
          icon in icons &&
          createElement(icons[icon as keyof typeof icons], {
            className: 'size-6 ml-2 inline-block text-muted-foreground mb-1',
            'aria-label': 'Icon',
          })}
      </Heading>
    ),
    h2: (props) => <Heading as="h2" {...props} />,
    h3: (props) => <Heading as="h3" {...props} />,
    h4: (props) => <Heading as="h4" {...props} />,
    h5: (props) => <Heading as="h5" {...props} />,
    h6: (props) => <Heading as="h6" {...props} />,
    li: ({ ref: _ref, ...props }) => (
      <li {...props} className="prose">
        {' '}
        {props.children}{' '}
      </li>
    ),
    pre: CodeBlock,
    ...components,
    ...(components?.a && {
      a: ({ className, ...props }) => {
        const isExternal = props.href.startsWith('http');

        return (
          <Link
            {...props}
            className={cn(
              'no-underline text-primary-blue font-normal',
              className
            )}
          >
            {props.children}
            {isExternal && (
              <svg
                className="size-3 inline-block align-middle ml-1"
                data-testid="geist-icon"
                height="16"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width="16"
                fill="currentColor"
              >
                <title>External link</title>
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M13.5 10.25V13.25C13.5 13.3881 13.3881 13.5 13.25 13.5H2.75C2.61193 13.5 2.5 13.3881 2.5 13.25L2.5 2.75C2.5 2.61193 2.61193 2.5 2.75 2.5H5.75H6.5V1H5.75H2.75C1.7835 1 1 1.7835 1 2.75V13.25C1 14.2165 1.7835 15 2.75 15H13.25C14.2165 15 15 14.2165 15 13.25V10.25V9.5H13.5V10.25ZM9 1H9.75H14.2495C14.6637 1 14.9995 1.33579 14.9995 1.75V6.25V7H13.4995V6.25V3.56066L8.53033 8.52978L8 9.06011L6.93934 7.99945L7.46967 7.46912L12.4388 2.5H9.75H9V1Z"
                  fill="currentColor"
                ></path>
              </svg>
            )}
          </Link>
        );
      },
    }),
  };
}
