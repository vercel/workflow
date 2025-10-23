import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import type { CSSProperties, ReactNode } from 'react';
import { source } from '@/lib/source';

type DocsRootLayoutProps = {
  children: ReactNode;
};

const DocsRootLayout = ({ children }: DocsRootLayoutProps) => (
  <DocsLayout
    containerProps={{
      style: {
        '--fd-sidebar-width': '0px',
      } as CSSProperties,
    }}
    links={[
      {
        text: 'Home',
        url: '/',
        active: 'url',
      },
      {
        text: 'Docs',
        url: process.env.NEXT_PUBLIC_SUBPATH
          ? `${process.env.NEXT_PUBLIC_SUBPATH}/docs`
          : '/docs',
        active: 'nested-url',
      },
    ]}
    nav={{
      mode: 'top',
    }}
    sidebar={{
      collapsible: false,
      hidden: true,
    }}
    tabMode="navbar"
    tree={source.pageTree}
  >
    <div className="mx-auto w-full max-w-[1080px]">{children}</div>
  </DocsLayout>
);

export default DocsRootLayout;
