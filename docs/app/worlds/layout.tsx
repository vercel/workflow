import { HomeLayout } from '@/components/geistdocs/home-layout';

const Layout = ({ children }: LayoutProps<'/worlds'>) => (
  <HomeLayout>
    <div className="pb-8 sm:pb-32">{children}</div>
  </HomeLayout>
);

export default Layout;
