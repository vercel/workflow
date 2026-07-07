import { HomeLayout } from '@/components/geistdocs/home-layout';
import { PreReleaseBanner } from '@/components/geistdocs/pre-release-banner';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { PRE_RELEASE_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v5/worlds'>) => {
  const { lang } = await params;
  return (
    <div className="bg-background-100">
      <PreReleaseBanner pathname={`/${lang}/v5/worlds`} />
      <HomeLayout tree={getDocsTreeForVersion(lang, PRE_RELEASE_VERSION)}>
        <div className="pb-8 sm:pb-32">{children}</div>
      </HomeLayout>
    </div>
  );
};

export default Layout;
