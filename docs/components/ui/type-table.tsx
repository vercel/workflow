'use client';

import { TypeTable as TypeTableBase } from 'fumadocs-ui/components/type-table';
import type { ComponentProps } from 'react';

export function TypeTable(props: ComponentProps<typeof TypeTableBase>) {
  return (
    <div className="[&_div]:rounded-sm [&_div]:bg-transparent [&_button]:rounded-sm [&_button]:transition-colors [&_button]:ease-out [&_code]:text-foreground [&_span]:!text-muted-foreground">
      <TypeTableBase {...props} />
    </div>
  );
}
