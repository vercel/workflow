import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { MaintenanceBanner } from '@/components/geistdocs/maintenance-banner';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { MAINTENANCE_VERSION } from '@/lib/geistdocs/versions';

// This layout lives inside `[[...slug]]` rather than next to it so that
// `params.slug` is available: the sidebar needs the active page to decide
// whether to drill into a section. See `DocsLayout`.
const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v4/docs/[[...slug]]'>) => {
  const { lang, slug } = await params;
  return (
    <div className="bg-background-100">
      <MaintenanceBanner pathname={`/${lang}/v4/docs`} />
      <DocsLayout
        activeSlug={slug}
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
