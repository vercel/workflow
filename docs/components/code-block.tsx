import { codeToHtml } from 'shiki';
import { cn } from '@/lib/utils';

type CodeBlockProps = {
  code: string;
  lang: string;
  codeblock?: {
    className?: string;
  };
};

export const CodeBlock = async ({ code, lang, codeblock }: CodeBlockProps) => {
  const html = await codeToHtml(code, {
    lang,
    themes: {
      light: 'github-light-default',
      dark: 'github-dark-default',
    },
    defaultColor: false,
  });

  return (
    <div
      className={cn(
        'overflow-auto text-sm py-6 border [&_pre]:!bg-transparent',
        codeblock?.className
      )}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates safe HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
