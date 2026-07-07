import {
  compareWorldsMetadata,
  VersionedCompareBenchmarksPage,
} from '@/app/[lang]/_worlds/pages';

export const metadata = compareWorldsMetadata;

const Page = () => <VersionedCompareBenchmarksPage version="v5" />;

export default Page;
