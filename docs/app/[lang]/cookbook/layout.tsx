import { DocsLayout } from "@/components/geistdocs/docs-layout";
import { getCookbookTree } from "@/lib/geistdocs/cookbook-source";

const Layout = async ({
  children,
  params,
}: LayoutProps<"/[lang]/cookbook">) => {
  const { lang } = await params;

  return (
    <div className="bg-background-100">
      <DocsLayout tree={getCookbookTree(lang)}>{children}</DocsLayout>
    </div>
  );
};

export default Layout;
