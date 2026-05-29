import { Skeleton } from '../../ui/skeleton';

const COL_TEMPLATE = '340px 1px minmax(50px, 1fr)';

const ROWS: { id: string; name: number; off: number; bar: number }[] = [
  { id: 'r0', name: 62, off: 0, bar: 72 },
  { id: 'r1', name: 78, off: 6, bar: 48 },
  { id: 'r2', name: 50, off: 10, bar: 55 },
  { id: 'r3', name: 84, off: 18, bar: 30 },
  { id: 'r4', name: 45, off: 18, bar: 42 },
  { id: 'r5', name: 66, off: 34, bar: 38 },
  { id: 'r6', name: 55, off: 41, bar: 25 },
  { id: 'r7', name: 40, off: 50, bar: 30 },
];

const HEADER_MARKERS = ['m0', 'm1', 'm2', 'm3'];

const HeaderDivider = () => (
  <div className="flex justify-center">
    <span aria-hidden className="h-full w-px bg-gray-alpha-400" />
  </div>
);

export function TraceViewerSkeleton() {
  return (
    <output
      aria-busy="true"
      aria-label="Loading trace"
      className="flex flex-col w-full h-full min-h-0 bg-background-100"
    >
      <span className="sr-only">Loading trace…</span>

      {/* Header row: search header | divider | timeline header */}
      <div
        className="shrink-0 grid"
        style={{ gridTemplateColumns: COL_TEMPLATE }}
      >
        <div className="h-10 min-h-10 flex items-center border-b border-gray-alpha-400 pl-4 pr-2 gap-1.5">
          <Skeleton className="w-3.5 h-3.5 shrink-0 rounded-sm" />
          <Skeleton className="h-3.5 w-40" />
        </div>
        <HeaderDivider />
        <div className="h-10 min-h-10 flex items-end border-b border-gray-alpha-400 px-4 pb-1 gap-2">
          <div className="relative flex-1 flex items-end justify-between">
            {HEADER_MARKERS.map((id) => (
              <Skeleton key={id} className="h-3.5 w-9" />
            ))}
          </div>
        </div>
      </div>

      {/* Content row: event list | gutter | timeline */}
      <div
        className="grid flex-1 min-h-0 overflow-hidden"
        style={{ gridTemplateColumns: COL_TEMPLATE }}
      >
        {/* Sidebar event rows */}
        <div className="block overflow-visible">
          <ul className="block divide-y divide-gray-alpha-400 border-b border-gray-alpha-400">
            {ROWS.map((row) => (
              <li key={row.id} className="h-10 flex items-center pl-4 pr-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Skeleton className="w-4 h-4 shrink-0 rounded-sm" />
                  <Skeleton
                    className="h-3.5"
                    style={{ width: `${row.name}%` }}
                  />
                </div>
                <Skeleton className="ml-2 h-3.5 w-10 shrink-0" />
              </li>
            ))}
          </ul>
        </div>

        {/* Gutter */}
        <span aria-hidden className="h-full w-px bg-gray-alpha-400" />

        {/* Timeline bars */}
        <div className="relative min-h-0">
          {ROWS.map((row) => (
            <div key={row.id} className="relative h-10">
              <div className="absolute inset-x-4 inset-y-0">
                <Skeleton
                  className="absolute top-1/2 -translate-y-1/2 h-6 rounded-[0.25rem]"
                  style={{ left: `${row.off}%`, width: `${row.bar}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </output>
  );
}
