import {
  CopyButton,
  type CopyButtonProps,
  cn,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';

interface CopyableTextProps {
  text: CopyButtonProps['textToCopy'];
  children: React.ReactNode;
  className?: string;
  /** If true, the copy button overlaps the text on the right */
  overlay?: boolean;
  label?: string;
}

export function CopyableText({
  text,
  children,
  className,
  overlay,
  label = 'Copy to clipboard',
}: CopyableTextProps) {
  const Wrapper = overlay ? 'span' : 'div';
  return (
    <Wrapper
      className={cn(
        'group/copy',
        overlay ? 'relative inline-block' : 'flex items-center gap-1',
        className
      )}
    >
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <CopyButton
            textToCopy={text}
            aria-label={label}
            className={cn(
              'opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 [&_svg]:size-3',
              overlay
                ? 'absolute right-0 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur-sm'
                : '-my-1'
            )}
          />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </Wrapper>
  );
}
