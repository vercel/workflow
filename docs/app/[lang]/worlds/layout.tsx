import { HomeLayout } from '@/components/geistdocs/home-layout';
import { source } from '@/lib/geistdocs/source';

const Layout = async ({ children, params }: LayoutProps<'/[lang]/worlds'>) => {
  const { lang } = await params;
  return (
    <HomeLayout tree={source.pageTree[lang]}>
      <div className="pb-8 sm:pb-32">{children}</div>
    </HomeLayout>
  );
};

export default Layout;
