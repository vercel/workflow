import {
  generateWorldMetadata,
  generateWorldStaticParams,
  VersionedWorldDetailPage,
} from '@/app/[lang]/_worlds/pages';

export const generateStaticParams = generateWorldStaticParams;
export const generateMetadata = generateWorldMetadata;

const Page = (props: PageProps<'/[lang]/v5/worlds/[id]'>) => (
  <VersionedWorldDetailPage {...props} version="v5" />
);

export default Page;
