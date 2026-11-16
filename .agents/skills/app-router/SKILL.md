---
name: app-router
description: Guidelines and best practices for Next.js App Router code in this repository — the docs site (`docs/`) and the Next.js workbenches (`workbench/nextjs-*`). Not for `packages/web`, which is a React Router app.
---

# Next.js App Router

Applies to the Next.js apps in this repository: the docs site in `docs/` and the workbenches in `workbench/nextjs-turbopack` and `workbench/nextjs-webpack`. `packages/web` (the observability UI) is built with React Router and Vite, so none of this applies there.

Before writing Next.js code, read the relevant guide in `node_modules/next/dist/docs/` for the installed version (resolve it from the app's directory; in this monorepo `next` may not be visible from the repo root). Those docs win over this file and over model memory when they disagree.

## PageProps and LayoutProps

Next.js 16 generates types for pages and layouts that should be used in the code for better typing. These should be used in `page.tsx` and `layout.tsx` files for types.

Example:

```tsx
// docs/app/[lang]/docs/[[...slug]]/page.tsx
const Page = async (props: PageProps<'/[lang]/docs/[[...slug]]'>) => {
  const { slug, lang } = await props.params;
  // ...
};
```

## Recommended directory structure

If a directory already has an existing directory structure, follow that. If not, follow these guidelines:

- Colocate code specific to a feature under that directory.
- Put shared components under `/_components/`
- Put server actions in `/_actions`
- Put server side data fetching code in `/_data/`

Generally code that doesn't require any user input should be server components. The `use client` boundary should be pushed down the component tree to just the components that need client input.

## Suspense + Dynamic I/O

Any use of dynamic I/O, including `await` and `useSearchParams` should be wrapped in a `Suspense` boundary.

A common way to do this is to export a wrapper component that contains the component and the inner component contains the Dynamic I/O. For example:

```
async function DynamicMyComponent(props) {
    const data = await getData();
    return <div>...</div>;
}

export async function MyComponent(props) {
    return (
        <Suspense fallback={<MyComponentSkeleton />}>
          <DynamicMyComponent ...props />
        </Suspense>
    )
}
```

This should usually not happen in `page.tsx` or `layout.tsx` files since they will cause the entire page to be in loading state until the promise is resolved, but if it is necessary then the directory can use a `loading.tsx` to show a loading state.

## Deferred promises

Promises, such as data fetch calls, should be pushed down to the lowest component that needs that data. If the data needs to be shared or kicked off early for performance, it can be started in the root `page.tsx` file but `await` should not be called on the promise there and the Promise should be passed down to child components until it is needed. This is important for performance as blocking on async code will delay the rendering of the component and all child components.

PREFERRED:

```
export default async function MyPage({
  params,
  searchParams,
}: PageProps<'/[lang]/my-page'>) {
  const dataPromise = getData(params); // Do not block on this async data fetch
  return (
    <div>
      <ChildComponent data={dataPromise} paramsPromise={params} searchParamsPromise={searchParams} />
    </div>
  );
}
```

Reason: Only awaiting `dataPromise`, `params` and `searchParams` in child component moves the blocking `await` to the exact component that needs it. A `Suspense` boundary in that component can provide a useful skeleton.

INCORRECT:

```tsx
export default async function MyPage({
  params,
  searchParams,
}: PageProps<'/[lang]/my-page'>) {
  const resolvedParams = await params;
  return <>...</>;
}
```

Reason: the `await params` in `page.tsx` will block page rendering until the promise is resolved.

## Forms

Search and filter forms can update URL search parameters and rerender Server Components.

For GET forms that put their values in URL search parameters, use `next/form`
with a string `action` when the browser does not need `method`, `encType`,
`target`, or external navigation. For those browser requirements, use native
`<form>`. See the [Next.js Form reference](https://nextjs.org/docs/app/api-reference/components/form).

For mutation forms, prefer a native `<form action>` bound to a Server Action.

For URL-driven forms, client components should update their inputs when the URL search parameters change.

A Suspense may need a `key` with the serialized search params to trigger it going back into the loading state when the URL updates from a form action.

Example: search box re-renders the current page with updated results.

```tsx filename="page.tsx"
export function MyPage() {
  return (
    <Form action="" id="search-form" scroll={false}>
      <SearchBox />
    </Form>
  );
}
```

With `action=""`, the form navigates to the current route with updated search parameters.

To update the URL as the user types, the search input can call `event.currentTarget?.form.requestSubmit()`.

## Server Actions

For native action forms, read the [Next.js forms guide](https://nextjs.org/docs/app/guides/forms) for `<form action>` and `useActionState`.

Server Actions are directly callable. Validate submitted values, including hidden fields, and enforce the action's authentication and authorization requirements.

## Cache tags and revalidateTag

When making data fetch requests or `use cache`, specify cache tags so that the cache can be invalidated later. The cache tags should be specific so data isn't over invalidated, but it's critical that data is invalidated when mutated to prevent stale data from being shown.

Examples:

```ts
async function getData() {
  const res = fetch(url, {
    next: {
      tags: [`changelog:${version}`],
    },
  });
}
```

```ts
'use server';

export async function mutateData() {
  revalidateTag(`changelog:${version}`);
}
```

## Redirects and notFound

Using `notFound()` and `redirect()` in Next.js throws an exception. If it is wrapped in a try/catch block, it won't work correctly. When using `redirect` or `notFound`, make sure they are not in a try/catch block.

## References

- https://nextjs.org/docs/app/getting-started/fetching-data
- https://www.robinwieruch.de/next-server-actions-fetch-data/
- https://www.robinwieruch.de/next-search-params/
