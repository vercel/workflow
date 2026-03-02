# @workflow/web-shared

Workflow Observability UI primitives. See [Workflow DevKit](https://useworkflow.dev/docs/observability) for more information.

## Usage

This package contains:
- pre-styled, prop-driven UI components (no data fetching)

If you want a full observability experience with server actions already wired, take a look at
[`@workflow/web`](../web/README.md) instead.

It comes with pre-styled UI components that accept data + callbacks:

```tsx
import { WorkflowTraceViewer } from '@workflow/web-shared';

export default function MyRunDetailView({
  run,
  steps,
  hooks,
  events,
  onSpanSelect,
}) {
  return (
    <WorkflowTraceViewer
      run={run}
      steps={steps}
      hooks={hooks}
      events={events}
      onSpanSelect={onSpanSelect}
    />
  );
}
```

Server actions and data fetching are intentionally **not** part of `web-shared`. Implement those in your app
and pass data + callbacks into these components. If you need world run helpers, use `@workflow/core/runtime`.

## Styling

In order for tailwind classes to be picked up correctly, you might need to configure your NextJS app
to use the correct CSS processor. E.g. if you're using PostCSS with TailwindCSS, you can do the following:

```tsx
// postcss.config.mjs in your NextJS app
const config = {
  plugins: ['@tailwindcss/postcss'],
};

export default config;
```
