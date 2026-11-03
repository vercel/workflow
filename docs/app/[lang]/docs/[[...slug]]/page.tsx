import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import {
  createDocsPage,
  resolvePageMarkdownUrl,
} from '@vercel/geistdocs/pages/docs';
import { permanentRedirect } from 'next/navigation';
import { PageLanguageSwitcher } from '@/components/custom/language-switcher';
import { AutoCards } from '@/components/geistdocs/auto-cards';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { rewriteCookbookUrl } from '@/lib/geistdocs/cookbook-source';
import { resolveSectionChildren } from '@/lib/geistdocs/section-children';
import { geistdocsSource } from '@/lib/geistdocs/source';
import { getDocsTreeForVersion } from '@/lib/geistdocs/version-source';
import { LATEST_VERSION } from '@/lib/geistdocs/versions';
import { LANGUAGE_QUERY_PARAM, resolveLanguage } from '@/lib/language';

const DEFAULT_LANG = config.defaultLanguage ?? 'en';

function createLanguageDocsPage(
  languageSwitcher?: string[],
  language?: string
) {
  return createDocsPage({
    config: {
      ...config,
      github: config.github && {
        ...config.github,
        editPath: 'docs/content/docs/v5/{path}',
      },
    },
    source: geistdocsSource,
    getMarkdownUrl: (context) => {
      const url = resolvePageMarkdownUrl({
        ...context,
        basePath: config.basePath,
      });
      return language
        ? `${url}?${new URLSearchParams({ [LANGUAGE_QUERY_PARAM]: language })}`
        : url;
    },
    mdx: ({ link, page }) =>
      getMDXComponents({
        a: link,
        // Section landing pages render their child cards from the page tree
        // (same tree that drives the sidebar), so the grid can never drift from
        // the navigation. See `resolveSectionChildren`.
        AutoCards: () => (
          <AutoCards
            items={resolveSectionChildren(
              getDocsTreeForVersion(DEFAULT_LANG, LATEST_VERSION),
              page.url
            )}
          />
        ),
      }),
    openGraph: {
      images: true,
    },
    tableOfContentPopover: {
      enabled: false,
    },
    tableOfContent: languageSwitcher
      ? { header: <PageLanguageSwitcher languages={languageSwitcher} /> }
      : undefined,
    renderTop: ({ data }) => (
      <>
        <MobileDocsBar toc={data.toc} />
        {languageSwitcher ? (
          <PageLanguageSwitcher
            className="max-w-56 xl:hidden"
            languages={languageSwitcher}
          />
        ) : null}
      </>
    ),
    metadata: ({ metadata, page }) => ({
      ...metadata,
      alternates: {
        ...metadata.alternates,
        canonical: page.url,
        types: {
          ...metadata.alternates?.types,
          'text/markdown': page.url === '/docs' ? '/docs.md' : `${page.url}.md`,
        },
      },
    }),
  });
}
const docsPage = createLanguageDocsPage();

const Page = async (props: PageProps<'/[lang]/docs/[[...slug]]'>) => {
  const { slug, lang } = await props.params;

  // Cookbook recipes moved out of `/docs/cookbook/...` into their own
  // `/cookbook/...` URL space; permanently redirect legacy deep links.
  if (Array.isArray(slug) && slug[0] === 'cookbook') {
    const rest = slug.slice(1).join('/');
    const legacyPath = `/docs/cookbook${rest ? `/${rest}` : ''}`;
    permanentRedirect(`/${lang}${rewriteCookbookUrl(legacyPath)}`);
  }

  const page = geistdocsSource.source.getPage(slug, lang);
  const languages = (page?.data as { languageSwitcher?: string[] } | undefined)
    ?.languageSwitcher;
  const searchParams = languages ? await props.searchParams : {};
  const requestedLanguage = searchParams[LANGUAGE_QUERY_PARAM];
  const language = languages
    ? resolveLanguage(
        languages,
        Array.isArray(requestedLanguage)
          ? requestedLanguage[0]
          : requestedLanguage
      )
    : undefined;
  return createLanguageDocsPage(languages, language).Page(props);
};

export default Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
