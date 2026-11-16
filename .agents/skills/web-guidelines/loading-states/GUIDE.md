# Loading States

## When to Use

Use when implementing loading UI, skeletons, list fallbacks, or any region whose data arrives after first render in `packages/web` or `packages/web-shared`.

## Required Patterns

### Skeletons

A region's loading state must not cause Cumulative Layout Shift (CLS) when it swaps for the settled content. Use the `Skeleton` primitive (`packages/web/app/components/ui/skeleton.tsx` or `packages/web-shared/src/components/ui/skeleton.tsx`) for the atoms of the region: dynamic text, buttons, badges, and icons. Compose those atoms into molecules that match the settled layout: the same grid, row height, padding, and column widths.

Reuse the existing skeletons before writing a new one: `TableSkeleton` (`packages/web/app/components/display-utils/table-skeleton.tsx`), `TraceViewerSkeleton`, and `StreamViewerSkeleton` (both exported from `packages/web-shared`). When the settled layout changes, update its skeleton in the same change.

When the content is a list of unknown length, render as many skeleton rows as the page size being requested. `TableSkeleton` defaults to `DEFAULT_PAGE_SIZE` for this reason.

When edge cases make the skeleton mismatch, design it around the common case so it is correct at p99.

### No Blank First Paint

Every region that waits for data renders its skeleton from the first paint. Never render nothing, a bare spinner, or a `Loading…` string in place of a region whose shape is known.

Spinners are for in-place actions on content that is already shown, such as a button that is submitting.

### Revalidation

Once content has rendered, a background refresh, poll, or live update must not put the region back into its skeleton. Keep showing the previous data until the new data arrives.

### Components in `packages/web-shared`

Components in `packages/web-shared` also render inside the Vercel dashboard, which loads data with React Suspense. Keep data fetching out of them: take data as props and export a matching skeleton, so each host can render the fallback in its own loading boundary.

## Rationale

Skeletons reserve the geometry of the settled content so loading does not shift the page. Matching row counts to the page size keeps the common case exact. Keeping fetching out of `packages/web-shared` lets the standalone app and the dashboard each own their loading boundaries.
