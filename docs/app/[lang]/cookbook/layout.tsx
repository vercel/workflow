import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { getCookbookTree } from '@/lib/geistdocs/cookbook-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/cookbook'>) => {
  const { lang } = await params;

  return (
    <div className="bg-background-100">
      <DocsLayout
        currentVersion={LATEST_VERSION.id}
        tree={getCookbookTree(lang)}
      >
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
