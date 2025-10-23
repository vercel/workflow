'use client';

import { track } from '@vercel/analytics';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Tab {
  id: string;
  smallLabel: string;
  label: string;
}

const tabs: Tab[] = [
  {
    id: 'with',
    smallLabel: 'With WDK',
    label: 'With Workflow DevKit',
  },
  {
    id: 'without',
    smallLabel: 'Without WDK',
    label: 'Without Workflow DevKit',
  },
];

export const IntroTabs = ({
  withWorkflow,
  withoutWorkflow,
}: {
  withWorkflow: ReactNode;
  withoutWorkflow: ReactNode;
}) => {
  const tabContent: Record<string, ReactNode> = {
    with: withWorkflow,
    without: withoutWorkflow,
  };

  return (
    <Tabs
      defaultValue={tabs[0].id}
      className="w-full gap-6"
      onValueChange={(value) => track('Intro tab changed', { tab: value })}
    >
      <TabsList className="w-fit bg-background mx-auto border p-1 rounded-full h-auto">
        {tabs.map((tab) => (
          <TabsTrigger
            className="flex-auto data-[state=active]:bg-secondary data-[state=active]:shadow-none rounded-full py-2.5 px-4 h-auto"
            value={tab.id}
            key={tab.id}
          >
            <span className="hidden md:block">{tab.label}</span>
            <span className="block md:hidden">{tab.smallLabel}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent
          value={tab.id}
          key={tab.id}
          className="[&_figure]:rounded-lg [&_figure]:shadow-none"
        >
          {tabContent[tab.id]}
        </TabsContent>
      ))}
    </Tabs>
  );
};
