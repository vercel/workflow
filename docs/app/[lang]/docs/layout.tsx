import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { getDocsTreeWithoutCookbook } from '@/lib/geistdocs/cookbook-source';

const Layout = async ({ children, params }: LayoutProps<'/[lang]/docs'>) => {
  const { lang } = await params;

  return (
    <DocsLayout tree={getDocsTreeWithoutCookbook(lang)}>
      {children}
    </DocsLayout>
  );
};

export default Layout;
