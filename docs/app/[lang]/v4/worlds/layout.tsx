import { HomeLayout } from '@/components/geistdocs/home-layout';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/v4/worlds'>) => {
  const { lang } = await params;
  return (
    <HomeLayout tree={getDocsTreeForVersion(lang, LATEST_VERSION)}>
      <div className="pb-8 sm:pb-32">{children}</div>
    </HomeLayout>
  );
};

export default Layout;
