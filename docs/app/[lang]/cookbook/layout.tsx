import { DocsLayout } from '@/components/geistdocs/docs-layout';
import { getCookbookTree } from '@/lib/geistdocs/cookbook-source';

const Layout = async ({
  children,
  params,
}: LayoutProps<'/[lang]/cookbook'>) => {
  const { lang } = await params;

  return <DocsLayout tree={getCookbookTree(lang)}>{children}</DocsLayout>;
};

export default Layout;
