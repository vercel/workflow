import { Skeleton } from '../../ui/skeleton';

const ROWS = [
  {
    id: 'r0',
    nameClassName: 'w-[62%]',
    offsetClassName: 'left-0',
    barClassName: 'w-[72%]',
    topClassName: 'top-0',
  },
  {
    id: 'r1',
    nameClassName: 'w-[78%]',
    offsetClassName: 'left-[6%]',
    barClassName: 'w-[48%]',
    topClassName: 'top-[3.5px]',
  },
  {
    id: 'r2',
    nameClassName: 'w-1/2',
    offsetClassName: 'left-[10%]',
    barClassName: 'w-[55%]',
    topClassName: 'top-[7px]',
  },
  {
    id: 'r3',
    nameClassName: 'w-[84%]',
    offsetClassName: 'left-[18%]',
    barClassName: 'w-[30%]',
    topClassName: 'top-[10.5px]',
  },
  {
    id: 'r4',
    nameClassName: 'w-[45%]',
    offsetClassName: 'left-[18%]',
    barClassName: 'w-[42%]',
    topClassName: 'top-[14px]',
  },
  {
    id: 'r5',
    nameClassName: 'w-[66%]',
    offsetClassName: 'left-[34%]',
    barClassName: 'w-[38%]',
    topClassName: 'top-[17.5px]',
  },
  {
    id: 'r6',
    nameClassName: 'w-[55%]',
    offsetClassName: 'left-[41%]',
    barClassName: 'w-1/4',
    topClassName: 'top-[21px]',
  },
  {
    id: 'r7',
    nameClassName: 'w-2/5',
    offsetClassName: 'left-1/2',
    barClassName: 'w-[30%]',
    topClassName: 'top-[24.5px]',
  },
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

      {/* Minimap strip: thin density lines tracing the same shape as the bars */}
      <div className="relative h-10 min-h-10 shrink-0 border-b border-gray-alpha-400">
        <div className="absolute inset-x-4 top-[6px]">
          {ROWS.map((row) => (
            <Skeleton
              key={row.id}
              className={`absolute h-[3px] rounded-full ${row.offsetClassName} ${row.barClassName} ${row.topClassName}`}
            />
          ))}
        </div>
      </div>

      {/* Header row: search header | divider | timeline header */}
      <div className="grid shrink-0 grid-cols-[340px_1px_minmax(50px,1fr)]">
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
      <div className="grid min-h-0 flex-1 grid-cols-[340px_1px_minmax(50px,1fr)] overflow-hidden">
        {/* Sidebar event rows */}
        <div className="block overflow-visible">
          <ul className="block divide-y divide-gray-alpha-400 border-b border-gray-alpha-400">
            {ROWS.map((row) => (
              <li key={row.id} className="h-10 flex items-center pl-4 pr-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Skeleton className="w-4 h-4 shrink-0 rounded-sm" />
                  <Skeleton className={`h-3.5 ${row.nameClassName}`} />
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
                  className={`absolute top-1/2 h-6 -translate-y-1/2 rounded-[0.25rem] ${row.offsetClassName} ${row.barClassName}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </output>
  );
}
