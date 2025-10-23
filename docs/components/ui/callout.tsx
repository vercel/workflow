import { cn } from 'fumadocs-ui/utils/cn';
import { AlertTriangle, FlaskConical, Info, X } from 'lucide-react';

type CalloutProps = {
  type?: 'info' | 'warn' | 'error' | 'wip';
  children: React.ReactNode;
};

export function Callout({ children, type = 'info' }: CalloutProps) {
  return (
    <div
      className={cn(
        'bg-fd-error/25 text-fd-error border border-fd-error/20',
        type === 'wip' && 'bg-primary/5 border-primary/25 text-primary',
        type === 'info' &&
          'bg-primary-blue/10 text-blue-900 border border-primary-blue/25',
        type === 'warn' &&
          'bg-amber-600/15 text-amber-600 border border-amber-600/30',
        'rounded-md px-4 py-2 [&_p]:m-0 [&_p]:text-current flex items-start gap-2'
      )}
    >
      <div className="flex items-center justify-center size-4 mt-1.5 shrink-0">
        {type === 'info' ? (
          <Info />
        ) : type === 'warn' ? (
          <AlertTriangle />
        ) : type === 'wip' ? (
          <FlaskConical />
        ) : (
          <X />
        )}
      </div>
      <div className="flex-1 text-[15px] [&_a]:underline [&_a]:decoration-primary-blue/50">
        {children}
      </div>
    </div>
  );
}
