'use client';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
        <div
          className="text-foreground text-[22px]"
          title="Right click for design assets"
          onContextMenu={(e) => {
            e.preventDefault();
            const link = document.createElement('a');
            link.href = '/workflow-assets.zip';
            link.download = 'workflow-assets.zip';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }}
        >
          <span className="text-foreground font-semibold tracking-tight flex items-center gap-1.5">
            <svg
              className="hidden sm:block"
              fill="none"
              height={18}
              viewBox="0 0 305 234"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>Workflow DevKit Logo</title>
              <g fill="currentColor">
                <path d="m125.776 0c-4.847.00001649-8.776 3.9291-8.776 8.77539v52.64941c0 4.8463 3.929 8.7754 8.776 8.7754h35.099l.378.0049c7.779.1972 14.048 6.4683 14.242 14.248l.005.3721v58.4998c0 4.846 3.929 8.776 8.776 8.776h35.099l.378.004c7.777.198 14.045 6.466 14.242 14.243l.005.378v58.499c0 4.846 3.929 8.775 8.776 8.775h52.649c4.846 0 8.775-3.929 8.775-8.775v-52.65c0-4.846-3.929-8.775-8.775-8.775h-35.175c-7.916-.04-14.345-6.37-14.545-14.247l-.005-.377v-58.5002c0-4.8463-3.929-8.7754-8.775-8.7754h-35.1c-7.951 0-14.42-6.3453-14.62-14.2481l-.005-.3769v-58.50001c0-4.84629-3.929-8.7753735-8.775-8.77539z" />
                <path d="m67.2755 81.9004c-4.8462 0-8.7753 3.9291-8.7753 8.7754v52.6492c.0002 4.846 3.9292 8.776 8.7753 8.776h35.0995l.378.004c7.777.198 14.045 6.466 14.242 14.243l.005.378v58.499c0 4.846 3.929 8.775 8.776 8.775h52.649c4.846 0 8.775-3.929 8.775-8.775v-52.65c0-4.846-3.929-8.775-8.775-8.775h-35.175c-7.916-.04-14.345-6.37-14.545-14.247l-.005-.377v-58.5002c0-4.8463-3.929-8.7754-8.775-8.7754z" />
                <path d="m8.77454 163.8c-4.8461 0-8.77441793 3.929-8.77441793 8.775v52.65c0 4.846 3.92831793 8.775 8.77441793 8.775h52.65036c4.8463 0 8.7754-3.929 8.7754-8.775v-52.65c0-4.846-3.9291-8.775-8.7754-8.775z" />
              </g>
            </svg>
            Workflow
          </span>
        </div>
      ),
    },
    // see https://fumadocs.dev/docs/ui/navigation/links
    links: [],
  };
}
