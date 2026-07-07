import {
  compareWorldsMetadata,
  VersionedCompareBenchmarksPage,
} from '@/app/[lang]/_worlds/pages';

export const metadata = compareWorldsMetadata;

const Page = () => <VersionedCompareBenchmarksPage version="v4" />;

export default Page;
