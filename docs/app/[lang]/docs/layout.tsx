import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({ children, params }: LayoutProps<'/[lang]/docs'>) => {
  const { lang } = await params;

  return (
    <div className="bg-background-100">
      <DocsLayout tree={getDocsTreeForVersion(lang, LATEST_VERSION)}>
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
