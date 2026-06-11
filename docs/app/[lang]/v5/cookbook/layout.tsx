import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { PreReleaseBanner } from '@/components/geistdocs/pre-release-banner';
import { getCookbookTree } from '@/lib/geistdocs/cookbook-source';
import { PRE_RELEASE_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v5/cookbook'>) => {
  const { lang } = await params;
  return (
    <div className="bg-background-100">
      <PreReleaseBanner pathname={`/${lang}/v5/cookbook`} />
      <DocsLayout tree={getCookbookTree(lang, PRE_RELEASE_VERSION.prefix)}>
        {children}
      </DocsLayout>
    </div>
  );
};

export default Layout;
