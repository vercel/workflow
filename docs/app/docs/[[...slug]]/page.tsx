import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage } from '@/components/layout/page';
import { Tab, Tabs } from '@/components/tabs';
import { source } from '@/lib/source';
import { cn } from '@/lib/utils';
import { getMDXComponents } from '@/mdx-components';

type CardProps = {
  title: string;
  href: string;
  className?: string;
  children: React.ReactNode;
  disabled?: boolean;
};

function Card({ title, href, className, children, disabled }: CardProps) {
  if (disabled) {
    return (
      <div
        className={cn(
          '[&_span]:text-muted-foreground cursor-default block rounded-lg border border-border p-6 transition-colors no-underline opacity-75 [&_svg]:grayscale [&_svg]:opacity-25',
          className
        )}
      >
        {title && <div className="font-semibold text-lg mb-1">{title}</div>}
        {title ? <div className="text-sm">{children}</div> : children}
      </div>
    );
  }

  return (
    <a
      href={href}
      className={cn(
        'block rounded-lg border border-border p-6 transition hover:border-primary/25 hover:bg-accent no-underline duration-200',
        className
      )}
    >
      {title && <div className="font-semibold text-lg mb-1">{title}</div>}
      {title ? (
        <div className="text-muted-foreground text-sm">{children}</div>
      ) : (
        children
      )}
    </a>
  );
}

type CardsProps = {
  children: React.ReactNode;
};

function Cards({ children }: CardsProps) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

export default async function Page(props: {
  params: Promise<{ slug: string[] }>;
}) {
  const { params } = props;
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDXContent = page.data.body;
  const icon = (page.data as any).icon || false;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
            Tab,
            Tabs,
            Card,
            Cards,
            icon: icon,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { params } = props;
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: `${page.data.title} - Workflow DevKit`,
    description: page.data.description,
    alternates: {
      canonical: `/docs/${slug.join('/')}`,
    },
  };
}
