'use client';

import {
  CommandPromptContent,
  CommandPromptCopy,
  CommandPromptList,
  CommandPromptPrefix,
  CommandPromptRoot,
  CommandPromptSurface,
  CommandPromptTrigger,
  CommandPromptTriggerDivider,
  CommandPromptViewport,
} from '@/components/ui/command-prompt';

const COMMAND_FOR_HUMANS = 'npm install workflow';
const COMMAND_FOR_AGENTS = 'npx skills add vercel/workflow@workflow-init';

type HeroProps = {
  title: string;
  description: string;
};

export const Hero = ({ title, description }: HeroProps) => {
  return (
    <section className="mt-[var(--fd-nav-height)] space-y-6 px-4 pt-24 sm:pt-32 pb-32 text-center">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <h1 className="text-center font-semibold text-4xl leading-[1.1] tracking-tight lg:font-semibold sm:text-5xl! xl:text-6xl! text-balance">
          {title}
        </h1>
        <p className="text-balance max-w-3xl mx-auto text-muted-foreground sm:text-xl leading-relaxed">
          <span className="font-mono text-base bg-accent inline-block px-2 py-0 rounded-sm border border-border">
            use workflow
          </span>{' '}
          brings durability, reliability, and observability to async JavaScript.
          Build apps and AI Agents that can suspend, resume, and maintain state
          with ease.
        </p>
      </div>
      <CommandPromptRoot defaultValue="humans">
        <CommandPromptList>
          <CommandPromptTrigger value="humans" className="min-w-[90px]">
            For humans
          </CommandPromptTrigger>
          <CommandPromptTriggerDivider />
          <CommandPromptTrigger value="agents" className="min-w-[84px]">
            For agents
          </CommandPromptTrigger>
        </CommandPromptList>
        <CommandPromptSurface>
          <CommandPromptPrefix>$</CommandPromptPrefix>
          <CommandPromptViewport>
            <CommandPromptContent value="humans" copyValue={COMMAND_FOR_HUMANS}>
              {COMMAND_FOR_HUMANS}
            </CommandPromptContent>
            <CommandPromptContent value="agents" copyValue={COMMAND_FOR_AGENTS}>
              {COMMAND_FOR_AGENTS}
            </CommandPromptContent>
          </CommandPromptViewport>
          <CommandPromptCopy />
        </CommandPromptSurface>
      </CommandPromptRoot>
    </section>
  );
};
