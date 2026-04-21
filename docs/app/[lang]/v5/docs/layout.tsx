import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { PreReleaseBanner } from '@/components/geistdocs/pre-release-banner';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { PRE_RELEASE_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({ children, params }: LayoutProps<'/[lang]/v5/docs'>) => {
  const { lang } = await params;
  return (
    <div className="bg-background-100">
      <PreReleaseBanner pathname={`/${lang}/v5/docs`} />
      <DocsLayout tree={getDocsTreeForVersion(lang, PRE_RELEASE_VERSION)}>
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
