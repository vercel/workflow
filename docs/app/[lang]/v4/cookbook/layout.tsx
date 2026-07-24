import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { MaintenanceBanner } from '@/components/geistdocs/maintenance-banner';
import { getCookbookTree } from '@/lib/geistdocs/cookbook-source';
import { MAINTENANCE_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v4/cookbook'>) => {
  const { lang } = await params;
  return (
    <div className="bg-background-100">
      <MaintenanceBanner pathname={`/${lang}/v4/cookbook`} />
      <DocsLayout
        currentVersion={MAINTENANCE_VERSION.id}
        lang={lang}
        tree={getCookbookTree(lang, MAINTENANCE_VERSION.prefix)}
      >
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
