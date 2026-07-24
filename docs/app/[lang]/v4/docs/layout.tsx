import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { MaintenanceBanner } from '@/components/geistdocs/maintenance-banner';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { MAINTENANCE_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({ children, params }: LayoutProps<'/[lang]/v4/docs'>) => {
  const { lang } = await params;
  return (
    <div className="bg-background-100">
      <MaintenanceBanner pathname={`/${lang}/v4/docs`} />
      <DocsLayout
        currentVersion={MAINTENANCE_VERSION.id}
        lang={lang}
        tree={getDocsTreeForVersion(lang, MAINTENANCE_VERSION)}
      >
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
