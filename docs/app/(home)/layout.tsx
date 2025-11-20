import { HomeLayout } from '@/components/geistdocs/home-layout';

const Layout = ({ children }: LayoutProps<'/'>) => (
  <HomeLayout>
    <div className="bg-sidebar pb-8 sm:pb-32">{children}</div>
  </HomeLayout>
);

export default Layout;
