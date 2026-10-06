import { createChangelogPage } from '@vercel/geistdocs/pages/changelog';
import { changelogOptions } from '@/lib/geistdocs/changelog';

const changelogPage = createChangelogPage(changelogOptions);

export const generateMetadata = changelogPage.generatePaginatedMetadata;
export const generateStaticParams = changelogPage.generatePageParams;
export default changelogPage.PaginatedPage;
