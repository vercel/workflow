import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { PreReleaseBanner } from '@/components/geistdocs/pre-release-banner';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { PRE_RELEASE_VERSION } from '@/lib/geistdocs/versions';

// This layout lives inside `[[...slug]]` rather than next to it so that
// `params.slug` is available: the sidebar needs the active page to decide
// whether to drill into a section. See `DocsLayout`.
const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v5/docs/[[...slug]]'>) => {
  const { lang, slug } = await params;
  return (
    <div className="bg-background-200">
      <PreReleaseBanner pathname={`/${lang}/v5/docs`} />
      <DocsLayout
        activeSlug={slug}
        currentVersion={PRE_RELEASE_VERSION.id}
        lang={lang}
        tree={getDocsTreeForVersion(lang, PRE_RELEASE_VERSION)}
      >
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
