import { createChangelogPage } from '@vercel/geistdocs/pages/changelog';
import { changelogOptions } from '@/lib/geistdocs/changelog';

const changelogPage = createChangelogPage(changelogOptions);

export const generateMetadata = changelogPage.generateMetadata;
export const generateStaticParams = changelogPage.generateStaticParams;
export default changelogPage.Page;
