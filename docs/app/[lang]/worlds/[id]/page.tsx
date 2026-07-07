import { redirect } from 'next/navigation';
import { i18n } from '@/lib/geistdocs/i18n';

const Page = async ({ params }: PageProps<'/[lang]/worlds/[id]'>) => {
  const { id, lang } = await params;
  const prefix = lang === i18n.defaultLanguage ? '' : `/${lang}`;
  redirect(`${prefix}/v4/worlds/${id}`);
};

export default Page;
