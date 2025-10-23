'use client';

import {
  CodeBlock as CodeBlockBase,
  Pre,
} from 'fumadocs-ui/components/codeblock';
import type { ComponentProps } from 'react';

export function CodeBlock(props: ComponentProps<'pre'>) {
  return (
    <CodeBlockBase
      {...props}
      className="relative bg-fd-background rounded-md shadow-none"
    >
      <Pre className="[&_.highlighted]:!bg-primary-blue/25 [&_.highlighted]:!border-primary-blue/50 [&_.highlighted::after]:!text-muted-foreground [.tab-content_&]:!m-0">
        {props.children}
      </Pre>
    </CodeBlockBase>
  );
}
