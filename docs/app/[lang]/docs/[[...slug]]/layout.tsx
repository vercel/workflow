import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';

// This layout lives inside `[[...slug]]` rather than next to it so that
// `params.slug` is available: the sidebar needs the active page to decide
// whether to drill into a section. See `DocsLayout`.
const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/docs/[[...slug]]'>) => {
  const { lang, slug } = await params;

  return (
    <div className="bg-background-100">
      <DocsLayout
        activeSlug={slug}
        currentVersion={LATEST_VERSION.id}
        lang={lang}
        tree={getDocsTreeForVersion(lang, LATEST_VERSION)}
      >
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
